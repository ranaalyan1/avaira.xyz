// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC3009 — Transfer With Authorization (used by x402 settlements and by
///        Circle's USDC on Monad).
/// @notice x402 payments settle as signed transfer authorizations. Avaira verifies the
///         resulting balance delta onchain, which is what turns "I paid this agent"
///         from a claim in a JSON blob into grounded, non-forgeable evidence.
interface IERC3009 {
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
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
