// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {AccrueRouter} from "../src/AccrueRouter.sol";
import {IAavePool} from "../src/interfaces/IAavePool.sol";
import {PermitSigner, USDT0, USDC, A_USDT0, A_USDC} from "./utils/PermitSigner.sol";
import {POLYGON_POOL} from "../script/Polygon.sol";

/// @notice Drives the router the way the relayer and an adversary can: relayed supplies and withdrawals for three
/// owners, permits submitted straight to the token by a front-runner, withdrawals pushed by a stranger without a
/// signature, permits signed with another owner's key, and time passing so interest accrues. Anything the router
/// must never do is recorded in `violation` instead of reverting, so the invariants report it.
contract RouterHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant OWNERS = 3;
    uint256 internal constant FUNDED = 1_000e6;
    uint256 internal constant RAY = 1e27;

    AccrueRouter internal immutable router;
    address public immutable relayer;
    address public immutable stranger;

    address[OWNERS] public owners;
    uint256[OWNERS] internal keys;
    address[2] public assets = [USDT0, USDC];
    address[2] public aTokens = [A_USDT0, A_USDC];

    /// Lowest value (wallet underlying + aTokens) an owner may hold of an asset. Before every action it is raised
    /// to the current value, then lowered for the acting owner by Aave's rounding on the router calls the action
    /// makes; nothing else may take an owner below it.
    mapping(address owner => mapping(address asset => uint256)) public floorOf;
    /// First thing the router did that it must never do; empty while none.
    string public violation;

    constructor(AccrueRouter router_) {
        router = router_;
        relayer = makeAddr("accrue.inv.relayer");
        stranger = makeAddr("accrue.inv.stranger");
        for (uint256 i; i < OWNERS; i++) {
            (owners[i], keys[i]) = makeAddrAndKey(string.concat("accrue.inv.owner.", vm.toString(i)));
            require(owners[i].code.length == 0, "owner is not a plain EOA at the fork block");
            for (uint256 j; j < 2; j++) {
                // An aToken contract custodies its reserve's underlying, so it is a deep holder at any block.
                vm.prank(aTokens[j]);
                require(IERC20(assets[j]).transfer(owners[i], FUNDED), "funding failed");
                floorOf[owners[i]][assets[j]] = valueOf(owners[i], j);
            }
        }
    }

    function supply(uint256 ownerSeed, uint256 assetSeed, uint256 amount) external {
        (address owner, uint256 key) = _owner(ownerSeed);
        uint256 j = assetSeed % 2;
        uint256 balance = IERC20(assets[j]).balanceOf(owner);
        if (balance < _minSupply(j)) return;
        amount = bound(amount, _minSupply(j), balance);
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(key, owner, assets[j], amount);

        _setFloors(owner, j, 1);
        vm.prank(relayer);
        try router.supplyWithPermit(assets[j], owner, amount, deadline, v, r, s) {}
        catch (bytes memory reason) {
            _flag("relayed supply reverted", reason);
        }
    }

    function withdraw(uint256 ownerSeed, uint256 assetSeed, uint256 amount, uint256 permitValue, bool all) external {
        (address owner, uint256 key) = _owner(ownerSeed);
        uint256 j = assetSeed % 2;
        uint256 balance = IERC20(aTokens[j]).balanceOf(owner);
        if (balance == 0) return;
        // Withdraw-all signs a buffer above the balance, as the app does; a partial may sign more than it pulls.
        amount = all ? type(uint256).max : bound(amount, 1, balance);
        permitValue = all ? _withBuffer(balance) : bound(permitValue, amount, _withBuffer(balance));
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(key, owner, aTokens[j], permitValue);

        _setFloors(owner, j, 1);
        _withdraw(relayer, "withdraw", j, owner, amount, permitValue, deadline, v, r, s, true);
    }

    function frontRunSupply(uint256 ownerSeed, uint256 assetSeed, uint256 amount) external {
        (address owner, uint256 key) = _owner(ownerSeed);
        uint256 j = assetSeed % 2;
        uint256 balance = IERC20(assets[j]).balanceOf(owner);
        if (balance < _minSupply(j)) return;
        amount = bound(amount, _minSupply(j), balance);
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(key, owner, assets[j], amount);

        _setFloors(owner, j, 1);
        vm.prank(stranger);
        try IERC20Permit(assets[j]).permit(owner, address(router), amount, deadline, v, r, s) {}
        catch (bytes memory reason) {
            _flag("direct underlying permit reverted", reason);
        }
        vm.prank(relayer);
        try router.supplyWithPermit(assets[j], owner, amount, deadline, v, r, s) {}
        catch (bytes memory reason) {
            _flag("supply after a front-run permit reverted", reason);
        }
    }

    /// A front-runner lands the owner's withdraw-all permit itself, then withdraws a sliver of it before the relayer.
    function frontRunWithdraw(uint256 ownerSeed, uint256 assetSeed, uint256 sliver) external {
        (address owner, uint256 key) = _owner(ownerSeed);
        uint256 j = assetSeed % 2;
        uint256 balance = IERC20(aTokens[j]).balanceOf(owner);
        if (balance == 0) return;
        uint256 permitValue = _withBuffer(balance);
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(key, owner, aTokens[j], permitValue);

        _setFloors(owner, j, 2);
        vm.prank(stranger);
        try IERC20Permit(aTokens[j]).permit(owner, address(router), permitValue, deadline, v, r, s) {}
        catch (bytes memory reason) {
            _flag("direct aToken permit reverted", reason);
        }
        uint256 cut = bound(sliver, 1, balance);
        _withdraw(stranger, "frontRunWithdraw", j, owner, cut, permitValue, deadline, v, r, s, true);
        bool rest = IERC20(aTokens[j]).balanceOf(owner) > 0;
        _withdraw(relayer, "frontRunWithdraw", j, owner, type(uint256).max, permitValue, deadline, v, r, s, rest);
    }

    /// Anyone may spend a leftover aToken allowance, but only by sending the owner their own underlying.
    function pushLeftover(uint256 ownerSeed, uint256 assetSeed) external {
        (address owner,) = _owner(ownerSeed);
        uint256 j = assetSeed % 2;
        bool spendable =
            IERC20(aTokens[j]).allowance(owner, address(router)) > 0 && IERC20(aTokens[j]).balanceOf(owner) > 0;

        _setFloors(owner, j, 1);
        _withdraw(stranger, "pushLeftover", j, owner, type(uint256).max, 0, 0, 0, bytes32(0), bytes32(0), spendable);
    }

    function crossSignedSupply(uint256 signerSeed, uint256 victimSeed, uint256 assetSeed, uint256 amount) external {
        (address signer, uint256 key) = _owner(signerSeed);
        (address victim,) = _owner(victimSeed);
        uint256 j = assetSeed % 2;
        uint256 balance = IERC20(assets[j]).balanceOf(victim);
        if (signer == victim || balance < _minSupply(j)) return;
        amount = bound(amount, _minSupply(j), balance);
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(key, victim, assets[j], amount);

        _setFloors(victim, j, 0);
        vm.prank(relayer);
        try router.supplyWithPermit(assets[j], victim, amount, deadline, v, r, s) {
            _flag("supply with another owner's signature landed", "");
        } catch (bytes memory reason) {
            if (bytes4(reason) != AccrueRouter.InsufficientAllowance.selector) {
                _flag("cross-signed supply reverted for the wrong reason", reason);
            }
        }
    }

    function crossSignedWithdraw(uint256 signerSeed, uint256 victimSeed, uint256 assetSeed) external {
        (address signer, uint256 key) = _owner(signerSeed);
        (address victim,) = _owner(victimSeed);
        uint256 j = assetSeed % 2;
        uint256 balance = IERC20(aTokens[j]).balanceOf(victim);
        if (signer == victim || balance == 0) return;
        uint256 permitValue = _withBuffer(balance);
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(key, victim, aTokens[j], permitValue);
        // The forged permit must not count; only a leftover allowance the victim really gave can be spent.
        bool spendable = IERC20(aTokens[j]).allowance(victim, address(router)) > 0;

        _setFloors(victim, j, 1);
        _withdraw(
            relayer, "crossSignedWithdraw", j, victim, type(uint256).max, permitValue, deadline, v, r, s, spendable
        );
    }

    function passTime(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 minutes, 30 days));
        vm.roll(block.number + 1);
    }

    function valueOf(address owner, uint256 j) public view returns (uint256) {
        return IERC20(assets[j]).balanceOf(owner) + IERC20(aTokens[j]).balanceOf(owner);
    }

    function _withdraw(
        address caller,
        string memory action,
        uint256 j,
        address owner,
        uint256 amount,
        uint256 permitValue,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bool shouldLand
    ) internal {
        vm.prank(caller);
        try router.withdrawWithPermit(assets[j], owner, amount, permitValue, deadline, v, r, s) {
            if (!shouldLand) _flag(string.concat(action, ": withdraw landed without a usable allowance"), "");
        } catch (bytes memory reason) {
            if (shouldLand || bytes4(reason) != AccrueRouter.NothingToWithdraw.selector) {
                _flag(string.concat(action, ": withdraw reverted"), reason);
            }
        }
    }

    function _setFloors(address actor, uint256 j, uint256 routerCalls) internal {
        for (uint256 i; i < OWNERS; i++) {
            for (uint256 k; k < 2; k++) {
                floorOf[owners[i]][assets[k]] = valueOf(owners[i], k);
            }
        }
        // Aave rounds scaled amounts by up to one unit and converts back at the index: at most index/RAY + 2 per call.
        uint256 slack = routerCalls * (IAavePool(POLYGON_POOL).getReserveNormalizedIncome(assets[j]) / RAY + 2);
        uint256 current = floorOf[actor][assets[j]];
        floorOf[actor][assets[j]] = current > slack ? current - slack : 0;
    }

    function _flag(string memory what, bytes memory reason) internal {
        if (bytes(violation).length == 0) violation = string.concat(what, " ", vm.toString(reason));
    }

    function _owner(uint256 seed) internal view returns (address, uint256) {
        uint256 i = seed % OWNERS;
        return (owners[i], keys[i]);
    }

    function _sign(uint256 key, address owner, address token, uint256 value)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s, uint256 deadline)
    {
        deadline = block.timestamp + 1 hours;
        uint256 nonce = IERC20Permit(token).nonces(owner);
        (v, r, s) = PermitSigner.sign(key, token, owner, address(router), value, nonce, deadline);
    }

    /// Smallest supply Aave accepts: anything less mints zero scaled aTokens and reverts inside the pool.
    function _minSupply(uint256 j) internal view returns (uint256) {
        return IAavePool(POLYGON_POOL).getReserveNormalizedIncome(assets[j]) / RAY + 1;
    }

    function _withBuffer(uint256 balance) internal pure returns (uint256) {
        return balance + balance / 1e5 + 10;
    }
}

contract AccrueRouterInvariantTest is Test {
    // Same pinned block as the fork suite; a cold cache needs an archive-capable POLYGON_RPC (polygon.drpc.org).
    uint256 internal constant FORK_BLOCK = 96_900_000;

    AccrueRouter internal router;
    RouterHandler internal handler;
    address[4] internal tokens = [USDT0, A_USDT0, USDC, A_USDC];

    function setUp() public {
        vm.createSelectFork(vm.envString("POLYGON_RPC"), FORK_BLOCK);

        address[] memory assets = new address[](2);
        address[] memory aTokens = new address[](2);
        (assets[0], aTokens[0]) = (USDT0, A_USDT0);
        (assets[1], aTokens[1]) = (USDC, A_USDC);
        router = new AccrueRouter(POLYGON_POOL, assets, aTokens);
        handler = new RouterHandler(router);

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = RouterHandler.supply.selector;
        selectors[1] = RouterHandler.withdraw.selector;
        selectors[2] = RouterHandler.frontRunSupply.selector;
        selectors[3] = RouterHandler.frontRunWithdraw.selector;
        selectors[4] = RouterHandler.pushLeftover.selector;
        selectors[5] = RouterHandler.crossSignedSupply.selector;
        selectors[6] = RouterHandler.crossSignedWithdraw.selector;
        selectors[7] = RouterHandler.passTime.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 20
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_routerHoldsNothing() public view {
        for (uint256 i; i < tokens.length; i++) {
            assertEq(IERC20(tokens[i]).balanceOf(address(router)), 0, "router holds a balance");
        }
        assertEq(IERC20(USDT0).allowance(address(router), POLYGON_POOL), 0, "USDT0 approval to the pool left over");
        assertEq(IERC20(USDC).allowance(address(router), POLYGON_POOL), 0, "USDC approval to the pool left over");
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 20
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_ownersOnlyReceive() public view {
        assertEq(handler.violation(), "");
        for (uint256 i; i < 3; i++) {
            address owner = handler.owners(i);
            for (uint256 j; j < 2; j++) {
                assertGe(handler.valueOf(owner, j), handler.floorOf(owner, handler.assets(j)), "owner lost value");
            }
        }
        address[3] memory others = [handler.relayer(), handler.stranger(), address(handler)];
        for (uint256 i; i < others.length; i++) {
            for (uint256 k; k < tokens.length; k++) {
                assertEq(IERC20(tokens[k]).balanceOf(others[i]), 0, "a non-owner received funds");
            }
        }
    }
}
