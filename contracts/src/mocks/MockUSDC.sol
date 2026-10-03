// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MockUSDC — 6-decimal test stablecoin with EIP-3009 transfer authorizations.
/// @notice Mirrors the surface of Circle's USDC on Monad that Avaira depends on
///         (transferWithAuthorization with v/r/s + authorizationState), so the
///         grounded-feedback and staking paths can be tested exactly as they will run
///         against the real token. Not for production use.
contract MockUSDC is ERC20, EIP712 {
    using ECDSA for bytes32;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InvalidAuthorizationSignature();
    error InsufficientBalanceForAuthorization(address from, uint256 value);

    constructor() ERC20("USD Coin (test)", "USDC") EIP712("USD Coin", "2") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationState[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        if (_authorizationState[from][nonce]) revert AuthorizationAlreadyUsed(from, nonce);

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
        if (digest.recover(v, r, s) != from) revert InvalidAuthorizationSignature();
        if (balanceOf(from) < value) revert InsufficientBalanceForAuthorization(from, value);

        _authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice Convenience for tests: sign an authorization with a raw private key.
    function transferWithAuthorizationHash(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
    }
}
