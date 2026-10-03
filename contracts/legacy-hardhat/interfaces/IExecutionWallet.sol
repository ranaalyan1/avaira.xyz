// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IExecutionWallet {
    struct ExecutionPermit {
        address agent;
        string action;
        address target;
        uint256 value;
        uint256 nonce;
        uint256 deadline;
    }

    function execute(ExecutionPermit calldata permit, bytes calldata signature, bytes calldata callData)
        external
        payable
        returns (bytes memory result);

    function setPermitSigner(address signer) external;
    function permitDigest(ExecutionPermit calldata permit) external view returns (bytes32);
}
