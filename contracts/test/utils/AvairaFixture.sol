// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AvairaIdentityRegistry} from "avaira/core/AvairaIdentityRegistry.sol";
import {AvairaReputationRegistry} from "avaira/core/AvairaReputationRegistry.sol";
import {AvairaValidationRegistry} from "avaira/core/AvairaValidationRegistry.sol";
import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {AvairaCreditMarket} from "avaira/core/AvairaCreditMarket.sol";
import {MockUSDC} from "avaira/tokens/MockUSDC.sol";
import {AgentStatus, RiskEnvelope} from "avaira/lib/AvairaTypes.sol";

/// @title AvairaFixture
/// @notice Deploys and wires the whole Avaira stack exactly the way the production
///         deploy script does, so tests exercise the real dependency graph.
abstract contract AvairaFixture is Test {
    // Economics used across the suite
    uint256 internal constant REGISTRATION_BOND = 0.05 ether;
    uint256 internal constant MIN_STAKE = 100e6; // 100 USDC
    uint8 internal constant MIN_SCORE = 60;
    uint64 internal constant CHALLENGE_WINDOW = 24 hours;
    uint256 internal constant CHALLENGER_BOND = 5e6; // 5 USDC
    uint256 internal constant MIN_GROUNDED_PAYMENT = 1e5; // 0.1 USDC

    AvairaIdentityRegistry internal identity;
    AvairaReputationRegistry internal reputation;
    AvairaValidationRegistry internal validation;
    AvairaStakeRegistry internal stakeRegistry;
    AvairaIntentVault internal vault;
    AvairaCreditMarket internal market;
    MockUSDC internal usdc;

    address internal owner = makeAddr("protocolOwner");
    address internal treasury = makeAddr("treasury");
    /// @dev Alice and Bob's keys are known so tests can produce real signatures.
    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal constant BOB_PK = 0xB0B;
    address internal alice = vm.addr(ALICE_PK);
    address internal bob = vm.addr(BOB_PK);
    /// @dev Carol's key is known so payment-grounded feedback can be signed for real.
    uint256 internal constant CAROL_PK = 0xCA401;
    address internal carol = vm.addr(CAROL_PK);

    function setUp() public virtual {
        usdc = new MockUSDC();
        identity = new AvairaIdentityRegistry(REGISTRATION_BOND, owner);
        reputation = new AvairaReputationRegistry(address(identity), address(0), address(usdc), owner);
        validation = new AvairaValidationRegistry(address(identity), owner);
        stakeRegistry = new AvairaStakeRegistry(
            address(usdc), address(identity), address(reputation), MIN_STAKE, MIN_SCORE, owner
        );
        vault = new AvairaIntentVault(address(identity), address(stakeRegistry), address(usdc), CHALLENGE_WINDOW, owner);
        market = new AvairaCreditMarket(address(usdc), address(stakeRegistry), address(identity), owner);

        vm.startPrank(owner);
        reputation.setScorerConfig(address(stakeRegistry), address(usdc), MIN_GROUNDED_PAYMENT);
        identity.setEnforcer(address(stakeRegistry));
        identity.setTreasury(treasury);
        stakeRegistry.setSlasher(address(vault), true);
        stakeRegistry.setTreasury(treasury);
        reputation.setTreasury(treasury);
        vault.setChallengerBond(CHALLENGER_BOND);
        vault.setTreasury(treasury);
        vm.stopPrank();

        // Seed the credit market so score-gated borrowing is testable everywhere.
        usdc.mint(owner, 1_000_000e6);
        vm.startPrank(owner);
        usdc.approve(address(market), type(uint256).max);
        market.fundLiquidity(500_000e6);
        vm.stopPrank();

        // Fund actors
        address[4] memory actors = [alice, bob, carol, makeAddr("dave")];
        for (uint256 i; i < actors.length; ++i) {
            usdc.mint(actors[i], 10_000e6);
            vm.deal(actors[i], 100 ether);
            vm.startPrank(actors[i]);
            usdc.approve(address(stakeRegistry), type(uint256).max);
            usdc.approve(address(vault), type(uint256).max);
            usdc.approve(address(reputation), type(uint256).max);
            usdc.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
    }

    /* --------------------------------- helpers -------------------------------- */

    function _register(address who) internal returns (uint256 agentId) {
        vm.prank(who);
        agentId = identity.register{value: REGISTRATION_BOND}(string.concat("ipfs://agent/", vm.toString(who)));
    }

    /// @notice Registers `who`, stakes `amount` and publishes a score — a fully ACTIVE agent.
    function _activeAgent(address who, uint256 amount, uint8 score) internal returns (uint256 agentId) {
        agentId = _register(who);
        vm.prank(who);
        stakeRegistry.stake(agentId, amount);
        _setScore(agentId, score);
    }

    function _setScore(uint256 agentId, uint8 score) internal {
        vm.prank(owner);
        reputation.postAvairaScore(agentId, score);
    }

    function _envelope(uint256 maxSpendUsd, string memory action, uint64 deadline)
        internal
        pure
        returns (RiskEnvelope memory envelope)
    {
        string[] memory actions = new string[](1);
        actions[0] = action;
        envelope = RiskEnvelope({maxSpendUsd: maxSpendUsd, allowedActions: actions, deadline: deadline});
    }

    function _envelope2(uint256 maxSpendUsd, string memory a, string memory b, uint64 deadline)
        internal
        pure
        returns (RiskEnvelope memory envelope)
    {
        string[] memory actions = new string[](2);
        actions[0] = a;
        actions[1] = b;
        envelope = RiskEnvelope({maxSpendUsd: maxSpendUsd, allowedActions: actions, deadline: deadline});
    }

    function _signTransferWithAuthorization(
        uint256 pk,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory signature) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    /// @notice Signs an EIP-3009 `ReceiveWithAuthorization` for the settlement token.
    /// @dev Used by payment-grounded feedback tests; the payer signs, the payee submits.
    function _signReceiveWithAuthorization(
        uint256 pk,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory signature) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        signature = abi.encodePacked(r, s, v);
    }
}
