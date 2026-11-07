// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

address constant USDT0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
address constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
address constant A_USDT0 = 0x6ab707Aca953eDAeFBc4fD23bA73294241490620;
address constant A_USDC = 0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD;

/// @notice EIP-2612 signing for the Polygon tokens Accrue touches. Domains are rebuilt from their published
/// parameters instead of read from DOMAIN_SEPARATOR(), so a wrong domain here is the same mistake a wallet
/// signing off-chain would make, and the fork tests catch it.
library PermitSigner {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant CHAIN_ID = 137;

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    // USDT0 has no chainId field; the chain id rides in the salt instead.
    bytes32 private constant SALTED_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");

    function domainSeparator(address token) internal pure returns (bytes32) {
        if (token == USDT0) {
            return
                keccak256(
                    abi.encode(SALTED_DOMAIN_TYPEHASH, keccak256("USDT0"), keccak256("1"), token, bytes32(CHAIN_ID))
                );
        }
        if (token == USDC) return _domain("USD Coin", "2", token);
        if (token == A_USDT0) return _domain("Aave Polygon USDT", "1", token);
        if (token == A_USDC) return _domain("Aave Polygon USDCn", "1", token);
        revert("PermitSigner: unknown token");
    }

    function sign(
        uint256 signerPk,
        address token,
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        return VM.sign(signerPk, keccak256(abi.encodePacked("\x19\x01", domainSeparator(token), structHash)));
    }

    function _domain(string memory name, string memory version, address token) private pure returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), CHAIN_ID, token));
    }
}
