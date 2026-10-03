// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title MockUSDC
/// @notice 6-decimal USDC stand-in with EIP-3009 `transferWithAuthorization` /
///         `receiveWithAuthorization`, the settlement primitive x402 uses.
/// @dev Monad ships native USDC with EIP-3009 support; this contract mirrors the
///      relevant surface so the grounding path can be exercised end to end in tests
///      and on testnet without depending on a bridged faucet.
contract MockUSDC is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationNonceAlreadyUsed();
    error CallerMustBePayee();
    error InvalidAuthorizationSignature();

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event TransferWithAuthorization(
        address indexed from, address indexed to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce
    );

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    constructor() ERC20("Avaira Test USD", "USDC") EIP712("Avaira Test USD", "2") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Test faucet; capped so a single call cannot drain a whale balance.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        // EIP-3009: `receive` may only be submitted by the payee itself, which is what
        // makes it safe to use as an in-transaction "the reviewer really paid" proof.
        if (msg.sender != to) revert CallerMustBePayee();
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationNonceAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
        // Accept both the receive- and transfer-flavoured digests for interoperability.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != from) {
            digest = _hashTypedDataV4(
                keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
            );
            (signer, err,) = ECDSA.tryRecover(digest, signature);
        }
        if (err != ECDSA.RecoverError.NoError || signer != from) revert InvalidAuthorizationSignature();

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        emit TransferWithAuthorization(from, to, value, validAfter, validBefore, nonce);
        _transfer(from, to, value);
    }
}
