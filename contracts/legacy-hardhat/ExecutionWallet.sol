// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./AgentRegistry.sol";
import "./Treasury.sol";

/// @title AVAIRA Execution Wallet
/// @notice Verifies EIP-712 execution permits, enforces risk envelopes, and routes protocol fees.
contract ExecutionWallet is Ownable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    struct ExecutionPermit {
        address agent;
        string action;
        address target;
        uint256 value;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant EXECUTION_PERMIT_TYPEHASH = keccak256(
        "ExecutionPermit(address agent,string action,address target,uint256 value,uint256 nonce,uint256 deadline)"
    );
    uint256 public constant FEE_BPS = 50;

    AgentRegistry public immutable registry;
    Treasury public immutable treasury;
    mapping(bytes32 => bool) public usedPermits;
    address public permitSigner;

    event PermitConsumed(bytes32 indexed permitDigest, address indexed agent, uint256 nonce, uint256 deadline);
    event TransactionExecuted(address indexed agent, address indexed target, string action, uint256 value, uint256 fee);
    event FeeTransferred(address indexed treasury, uint256 amount);

    error ExecutionWallet__InvalidPermit();
    error ExecutionWallet__ExpiredPermit();
    error ExecutionWallet__ReplayDetected();
    error ExecutionWallet__InvalidValue();
    error ExecutionWallet__InvalidFunding();
    error ExecutionWallet__UnauthorizedSigner();
    error ExecutionWallet__RiskEnvelopeViolation(string reason);

    constructor(address registryAddress, address payable treasuryAddress)
        Ownable(msg.sender)
        EIP712("AvairaProtocol", "1")
    {
        registry = AgentRegistry(registryAddress);
        treasury = Treasury(treasuryAddress);
        permitSigner = msg.sender;
    }

    function setPermitSigner(address signer) external onlyOwner {
        permitSigner = signer;
    }

    /// @notice Executes a target call when a valid permit has been signed by the agent.
    /// @param permit The EIP-712 execution permit.
    /// @param signature The secp256k1 signature over the permit digest.
    /// @param callData Calldata forwarded to the target contract.
    function execute(
        ExecutionPermit calldata permit,
        bytes calldata signature,
        bytes calldata callData
    ) external payable nonReentrant returns (bytes memory result) {
        if (block.timestamp > permit.deadline) {
            revert ExecutionWallet__ExpiredPermit();
        }
        if (permit.target == address(0) || permit.value == 0) {
            revert ExecutionWallet__InvalidValue();
        }
        if (msg.value != permit.value) {
            revert ExecutionWallet__InvalidFunding();
        }

        AgentRegistry.Agent memory agent = registry.getAgent(permit.agent);
        if (agent.wallet == address(0) || agent.status != AgentRegistry.Status.Active) {
            revert ExecutionWallet__InvalidPermit();
        }
        if (permit.nonce != agent.nonce + 1) {
            revert ExecutionWallet__InvalidPermit();
        }
        _checkRiskEnvelope(agent.envelope, permit.action, permit.value);

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    EXECUTION_PERMIT_TYPEHASH,
                    permit.agent,
                    keccak256(bytes(permit.action)),
                    permit.target,
                    permit.value,
                    permit.nonce,
                    permit.deadline
                )
            )
        );
        if (usedPermits[digest]) {
            revert ExecutionWallet__ReplayDetected();
        }

        address signer = ECDSA.recover(digest, signature);
        if (!(signer == permit.agent || signer == permitSigner)) {
            revert ExecutionWallet__UnauthorizedSigner();
        }
        usedPermits[digest] = true;
        emit PermitConsumed(digest, permit.agent, permit.nonce, permit.deadline);

        uint256 fee = (permit.value * FEE_BPS) / 10_000;
        uint256 executionValue = permit.value - fee;

        (bool ok, bytes memory returnData) = permit.target.call{value: executionValue}(callData);
        require(ok, "ExecutionWallet: target call failed");
        result = returnData;

        (bool feeSent, ) = payable(address(treasury)).call{value: fee}("");
        require(feeSent, "ExecutionWallet: treasury transfer failed");
        emit FeeTransferred(address(treasury), fee);

        registry.incrementNonce(permit.agent);
        registry.recordExecution(permit.agent, true, _missionComplexityBps(permit));
        registry.updateReputation(permit.agent, 2, "execution_success");

        emit TransactionExecuted(permit.agent, permit.target, permit.action, permit.value, fee);
    }

    /// @notice Computes the EIP-712 digest for an execution permit.
    /// @param permit The execution permit to hash.
    function permitDigest(ExecutionPermit calldata permit) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    EXECUTION_PERMIT_TYPEHASH,
                    permit.agent,
                    keccak256(bytes(permit.action)),
                    permit.target,
                    permit.value,
                    permit.nonce,
                    permit.deadline
                )
            )
        );
    }

    function _checkRiskEnvelope(AgentRegistry.RiskEnvelope memory envelope, string calldata action, uint256 value) internal pure {
        if (value > envelope.maxTxValue) {
            revert ExecutionWallet__RiskEnvelopeViolation("value exceeds maxTxValue");
        }
        if (!_actionAllowed(envelope.allowedActions, action)) {
            revert ExecutionWallet__RiskEnvelopeViolation("action not allowed");
        }
    }

    function _actionAllowed(string memory allowedActions, string calldata action) internal pure returns (bool) {
        bytes memory haystack = _lowercase(bytes(allowedActions));
        bytes memory needle = _lowercase(bytes(action));
        if (needle.length == 0) {
            return false;
        }
        if (keccak256(haystack) == keccak256(bytes("*"))) {
            return true;
        }
        for (uint256 i = 0; i + needle.length <= haystack.length; i++) {
            bool matchFound = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    matchFound = false;
                    break;
                }
            }
            if (matchFound) {
                bool leftOk = i == 0 || haystack[i - 1] == "," || haystack[i - 1] == "|" || haystack[i - 1] == " ";
                bool rightOk = i + needle.length == haystack.length || haystack[i + needle.length] == "," || haystack[i + needle.length] == "|" || haystack[i + needle.length] == " ";
                if (leftOk && rightOk) {
                    return true;
                }
            }
        }
        return false;
    }

    function _missionComplexityBps(ExecutionPermit calldata permit) internal pure returns (uint256) {
        uint256 base = permit.value >= 10 ether ? 8_500 : permit.value >= 1 ether ? 6_000 : 3_500;
        uint256 actionWeight = bytes(permit.action).length > 8 ? 1_500 : 500;
        uint256 score = base + actionWeight;
        return score > 10_000 ? 10_000 : score;
    }

    function _lowercase(bytes memory input) internal pure returns (bytes memory output) {
        output = new bytes(input.length);
        for (uint256 i = 0; i < input.length; i++) {
            bytes1 char = input[i];
            if (char >= 0x41 && char <= 0x5A) {
                output[i] = bytes1(uint8(char) + 32);
            } else {
                output[i] = char;
            }
        }
    }

    receive() external payable {}
}
