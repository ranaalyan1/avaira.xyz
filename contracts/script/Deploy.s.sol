// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {AvairaIdentityRegistry} from "avaira/core/AvairaIdentityRegistry.sol";
import {AvairaReputationRegistry} from "avaira/core/AvairaReputationRegistry.sol";
import {AvairaValidationRegistry} from "avaira/core/AvairaValidationRegistry.sol";
import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {AvairaCreditMarket} from "avaira/core/AvairaCreditMarket.sol";
import {AvairaComplianceGate} from "avaira/core/AvairaComplianceGate.sol";
import {AvairaCVA} from "avaira/tokens/AvairaCVA.sol";
import {MockUSDC} from "avaira/tokens/MockUSDC.sol";

/// @title DeployAvaira
/// @notice One-shot deployment of the full Avaira stack (Components 1–6) plus all
///         cross-contract wiring, writing `deployments/{chainId}.json` for the SDK,
///         dashboard and README.
///
/// Usage:
///   forge script script/Deploy.s.sol:DeployAvaira \
///     --rpc-url $MONAD_TESTNET_RPC --broadcast --slow \
///     --private-key $DEPLOYER_PRIVATE_KEY
///
/// Environment (all optional except the RPC + key):
///   ADMIN                — protocol admin (defaults to the deployer)
///   TREASURY             — slash/forfeit recipient (defaults to the deployer)
///   USDC                 — settlement token; a MockUSDC is deployed when unset
///   REGISTRATION_BOND    — identity bond in wei (default 0.05 MON)
///   MIN_STAKE_USDC       — minimum agent stake in USDC units (default 100e6)
///   MIN_SCORE            — eligibility score floor (default 60)
///   CHALLENGE_WINDOW     — deviation challenge window in seconds (default 86400)
///   CHALLENGER_BOND_USDC — anti-spam bond for challengers (default 5e6)
///   MIN_GROUNDED_PAYMENT — minimum settled payment to ground feedback (default 0.1e6)
///   SEED_LIQUIDITY_USDC  — credit-market liquidity to seed (default 500_000e6, mock USDC only)
///   CLEANVERSE_ISSUER    — Cleanverse CVI issuer signer (defaults to the deployer)
///   CVI_DEFAULT_VALIDITY — CVI credential TTL in seconds (default 365 days)
///   CVA_SEED_SUPPLY      — CVA minted to the deployer for demos (default 1_000_000e18)
///   CLEANVERSE_ISSUER_PRIVATE_KEY — when set, the deployer is CVI-verified in-script so the
///                         demo can move CVA immediately after deployment
contract DeployAvaira is Script {
    struct Deployment {
        address identity;
        address reputation;
        address validation;
        address stake;
        address vault;
        address market;
        address usdc;
        address complianceGate;
        address cva;
    }

    function run() external returns (Deployment memory deployment) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address admin = vm.envOr("ADMIN", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        address usdc = vm.envOr("USDC", address(0));

        uint256 registrationBond = vm.envOr("REGISTRATION_BOND", uint256(0.05 ether));
        uint256 minStake = vm.envOr("MIN_STAKE_USDC", uint256(100e6));
        uint8 minScore = uint8(vm.envOr("MIN_SCORE", uint256(60)));
        uint64 challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(24 hours)));
        uint256 challengerBond = vm.envOr("CHALLENGER_BOND_USDC", uint256(5e6));
        uint256 minGroundedPayment = vm.envOr("MIN_GROUNDED_PAYMENT", uint256(0.1e6));
        uint256 seedLiquidity = vm.envOr("SEED_LIQUIDITY_USDC", uint256(500_000e6));
        // When an issuer key is supplied, default the issuer address to that key's address.
        uint256 issuerKeyHint = vm.envOr("CLEANVERSE_ISSUER_PRIVATE_KEY", uint256(0));
        address cleanverseIssuer = vm.envOr("CLEANVERSE_ISSUER", issuerKeyHint != 0 ? vm.addr(issuerKeyHint) : deployer);
        uint64 cviDefaultValidity = uint64(vm.envOr("CVI_DEFAULT_VALIDITY", uint256(365 days)));
        uint256 cvaSeedSupply = vm.envOr("CVA_SEED_SUPPLY", uint256(1_000_000e18));

        vm.startBroadcast(deployerKey);

        bool mockUsdc = usdc == address(0);
        if (mockUsdc) usdc = address(new MockUSDC());

        deployment.identity = address(new AvairaIdentityRegistry(registrationBond, admin));
        deployment.reputation = address(new AvairaReputationRegistry(deployment.identity, address(0), usdc, admin));
        deployment.validation = address(new AvairaValidationRegistry(deployment.identity, admin));
        deployment.stake =
            address(new AvairaStakeRegistry(usdc, deployment.identity, deployment.reputation, minStake, minScore, admin));
        deployment.vault = address(new AvairaIntentVault(deployment.identity, deployment.stake, usdc, challengeWindow, admin));
        deployment.market = address(new AvairaCreditMarket(usdc, deployment.stake, deployment.identity, admin));
        deployment.usdc = usdc;

        // ---- Cleanverse CVI/CVA compliance (Workstream 1) --------------------------
        deployment.complianceGate = address(new AvairaComplianceGate(admin, cleanverseIssuer, cviDefaultValidity));
        deployment.cva = address(new AvairaCVA(deployment.complianceGate, admin));

        // ---- cross-contract wiring -------------------------------------------------
        AvairaReputationRegistry(deployment.reputation).setScorerConfig(deployment.stake, usdc, minGroundedPayment);
        AvairaIdentityRegistry(payable(deployment.identity)).setEnforcer(deployment.stake);
        AvairaIdentityRegistry(payable(deployment.identity)).setTreasury(treasury);

        AvairaStakeRegistry stake = AvairaStakeRegistry(deployment.stake);
        stake.setSlasher(deployment.vault, true);
        stake.setTreasury(treasury);

        AvairaIntentVault vault = AvairaIntentVault(deployment.vault);
        vault.setChallengerBond(challengerBond);
        vault.setTreasury(treasury);
        // The CVI hook: any intent whose envelope allows `cva.*` now needs verified wallets.
        vault.setComplianceGate(deployment.complianceGate);

        // ---- Cleanverse demo bootstrap ---------------------------------------------
        // With the issuer key present the deployer gets a real wallet-bound CVI credential
        // and a CVA balance, so `scripts/demo-cvi-cva.ts` can run right after `make deploy-monad`.
        if (issuerKeyHint != 0) {
            address issuerSigner = vm.addr(issuerKeyHint);
            require(issuerSigner == cleanverseIssuer, "CLEANVERSE_ISSUER must match the issuer key");
            uint256 issuerKey = issuerKeyHint;
            AvairaComplianceGate gate = AvairaComplianceGate(deployment.complianceGate);
            bytes32 credentialHash = keccak256(abi.encodePacked("cleanverse:ccp:demo:", vm.toString(deployer)));
            bytes32 digest = gate.hashCVIClaim(deployer, credentialHash, gate.credentialNonce(deployer));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerKey, digest);
            gate.verifyCVI(deployer, abi.encodePacked(r, s, v), credentialHash);
        }
        if (cvaSeedSupply > 0 && AvairaComplianceGate(deployment.complianceGate).isCVIValid(deployer)) {
            AvairaCVA(deployment.cva).mint(deployer, cvaSeedSupply);
        }

        // ---- demo liquidity (mock USDC only) ---------------------------------------
        if (mockUsdc && seedLiquidity > 0) {
            MockUSDC(usdc).mint(deployer, seedLiquidity);
            MockUSDC(usdc).approve(deployment.market, seedLiquidity);
            AvairaCreditMarket(deployment.market).fundLiquidity(seedLiquidity);
        }

        vm.stopBroadcast();

        _writeDeployment(
            deployment, admin, treasury, registrationBond, minStake, minScore, challengeWindow, challengerBond, minGroundedPayment
        );
        _log(deployment);
    }

    function _writeDeployment(
        Deployment memory d,
        address admin,
        address treasury,
        uint256 registrationBond,
        uint256 minStake,
        uint8 minScore,
        uint64 challengeWindow,
        uint256 challengerBond,
        uint256 minGroundedPayment
    ) private {
        string memory objectKey = "avaira";
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeAddress(objectKey, "identityRegistry", d.identity);
        vm.serializeAddress(objectKey, "reputationRegistry", d.reputation);
        vm.serializeAddress(objectKey, "validationRegistry", d.validation);
        vm.serializeAddress(objectKey, "stakeRegistry", d.stake);
        vm.serializeAddress(objectKey, "intentVault", d.vault);
        vm.serializeAddress(objectKey, "creditMarket", d.market);
        vm.serializeAddress(objectKey, "settlementToken", d.usdc);
        vm.serializeAddress(objectKey, "complianceGate", d.complianceGate);
        vm.serializeAddress(objectKey, "cvaToken", d.cva);
        vm.serializeAddress(objectKey, "admin", admin);
        vm.serializeAddress(objectKey, "treasury", treasury);
        vm.serializeUint(objectKey, "registrationBond", registrationBond);
        vm.serializeUint(objectKey, "minStake", minStake);
        vm.serializeUint(objectKey, "minScore", minScore);
        vm.serializeUint(objectKey, "challengeWindow", challengeWindow);
        vm.serializeUint(objectKey, "challengerBond", challengerBond);
        vm.serializeUint(objectKey, "minGroundedPayment", minGroundedPayment);
        // Lower bound for event scans by the SDK/scorer/dashboard (logs cannot exist before this).
        vm.serializeUint(objectKey, "deploymentBlock", block.number);
        string memory json = vm.serializeString(
            objectKey, "agentRegistry", string.concat("eip155:", vm.toString(block.chainid), ":", vm.toString(d.identity))
        );

        // Canonical manifest location: the repository-root `deployments/` directory that the
        // SDK, dashboard, scorer, CVI service and demo scripts all read.
        string memory dir = vm.envOr("DEPLOYMENT_DIR", string("../deployments"));
        string memory path = string.concat(dir, "/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote deployment manifest to", path);
    }

    function _log(Deployment memory d) private pure {
        console2.log("AvairaIdentityRegistry   ", d.identity);
        console2.log("AvairaReputationRegistry ", d.reputation);
        console2.log("AvairaValidationRegistry ", d.validation);
        console2.log("AvairaStakeRegistry      ", d.stake);
        console2.log("AvairaIntentVault        ", d.vault);
        console2.log("AvairaCreditMarket       ", d.market);
        console2.log("AvairaComplianceGate     ", d.complianceGate);
        console2.log("AvairaCVA (CVI-gated)    ", d.cva);
        console2.log("settlement token         ", d.usdc);
    }
}
