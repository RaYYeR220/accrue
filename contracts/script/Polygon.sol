// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Polygon PoS mainnet addresses Accrue is wired to. The deploy script and the fork tests both read them from here,
// so the router that ships is the one the tests ran against.

uint256 constant POLYGON_CHAIN_ID = 137;

address constant POLYGON_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

address constant POLYGON_USDT0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
address constant POLYGON_A_USDT0 = 0x6ab707Aca953eDAeFBc4fD23bA73294241490620;

address constant POLYGON_USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
address constant POLYGON_A_USDC = 0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD;
