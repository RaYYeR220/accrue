// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAavePool} from "./interfaces/IAavePool.sol";

/// @title AccrueRouter
/// @notice Turns an owner's EIP-2612 permit into an Aave v3 supply or withdraw on the owner's behalf, so anyone
/// (in practice the Accrue relayer) can pay the gas.
/// @dev Immutable, ownerless and fee-free. Whatever the caller passes, tokens only move owner -> Aave (aTokens
/// minted to owner) or owner's aTokens -> Aave -> owner, within the allowance owner granted, and the router holds
/// no balance between transactions.
contract AccrueRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAavePool public immutable POOL;

    mapping(address asset => address aToken) private _aTokenOf;

    /// @param index Aave liquidity index (ray) of `asset` right after the supply.
    event Supplied(address indexed owner, address indexed asset, uint256 amount, uint256 index);
    /// @param amount Underlying actually sent to `owner`, as reported by the pool.
    /// @param index Aave liquidity index (ray) of `asset` right after the withdraw.
    event Withdrawn(address indexed owner, address indexed asset, uint256 amount, uint256 index);

    error AssetNotAllowed();
    error ZeroAmount();
    error InsufficientAllowance();
    error NothingToWithdraw();

    /// @param pool Aave v3 Pool.
    /// @param assets Underlying tokens the router accepts; fixed for the router's lifetime.
    /// @param aTokens Aave aToken of each entry in `assets`, same order.
    constructor(address pool, address[] memory assets, address[] memory aTokens) {
        require(pool != address(0) && assets.length == aTokens.length, "AccrueRouter: bad config");
        POOL = IAavePool(pool);
        for (uint256 i; i < assets.length; i++) {
            // forge-lint: disable-next-line(require-revert-in-loop) deploy-time check; one bad pair must abort it all.
            require(assets[i] != address(0) && aTokens[i] != address(0), "AccrueRouter: bad config");
            _aTokenOf[assets[i]] = aTokens[i];
        }
    }

    /// @notice Pulls `amount` of `asset` from `owner` with their permit and supplies it to Aave for `owner`.
    /// @dev A permit that fails (already used by a front-runner, expired, bad signature) is ignored; what decides
    /// is whether the router ends up with enough allowance, so a front-run permit cannot block the supply.
    /// @param asset Allowlisted underlying token.
    /// @param owner Token holder who signed the permit; receives the aTokens.
    /// @param amount Amount to supply; also the permit's `value`.
    /// @param deadline Permit deadline.
    function supplyWithPermit(
        address asset,
        address owner,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (_aTokenOf[asset] == address(0)) revert AssetNotAllowed();
        if (amount == 0) revert ZeroAmount();

        // forge-lint: disable-next-line(reentrancy-no-eth) nonReentrant; the token is allowlisted and has no hooks.
        try IERC20Permit(asset).permit(owner, address(this), amount, deadline, v, r, s) {} catch {}
        if (IERC20(asset).allowance(owner, address(this)) < amount) revert InsufficientAllowance();

        // forge-lint: disable-next-line(arbitrary-send-erc20) `owner` signed the permit and gets the aTokens.
        IERC20(asset).safeTransferFrom(owner, address(this), amount);
        IERC20(asset).forceApprove(address(POOL), amount);
        // forge-lint: disable-next-line(reentrancy-no-eth) nonReentrant; the pool is immutable Aave v3.
        POOL.supply(asset, amount, owner, 0);

        // forge-lint: disable-next-line(reentrancy-events) nonReentrant, so no call can re-enter and reorder logs.
        emit Supplied(owner, asset, amount, POOL.getReserveNormalizedIncome(asset));
    }

    /// @notice Pulls up to `amount` of `owner`'s aTokens with their aToken permit and redeems them from Aave
    /// straight to `owner`.
    /// @dev Pulls min(amount, aToken balance, allowance), so `amount = type(uint256).max` with a `permitValue`
    /// above the balance at signing withdraws everything, including interest accrued until the relay lands.
    /// Pool reverts (e.g. not enough liquidity in the reserve) bubble up unchanged.
    /// @param asset Allowlisted underlying token to receive.
    /// @param owner aToken holder who signed the permit; receives the underlying.
    /// @param amount Upper bound of aTokens to redeem; type(uint256).max for everything.
    /// @param permitValue The permit's signed `value`.
    /// @param deadline Permit deadline.
    /// @return withdrawn Underlying sent to `owner`.
    function withdrawWithPermit(
        address asset,
        address owner,
        uint256 amount,
        uint256 permitValue,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 withdrawn) {
        // Scoped so `aToken` and `pull` leave the stack before the pool call; with 8 parameters plus the return
        // value the function otherwise fails to compile with "stack too deep".
        {
            IERC20 aToken = IERC20(_aTokenOf[asset]);
            if (address(aToken) == address(0)) revert AssetNotAllowed();

            // forge-lint: disable-next-line(reentrancy-no-eth) nonReentrant; the aToken is allowlisted Aave v3.
            try IERC20Permit(address(aToken)).permit(owner, address(this), permitValue, deadline, v, r, s) {} catch {}
            uint256 pull = Math.min(amount, Math.min(aToken.balanceOf(owner), aToken.allowance(owner, address(this))));
            if (pull == 0) revert NothingToWithdraw();

            // forge-lint: disable-next-line(arbitrary-send-erc20) `owner` signed the permit and gets the underlying.
            aToken.safeTransferFrom(owner, address(this), pull);
        }
        // Redeem the router's whole aToken balance: aToken transfers round, so `pull` may arrive off by a unit.
        // forge-lint: disable-next-line(reentrancy-no-eth) nonReentrant; the pool is immutable Aave v3.
        withdrawn = POOL.withdraw(asset, type(uint256).max, owner);

        // forge-lint: disable-next-line(reentrancy-events) nonReentrant, so no call can re-enter and reorder logs.
        emit Withdrawn(owner, asset, withdrawn, POOL.getReserveNormalizedIncome(asset));
    }

    /// @notice aToken the router uses for `asset`, or the zero address if `asset` is not allowlisted.
    function aTokenOf(address asset) external view returns (address) {
        return _aTokenOf[asset];
    }
}
