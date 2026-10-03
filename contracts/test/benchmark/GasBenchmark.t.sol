// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {AvairaReputationRegistry} from "avaira/core/AvairaReputationRegistry.sol";
import {AvairaValidationRegistry} from "avaira/core/AvairaValidationRegistry.sol";
import {RiskEnvelope, SlashLevel} from "avaira/lib/AvairaTypes.sol";
import {DeviationLeaf, GateReason} from "avaira/interfaces/IAvaira.sol";
import {MerkleLib} from "avaira/lib/MerkleLib.sol";

import {AvairaFixture} from "../utils/AvairaFixture.sol";

/// @title GasBenchmark
/// @notice Measures the real gas cost of every Avaira primitive and writes
///         `contracts/metrics/gas.json` for the README, dashboard and submission.
/// @dev Gas is EVM-intrinsic, so these numbers are exactly what Monad charges. Monad's
///      published average transaction cost ($0.004–0.007) then converts them to USD.
///      Run with: `make benchmark`
contract GasBenchmark is AvairaFixture {
    uint256 internal agentId;
    bytes32 internal constant INTENT_HASH = keccak256("benchmark:intent");

    struct Snapshot {
        uint256 registerAgent;
        uint256 setAgentWallet;
        uint256 stake;
        uint256 slashWarning;
        uint256 commitIntent;
        uint256 attestOutcome;
        uint256 giveFeedback;
        uint256 validationRequest;
        uint256 validationResponse;
        uint256 challengeDeviation;
        uint256 depositCollateral;
        uint256 borrow;
        uint256 gateDecisionRecord;
    }

    function setUp() public override {
        super.setUp();
        agentId = _activeAgent(alice, MIN_STAKE, 82);
    }

    function test_GasBenchmark_WriteMetrics() public {
        Snapshot memory s;

        // ---- identity ---------------------------------------------------------------
        vm.prank(bob);
        uint256 gasBefore = gasleft();
        uint256 benchAgent = identity.register{value: REGISTRATION_BOND}("ipfs://avaira/agent/gas.json");
        s.registerAgent = gasBefore - gasleft();

        address newWallet = vm.addr(BOB_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = identity.hashAgentWalletSet(benchAgent, newWallet, 0, deadline);
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(BOB_PK, digest);
        vm.prank(bob);
        gasBefore = gasleft();
        identity.setAgentWallet(benchAgent, newWallet, deadline, abi.encodePacked(r, sig, v));
        s.setAgentWallet = gasBefore - gasleft();

        // ---- staking ----------------------------------------------------------------
        // 2x the minimum so the WARNING measured below leaves bob a staked reviewer.
        vm.prank(bob);
        gasBefore = gasleft();
        stakeRegistry.stake(benchAgent, MIN_STAKE * 2);
        s.stake = gasBefore - gasleft();

        vm.prank(owner);
        gasBefore = gasleft();
        stakeRegistry.slashAgent(benchAgent, SlashLevel.WARNING, carol, keccak256("bench"), "bench");
        s.slashWarning = gasBefore - gasleft();

        // ---- proof of intent ----------------------------------------------------------
        RiskEnvelope memory envelope = _envelope2(25e6, "web.search", "mcp.call", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        gasBefore = gasleft();
        vault.commitIntent(agentId, INTENT_HASH, envelope);
        s.commitIntent = gasBefore - gasleft();

        DeviationLeaf memory compliant =
            DeviationLeaf({agentId: agentId, intentHash: INTENT_HASH, action: "web.search", spendUsd: 3e6, nonce: 0});
        DeviationLeaf memory deviating =
            DeviationLeaf({agentId: agentId, intentHash: INTENT_HASH, action: "wallet.transfer", spendUsd: 900e6, nonce: 1});
        bytes32[] memory hashed = new bytes32[](2);
        hashed[0] = MerkleLib.hashDeviationLeaf(compliant);
        hashed[1] = MerkleLib.hashDeviationLeaf(deviating);
        bytes32 root = MerkleLib.root(hashed);

        vm.prank(alice);
        gasBefore = gasleft();
        vault.attestOutcome(agentId, INTENT_HASH, keccak256("outcome"), root);
        s.attestOutcome = gasBefore - gasleft();

        vm.prank(alice);
        gasBefore = gasleft();
        vault.recordGateDecision(agentId, INTENT_HASH, true, GateReason.ALLOWED, 214);
        s.gateDecisionRecord = gasBefore - gasleft();

        // ---- grounded feedback -------------------------------------------------------
        vm.prank(bob);
        gasBefore = gasleft();
        reputation.giveFeedback(agentId, 4_900_000, 6, "successRate", "bench", "mcp://agent", "ipfs://fb", bytes32(0));
        s.giveFeedback = gasBefore - gasleft();

        // ---- validation ----------------------------------------------------------------
        vm.prank(owner);
        validation.registerValidator(carol, "ipfs://validator/kimi.json");
        bytes32 requestHash = keccak256("benchmark:request");
        vm.prank(alice);
        gasBefore = gasleft();
        validation.validationRequest(carol, agentId, "ipfs://request", requestHash);
        s.validationRequest = gasBefore - gasleft();

        vm.prank(carol);
        gasBefore = gasleft();
        validation.validationResponse(requestHash, 88, "ipfs://response", keccak256("resp"), "kimi-adversarial");
        s.validationResponse = gasBefore - gasleft();

        // ---- deviation challenge --------------------------------------------------------
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = hashed[0];
        vm.prank(carol);
        gasBefore = gasleft();
        vault.challengeDeviation(agentId, INTENT_HASH, deviating, proof);
        s.challengeDeviation = gasBefore - gasleft();

        // ---- credit ----------------------------------------------------------------------
        vm.prank(alice);
        gasBefore = gasleft();
        market.depositCollateral(agentId, 110e6);
        s.depositCollateral = gasBefore - gasleft();

        _setScore(agentId, 85);
        vm.prank(alice);
        gasBefore = gasleft();
        market.borrow(agentId, 100e6);
        s.borrow = gasBefore - gasleft();

        _write(s);
        _log(s);
    }

    function _write(Snapshot memory s) private {
        string memory key = "gas";
        vm.serializeUint(key, "registerAgent", s.registerAgent);
        vm.serializeUint(key, "setAgentWallet", s.setAgentWallet);
        vm.serializeUint(key, "stake", s.stake);
        vm.serializeUint(key, "slashWarning", s.slashWarning);
        vm.serializeUint(key, "commitIntent", s.commitIntent);
        vm.serializeUint(key, "attestOutcome", s.attestOutcome);
        vm.serializeUint(key, "recordGateDecision", s.gateDecisionRecord);
        vm.serializeUint(key, "giveFeedback", s.giveFeedback);
        vm.serializeUint(key, "validationRequest", s.validationRequest);
        vm.serializeUint(key, "validationResponse", s.validationResponse);
        vm.serializeUint(key, "challengeDeviation", s.challengeDeviation);
        vm.serializeUint(key, "depositCollateral", s.depositCollateral);
        string memory json = vm.serializeUint(key, "borrow", s.borrow);
        vm.writeJson(json, "metrics/gas.json");
    }

    function _log(Snapshot memory s) private pure {
        console2.log("");
        console2.log("Avaira gas profile (EVM-intrinsic; identical on Monad)");
        console2.log("----------------------------------------------------");
        console2.log("registerAgent        ", s.registerAgent);
        console2.log("setAgentWallet       ", s.setAgentWallet);
        console2.log("stake                ", s.stake);
        console2.log("slashAgent(WARNING)  ", s.slashWarning);
        console2.log("commitIntent         ", s.commitIntent);
        console2.log("attestOutcome        ", s.attestOutcome);
        console2.log("recordGateDecision   ", s.gateDecisionRecord);
        console2.log("giveFeedback         ", s.giveFeedback);
        console2.log("validationRequest    ", s.validationRequest);
        console2.log("validationResponse   ", s.validationResponse);
        console2.log("challengeDeviation   ", s.challengeDeviation);
        console2.log("depositCollateral    ", s.depositCollateral);
        console2.log("borrow               ", s.borrow);
    }
}
