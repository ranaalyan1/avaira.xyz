// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {AvairaIdentityRegistry} from "avaira/core/AvairaIdentityRegistry.sol";
import {AvairaReputationRegistry} from "avaira/core/AvairaReputationRegistry.sol";
import {AvairaValidationRegistry} from "avaira/core/AvairaValidationRegistry.sol";
import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {AvairaCreditMarket} from "avaira/core/AvairaCreditMarket.sol";
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
contract DeployAvaira is Script {
    struct Deployment {
        address identity;
        address reputation;
        address validation;
        address stake;
        address vault;
        address market;
        address usdc;
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

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
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
        console2.log("settlement token         ", d.usdc);
    }
}
