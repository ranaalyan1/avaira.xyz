// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvairaIdentityRegistry} from "avaira/core/AvairaIdentityRegistry.sol";
import {AgentStatus, SlashLevel} from "avaira/lib/AvairaTypes.sol";
import {GateReason} from "avaira/interfaces/IAvaira.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AvairaCreditMarket} from "avaira/core/AvairaCreditMarket.sol";
import {AvairaReputationRegistry} from "avaira/core/AvairaReputationRegistry.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";
import {NativeRejector} from "./mocks/Mocks.sol";

/// @title AvairaAuditRegressionsTest
/// @notice Regression tests for the 2026-10 deep audit. Every test below failed (or could
///         not even be written, because the required function did not exist) before the fix
///         in the same commit. They are grouped by finding id used in AUDIT.md.
contract AvairaAuditRegressionsTest is AvairaFixture {
    uint256 internal aliceAgent;
    uint256 internal agentId0; // nonce-free unique URI salt for helpers

    function setUp() public override {
        super.setUp();
        aliceAgent = _activeAgent(alice, MIN_STAKE, 80);
        // Grounded reviewers: only staked agents may review (see `giveFeedback`).
        _activeAgent(bob, MIN_STAKE, 70);
        _activeAgent(carol, MIN_STAKE, 70);
        _activeAgent(makeAddr("dave"), MIN_STAKE, 70);
    }

    /* ═════════════════════ finding A — terminal ban was not terminal ═════════════════════ */

    /// @dev A ban applied at the identity registry (the source of truth) used to leave
    ///      `stakeRegistry.isEligible()` true, so everything gated on eligibility — including
    ///      the credit market — kept treating a permanently banned agent as trustworthy.
    function test_Ban_AtIdentityRegistry_RevokesEligibility() public {
        assertTrue(stakeRegistry.isEligible(aliceAgent), "pre: eligible");

        vm.prank(owner);
        identity.banAgent(aliceAgent, "terminal ban");

        assertTrue(identity.isBanned(aliceAgent), "identity records the ban");
        assertFalse(stakeRegistry.isEligible(aliceAgent), "eligibility must die with the ban");
        assertFalse(stakeRegistry.isEligible(alice), "the address overload agrees");
    }

    /// @dev A banned agent used to sail through `IntentVault.checkGate` — the pre-execution
    ///      gate the whole safety story rests on.
    function test_Ban_AtIdentityRegistry_BlocksTheGate() public {
        (bool allowedBefore,,) = vault.checkGate(aliceAgent);
        assertTrue(allowedBefore, "pre: gate open");

        vm.prank(owner);
        identity.banAgent(aliceAgent, "terminal ban");

        (bool allowed, uint8 score, GateReason reason) = vault.checkGate(aliceAgent);
        assertFalse(allowed, "a banned agent must never pass the gate");
        assertEq(uint256(reason), uint256(GateReason.BANNED), "reason is BANNED");
        assertEq(score, 80, "score is still reported for observability");
    }

    /// @dev Bans propagated *through* the stake registry (the enforcer path) must keep
    ///      working exactly as before.
    function test_Ban_ThroughStakeRegistry_StillBlocksBothLayers() public {
        vm.prank(address(vault));
        stakeRegistry.slashAgent(aliceAgent, SlashLevel.BAN, address(0), bytes32(0), "enforcer ban");

        assertTrue(identity.isBanned(aliceAgent), "enforcer propagated the ban");
        assertFalse(stakeRegistry.isEligible(aliceAgent));
        (, , GateReason reason) = vault.checkGate(aliceAgent);
        assertEq(uint256(reason), uint256(GateReason.BANNED));
    }

    /// @dev A banned agent used to be able to keep anchoring outcomes through the vault.
    function test_Ban_BlocksAttestation() public {
        bytes32 intentHash = keccak256("intent-ban");
        vm.prank(alice);
        vault.commitIntent(aliceAgent, intentHash, _envelope(10e6, "research", uint64(block.timestamp + 1 hours)));

        vm.prank(owner);
        identity.banAgent(aliceAgent, "terminal ban");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.AgentIsBanned.selector, aliceAgent));
        vault.attestOutcome(aliceAgent, intentHash, keccak256("outcome"), bytes32(0));
    }

    /// @dev Terminal means terminal: no new collateral, and no exit-to-escape-accountability.
    function test_Ban_BlocksStakeAndUnstake() public {
        vm.prank(owner);
        identity.banAgent(aliceAgent, "terminal ban");

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.AgentIsBanned.selector, aliceAgent));
        stakeRegistry.stake(aliceAgent, 1e6);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.AgentIsBanned.selector, aliceAgent));
        stakeRegistry.unstake(aliceAgent, 1e6);
        vm.stopPrank();
    }

    /* ═════════════════ B — a slash-frozen agent could still draw credit ══════════════════ */

    /// @dev `borrow` only checked for a BAN, so a SUSPENDED (slash ladder level 2) or
    ///      under-staked agent could keep borrowing against a frozen reputation.
    function test_SuspendedAgent_CannotBorrow() public {
        vm.prank(alice);
        market.depositCollateral(aliceAgent, 500e6);

        // Pre: healthy agent borrows fine.
        vm.prank(alice);
        market.borrow(aliceAgent, 50e6);

        // Suspension (level 2) revokes eligibility but is not a ban.
        vm.prank(address(vault));
        stakeRegistry.slashAgent(aliceAgent, SlashLevel.SUSPENSION, address(0), bytes32(0), "envelope deviation");
        assertEq(uint256(stakeRegistry.statusOf(aliceAgent)), uint256(AgentStatus.SUSPENDED));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                AvairaCreditMarket.AgentNotEligibleForCredit.selector, aliceAgent, AgentStatus.SUSPENDED
            )
        );
        market.borrow(aliceAgent, 10e6);
    }

    /// @dev Falling below the minimum stake freezes new credit too.
    function test_UnderStakedAgent_CannotBorrow() public {
        vm.prank(alice);
        market.depositCollateral(aliceAgent, 500e6);

        vm.prank(alice);
        stakeRegistry.unstake(aliceAgent, MIN_STAKE - 1);

        assertFalse(stakeRegistry.isEligible(aliceAgent), "pre: under-staked");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                AvairaCreditMarket.AgentNotEligibleForCredit.selector, aliceAgent, AgentStatus.PENDING
            )
        );
        market.borrow(aliceAgent, 10e6);
    }

    /* ════════════════════ D — collateral had no exit door ════════════════════════════════ */

    /// @dev Idle collateral is the agent's own capital; it must be withdrawable.
    function test_WithdrawCollateral_FreesIdleCapital() public {
        vm.startPrank(alice);
        market.depositCollateral(aliceAgent, 300e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 - 300e6);

        market.withdrawCollateral(aliceAgent, 300e6);
        vm.stopPrank();

        assertEq(market.collateral(aliceAgent), 0);
        assertEq(usdc.balanceOf(alice), 10_000e6, "capital returned in full");
    }

    /// @dev A withdrawal that would leave the debt under-collateralised must revert — the
    ///      new exit door must not become a way to walk away from a live loan.
    function test_WithdrawCollateral_RevertsWhenItWouldUncollateraliseDebt() public {
        vm.startPrank(alice);
        market.depositCollateral(aliceAgent, 150e6); // 80 → tier A (110%)
        market.borrow(aliceAgent, 100e6); // needs 110e6 locked
        vm.stopPrank();

        uint256 required = (uint256(100e6) * market.collateralRatioBps(aliceAgent)) / market.BPS();
        assertEq(required, 110e6, "tier A ratio");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.CollateralTooSmall.selector, required, 109e6));
        market.withdrawCollateral(aliceAgent, 41e6);

        // Exactly the free part (150 − 110) may leave.
        vm.prank(alice);
        market.withdrawCollateral(aliceAgent, 40e6);
        assertEq(market.collateral(aliceAgent), 110e6);
    }

    /// @dev A score downgrade shrinks the free margin, and the check must follow the tier.
    function test_WithdrawCollateral_FollowsScoreTier() public {
        vm.startPrank(alice);
        market.depositCollateral(aliceAgent, 150e6);
        market.borrow(aliceAgent, 100e6);
        vm.stopPrank();

        // Score collapses to 0 → premium tier (150%): 150e6 of collateral is now needed.
        _setScore(aliceAgent, 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaCreditMarket.CollateralTooSmall.selector, 150e6, 149e6)
        );
        market.withdrawCollateral(aliceAgent, 1e6);
    }

    function test_WithdrawCollateral_RevertsAboveBalanceAndForStrangers() public {
        vm.prank(alice);
        market.depositCollateral(aliceAgent, 100e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.InsufficientCollateral.selector, 100e6, 101e6));
        market.withdrawCollateral(aliceAgent, 101e6);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.NotAgentOperator.selector, aliceAgent, bob));
        market.withdrawCollateral(aliceAgent, 1e6);

        vm.prank(alice);
        vm.expectRevert(AvairaCreditMarket.ZeroAmount.selector);
        market.withdrawCollateral(aliceAgent, 0);
    }

    /* ══════════════ E1 — escrowed refund could be bricked by the recipient ═══════════════ */

    /// @dev `withdraw()` used to revert when the push failed, permanently locking the escrow
    ///      of a recipient that can never accept native value. It now re-escrows instead.
    function test_Withdraw_ReEscrowsWhenPushStillFails() public {
        NativeRejector rejector = new NativeRejector();
        vm.deal(address(rejector), 1 ether);
        vm.prank(address(rejector));
        uint256 agentId = identity.register{value: REGISTRATION_BOND + 0.1 ether}(
            string.concat("ipfs://agent/rejector-", vm.toString(agentId0))
        );

        vm.prank(address(rejector));
        registry_withdraw_expectReEscrow(rejector);

        assertEq(identity.pendingWithdrawals(address(rejector)), 0.1 ether, "still claimable");
        assertEq(address(identity).balance, REGISTRATION_BOND + 0.1 ether, "no value lost");
        assertEq(identity.totalBonds(), REGISTRATION_BOND);
        vm.prank(address(rejector));
        identity.exitAgent(agentId);
    }

    function registry_withdraw_expectReEscrow(NativeRejector rejector) private {
        uint256 before = identity.pendingWithdrawals(address(rejector));
        assertGt(before, 0, "pre: escrow exists");
        identity.withdraw();
        assertEq(identity.pendingWithdrawals(address(rejector)), before, "credit restored");
    }

    /* ══════════════ E2 — setEnforcer(0) silently disabled ban propagation ═══════════════ */

    function test_SetEnforcer_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AvairaIdentityRegistry.NotAuthorized.selector, address(0)));
        identity.setEnforcer(address(0));

        vm.prank(owner);
        identity.setEnforcer(address(stakeRegistry));
        assertEq(identity.enforcer(), address(stakeRegistry), "still re-pointable");
    }

    /* ═══════════ F — unbounded feedback value could brick getSummary readers ═════════════ */

    function test_GiveFeedback_RejectsOutOfRangeValue() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaReputationRegistry.ValueOutOfRange.selector, type(int128).max)
        );
        reputation.giveFeedback(aliceAgent, type(int128).max, 18, "uptime", "", "", "", bytes32(0));

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaReputationRegistry.ValueOutOfRange.selector, type(int128).min)
        );
        reputation.giveFeedback(aliceAgent, type(int128).min, 0, "uptime", "", "", "", bytes32(0));
    }

    /// @dev With the bound in place, the scaled sum in `getSummary` can no longer overflow —
    ///      which used to make the read revert (a denial of service on every consumer).
    function test_GetSummary_SurvivesLargestAcceptedValues() public {
        int128 max = 1e20;
        address[] memory reviewers = new address[](3);
        reviewers[0] = bob;
        reviewers[1] = carol;
        reviewers[2] = makeAddr("dave");

        for (uint256 i; i < reviewers.length; ++i) {
            vm.prank(reviewers[i]);
            reputation.giveFeedback(aliceAgent, max, 18, "uptime", "", "", "", bytes32(0));
        }

        (uint64 count, int128 summary, uint8 decimals) = reputation.getSummary(aliceAgent, reviewers, "uptime");
        assertEq(count, 3, "all reviews counted");
        assertEq(summary, max, "average of identical maxima");
        assertEq(decimals, 18);
    }

    function test_GiveFeedback_RejectsOversizedStrings() public {
        string memory tooLong = new string(513);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.StringTooLong.selector, "endpoint", 513));
        reputation.giveFeedback(aliceAgent, 1e6, 6, "uptime", "", tooLong, "", bytes32(0));

        // 512 is accepted.
        vm.prank(bob);
        reputation.giveFeedback(aliceAgent, 1e6, 6, "uptime", "", new string(512), "", bytes32(0));
    }

    /* ══════════════════════════════ helpers ═══════════════════════════════════════════════ */

}
