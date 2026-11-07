// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {AccrueRouter} from "../src/AccrueRouter.sol";
import {IAavePool} from "../src/interfaces/IAavePool.sol";
import {PermitSigner, USDT0, USDC, A_USDT0, A_USDC} from "./utils/PermitSigner.sol";

contract AccrueRouterForkTest is Test {
    // Polygon PoS at 2026-11-07 12:44:16 UTC. Public full nodes prune state after ~128 blocks, so a cold cache
    // needs an archive-capable POLYGON_RPC (e.g. polygon.drpc.org); Foundry caches the fork state per endpoint.
    uint256 internal constant FORK_BLOCK = 96_900_000;

    address internal constant POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address internal constant USDC_E = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;

    uint256 internal constant FUNDED = 100e6;

    AccrueRouter internal router;
    address internal owner;
    uint256 internal ownerPk;
    uint256 internal strangerPk;
    address internal relayer;

    function setUp() public {
        vm.createSelectFork(vm.envString("POLYGON_RPC"), FORK_BLOCK);

        address[] memory assets = new address[](2);
        address[] memory aTokens = new address[](2);
        (assets[0], aTokens[0]) = (USDT0, A_USDT0);
        (assets[1], aTokens[1]) = (USDC, A_USDC);
        router = new AccrueRouter(POOL, assets, aTokens);

        // Project-scoped labels: well-known test keys such as 0xA11CE carry EIP-7702 delegations on Polygon, and
        // USDC's permit only checks ERC-1271 for an owner with code.
        (owner, ownerPk) = makeAddrAndKey("accrue.owner");
        (, strangerPk) = makeAddrAndKey("accrue.stranger");
        relayer = makeAddr("accrue.relayer");
        assertEq(owner.code.length, 0, "owner is not a plain EOA at the fork block");

        // An aToken contract custodies its reserve's underlying, so it is a deep holder at any block.
        _fund(USDT0, A_USDT0);
        _fund(USDC, A_USDC);
    }

    function test_permitDomains_matchOnChain() public view {
        assertEq(PermitSigner.domainSeparator(USDT0), IERC20Permit(USDT0).DOMAIN_SEPARATOR(), "USDT0");
        assertEq(PermitSigner.domainSeparator(USDC), IERC20Permit(USDC).DOMAIN_SEPARATOR(), "USDC");
        assertEq(PermitSigner.domainSeparator(A_USDT0), IERC20Permit(A_USDT0).DOMAIN_SEPARATOR(), "aUSDT0");
        assertEq(PermitSigner.domainSeparator(A_USDC), IERC20Permit(A_USDC).DOMAIN_SEPARATOR(), "aUSDC");
    }

    function test_supplyUsdt0_permit_mintsATokenToOwner() public {
        _assertSupplyMintsToOwner(USDT0, A_USDT0);
    }

    function test_supplyUsdc_permit() public {
        _assertSupplyMintsToOwner(USDC, A_USDC);
    }

    function test_supply_frontRunPermit_stillSucceeds() public {
        uint256 amount = 5e6;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, USDT0, amount, deadline);

        vm.prank(makeAddr("frontrunner"));
        IERC20Permit(USDT0).permit(owner, address(router), amount, deadline, v, r, s);

        vm.prank(relayer);
        router.supplyWithPermit(USDT0, owner, amount, deadline, v, r, s);

        assertGe(IERC20(A_USDT0).balanceOf(owner), amount - 1);
        assertEq(IERC20(USDT0).allowance(owner, address(router)), 0);
    }

    function test_supply_expiredDeadline_reverts() public {
        uint256 deadline = vm.getBlockTimestamp() - 1;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, USDT0, 5e6, deadline);

        vm.prank(relayer);
        vm.expectRevert(AccrueRouter.InsufficientAllowance.selector);
        router.supplyWithPermit(USDT0, owner, 5e6, deadline, v, r, s);
    }

    function test_supply_wrongSigner_reverts() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(strangerPk, USDT0, 5e6, deadline);

        vm.prank(relayer);
        vm.expectRevert(AccrueRouter.InsufficientAllowance.selector);
        router.supplyWithPermit(USDT0, owner, 5e6, deadline, v, r, s);
    }

    function test_supply_notAllowed_reverts() public {
        assertEq(router.aTokenOf(USDT0), A_USDT0);
        assertEq(router.aTokenOf(USDC), A_USDC);
        assertEq(router.aTokenOf(USDC_E), address(0));

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        vm.prank(relayer);
        vm.expectRevert(AccrueRouter.AssetNotAllowed.selector);
        router.supplyWithPermit(USDC_E, owner, 5e6, deadline, 0, bytes32(0), bytes32(0));

        vm.prank(relayer);
        vm.expectRevert(AccrueRouter.AssetNotAllowed.selector);
        router.withdrawWithPermit(USDC_E, owner, 5e6, 5e6, deadline, 0, bytes32(0), bytes32(0));
    }

    function test_supply_zero_reverts() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, USDT0, 0, deadline);

        vm.prank(relayer);
        vm.expectRevert(AccrueRouter.ZeroAmount.selector);
        router.supplyWithPermit(USDT0, owner, 0, deadline, v, r, s);
    }

    function test_withdrawPartial_sendsToOwnerOnly() public {
        _supply(USDT0, 5e6);
        uint256 amount = 2e6;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, A_USDT0, amount, deadline);
        uint256 ownerBefore = IERC20(USDT0).balanceOf(owner);

        vm.recordLogs();
        vm.prank(relayer);
        uint256 withdrawn = router.withdrawWithPermit(USDT0, owner, amount, amount, deadline, v, r, s);

        assertApproxEqAbs(withdrawn, amount, 2);
        assertEq(IERC20(USDT0).balanceOf(owner), ownerBefore + withdrawn);
        assertApproxEqAbs(IERC20(A_USDT0).balanceOf(owner), 3e6, 2);
        assertEq(IERC20(A_USDT0).allowance(owner, address(router)), 0);
        _assertNothingStrays();
        (uint256 logged, uint256 index) = _routerEvent(AccrueRouter.Withdrawn.selector, USDT0);
        assertEq(logged, withdrawn);
        assertEq(index, IAavePool(POOL).getReserveNormalizedIncome(USDT0));
    }

    function test_withdrawAll_withGrowthBuffer() public {
        _supply(USDT0, 5e6);
        vm.warp(vm.getBlockTimestamp() + 1 days);

        uint256 balance = IERC20(A_USDT0).balanceOf(owner);
        assertGt(balance, 5e6, "no interest accrued");
        uint256 permitValue = balance + balance / 1e5 + 10;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, A_USDT0, permitValue, deadline);

        // The relay lands after signing; the buffer has to absorb the interest accrued in between.
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        uint256 ownerBefore = IERC20(USDT0).balanceOf(owner);

        vm.prank(relayer);
        uint256 withdrawn = router.withdrawWithPermit(USDT0, owner, type(uint256).max, permitValue, deadline, v, r, s);

        assertGe(withdrawn, balance);
        assertLt(IERC20(A_USDT0).balanceOf(owner), 10);
        assertEq(IERC20(USDT0).balanceOf(owner), ownerBefore + withdrawn);
        _assertNothingStrays();
    }

    function test_withdrawAll_cappedBySignedValue() public {
        _supply(USDT0, 5e6);
        uint256 permitValue = 3e6;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, A_USDT0, permitValue, deadline);

        vm.prank(relayer);
        uint256 withdrawn = router.withdrawWithPermit(USDT0, owner, type(uint256).max, permitValue, deadline, v, r, s);

        assertApproxEqAbs(withdrawn, permitValue, 2);
        assertApproxEqAbs(IERC20(A_USDT0).balanceOf(owner), 2e6, 2);
        assertEq(IERC20(A_USDT0).allowance(owner, address(router)), 0);
        _assertNothingStrays();
    }

    function test_withdraw_nothing_reverts() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, A_USDT0, 1e6, deadline);

        vm.prank(relayer);
        vm.expectRevert(AccrueRouter.NothingToWithdraw.selector);
        router.withdrawWithPermit(USDT0, owner, type(uint256).max, 1e6, deadline, v, r, s);
    }

    function test_withdraw_reserveIlliquid_reverts() public {
        _supply(USDT0, 5e6);
        uint256 balance = IERC20(A_USDT0).balanceOf(owner);
        uint256 permitValue = balance + balance / 1e5 + 10;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, A_USDT0, permitValue, deadline);

        bytes memory reason = abi.encodeWithSignature("Error(string)", "reserve illiquid");
        vm.mockCallRevert(POOL, abi.encodeWithSelector(IAavePool.withdraw.selector), reason);

        vm.prank(relayer);
        vm.expectRevert(reason);
        router.withdrawWithPermit(USDT0, owner, type(uint256).max, permitValue, deadline, v, r, s);

        assertEq(IERC20(A_USDT0).balanceOf(owner), balance);
        assertEq(IERC20(A_USDT0).allowance(owner, address(router)), 0);
    }

    function _assertSupplyMintsToOwner(address asset, address aToken) internal {
        uint256 amount = 5e6;
        vm.recordLogs();
        _supply(asset, amount);

        assertGe(IERC20(aToken).balanceOf(owner), amount - 1);
        assertEq(IERC20(asset).balanceOf(owner), FUNDED - amount);
        assertEq(IERC20(asset).allowance(address(router), POOL), 0);
        _assertNothingStrays();
        (uint256 logged, uint256 index) = _routerEvent(AccrueRouter.Supplied.selector, asset);
        assertEq(logged, amount);
        assertEq(index, IAavePool(POOL).getReserveNormalizedIncome(asset));
        assertGt(index, 1e27);
    }

    function _assertNothingStrays() internal view {
        address[4] memory tokens = [USDT0, A_USDT0, USDC, A_USDC];
        for (uint256 i; i < tokens.length; i++) {
            assertEq(IERC20(tokens[i]).balanceOf(address(router)), 0, "router holds funds");
            assertEq(IERC20(tokens[i]).balanceOf(relayer), 0, "relayer received funds");
        }
    }

    function _supply(address asset, uint256 amount) internal {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, asset, amount, deadline);
        vm.prank(relayer);
        router.supplyWithPermit(asset, owner, amount, deadline, v, r, s);
    }

    function _sign(uint256 signerPk, address token, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        uint256 nonce = IERC20Permit(token).nonces(owner);
        return PermitSigner.sign(signerPk, token, owner, address(router), value, nonce, deadline);
    }

    function _fund(address token, address holder) internal {
        vm.prank(holder);
        assertTrue(IERC20(token).transfer(owner, FUNDED));
    }

    function _routerEvent(bytes32 topic0, address asset) internal view returns (uint256 amount, uint256 index) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory log = logs[i - 1];
            if (log.emitter == address(router) && log.topics[0] == topic0) {
                assertEq(log.topics[1], bytes32(uint256(uint160(owner))), "owner topic");
                assertEq(log.topics[2], bytes32(uint256(uint160(asset))), "asset topic");
                return abi.decode(log.data, (uint256, uint256));
            }
        }
        revert("router event not emitted");
    }
}
