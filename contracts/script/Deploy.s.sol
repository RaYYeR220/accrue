// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AccrueRouter} from "../src/AccrueRouter.sol";
import {
    POLYGON_CHAIN_ID,
    POLYGON_POOL,
    POLYGON_USDT0,
    POLYGON_A_USDT0,
    POLYGON_USDC,
    POLYGON_A_USDC
} from "./Polygon.sol";

/// @dev Field order of Aave v3's `DataTypes.ReserveDataLegacy`, the return type of `Pool.getReserveData`.
struct ReserveDataLegacy {
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

interface IAaveReserves {
    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
}

/// @notice Deploys AccrueRouter for USDT0 and USDC on Polygon and checks the result against the pool's registry.
/// @dev Broadcasts from ACCRUE_DEPLOYER_PK when it is set; without it (or without --broadcast) it only simulates.
contract Deploy is Script {
    function run() external returns (AccrueRouter router) {
        require(block.chainid == POLYGON_CHAIN_ID, "Deploy: not Polygon");

        address[] memory assets = new address[](2);
        address[] memory aTokens = new address[](2);
        (assets[0], aTokens[0]) = (POLYGON_USDT0, POLYGON_A_USDT0);
        (assets[1], aTokens[1]) = (POLYGON_USDC, POLYGON_A_USDC);

        uint256 deployerPk = vm.envOr("ACCRUE_DEPLOYER_PK", uint256(0));
        if (deployerPk == 0) vm.startBroadcast();
        else vm.startBroadcast(deployerPk);
        router = new AccrueRouter(POLYGON_POOL, assets, aTokens);
        vm.stopBroadcast();

        // The constructor takes each aToken's word for its underlying and pool; the pool's own reserve registry is
        // the authority on which aToken a reserve mints, so the deployment is checked against it.
        require(address(router.POOL()) == POLYGON_POOL, "Deploy: wrong pool");
        for (uint256 i; i < assets.length; i++) {
            address registered = IAaveReserves(POLYGON_POOL).getReserveData(assets[i]).aTokenAddress;
            require(router.aTokenOf(assets[i]) == registered, "Deploy: aToken is not the pool's");
            console.log("asset", assets[i], "aToken", registered);
        }
        console.log("AccrueRouter", address(router));
    }
}
