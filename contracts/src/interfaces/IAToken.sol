// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of an Aave v3 aToken that AccrueRouter's constructor reads to check its wiring.
interface IAToken {
    // forge-lint: disable-next-line(mixed-case-function) Aave's ABI name.
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);

    // forge-lint: disable-next-line(mixed-case-function) Aave's ABI name.
    function POOL() external view returns (address);
}
