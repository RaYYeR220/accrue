// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccrueRouter} from "../src/AccrueRouter.sol";
import {Deploy, IAaveReserves, ReserveDataLegacy} from "../script/Deploy.s.sol";
import {POLYGON_POOL, POLYGON_USDT0, POLYGON_A_USDT0, POLYGON_USDC, POLYGON_A_USDC} from "../script/Polygon.sol";

contract DeployScriptTest is Test {
    function setUp() public {
        // Never let a real deployer key in the shell reach a test run.
        vm.setEnv("ACCRUE_DEPLOYER_PK", "0");
    }

    function test_deployScript_wiresBothReserves() public {
        vm.createSelectFork(vm.envString("POLYGON_RPC"), 96_900_000);

        AccrueRouter router = new Deploy().run();

        assertEq(address(router.POOL()), POLYGON_POOL);
        assertEq(router.aTokenOf(POLYGON_USDT0), POLYGON_A_USDT0);
        assertEq(router.aTokenOf(POLYGON_USDC), POLYGON_A_USDC);
    }

    function test_deployScript_rejectsRegistryMismatch() public {
        vm.createSelectFork(vm.envString("POLYGON_RPC"), 96_900_000);
        bytes memory query = abi.encodeCall(IAaveReserves.getReserveData, (POLYGON_USDC));
        (bool ok, bytes memory raw) = POLYGON_POOL.staticcall(query);
        assertTrue(ok);
        ReserveDataLegacy memory data = abi.decode(raw, (ReserveDataLegacy));
        assertEq(data.aTokenAddress, POLYGON_A_USDC, "struct layout drifted from the pool's");

        data.aTokenAddress = makeAddr("impostor");
        vm.mockCall(POLYGON_POOL, query, abi.encode(data));

        Deploy deploy = new Deploy();
        vm.expectRevert(bytes("Deploy: aToken is not the pool's"));
        deploy.run();
    }

    function test_deployScript_refusesOtherChains() public {
        vm.chainId(1);
        Deploy deploy = new Deploy();
        vm.expectRevert(bytes("Deploy: not Polygon"));
        deploy.run();
    }
}
