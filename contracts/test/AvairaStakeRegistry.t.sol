// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AgentStatus, SlashLevel} from "avaira/lib/AvairaTypes.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @title AvairaStakeRegistryTest — Component 5 (staking, slashing, eligibility)
contract AvairaStakeRegistryTest is AvairaFixture {
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        agentId = _register(alice);
    }

    /* --------------------------------- staking -------------------------------- */

    function test_Stake_LifecyclePendingToActive() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE - 1);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.PENDING));

        vm.prank(alice);
        stakeRegistry.stake(agentId, 1);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.ACTIVE));
        assertEq(stakeRegistry.stakeOf(agentId), MIN_STAKE);
        assertEq(stakeRegistry.accountStake(alice), MIN_STAKE);
        assertEq(stakeRegistry.stakerOf(agentId), alice);
        assertEq(stakeRegistry.primaryAgentOf(alice), agentId);
        assertEq(usdc.balanceOf(address(stakeRegistry)), MIN_STAKE);
    }

    function test_Stake_RevertsForNonOperatorAndZeroAmount() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.NotAgentOperator.selector, agentId, bob));
        stakeRegistry.stake(agentId, MIN_STAKE);

        vm.prank(alice);
        vm.expectRevert(AvairaStakeRegistry.ZeroAmount.selector);
        stakeRegistry.stake(agentId, 0);
    }

    function test_Stake_UnknownAgentReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.AgentIsNotRegistered.selector, 999));
        stakeRegistry.stake(999, MIN_STAKE);
    }

    function test_Stake_SecondStakerIsRejected() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE);

        // Bob is neither owner nor operator, so he cannot even try.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.NotAgentOperator.selector, agentId, bob));
        stakeRegistry.stake(agentId, MIN_STAKE);
    }

    function test_Unstake_MovesStatusDownAndReturnsFunds() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE);

        uint256 balanceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        stakeRegistry.unstake(agentId, 1);

        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.PENDING));
        assertEq(usdc.balanceOf(alice), balanceBefore + 1);
        assertEq(stakeRegistry.accountStake(alice), MIN_STAKE - 1);

        vm.prank(alice);
        stakeRegistry.unstake(agentId, MIN_STAKE - 1);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.NONE));
        assertEq(stakeRegistry.accountStake(alice), 0);
    }

    function test_Unstake_RevertsForNonStakerAndOverdraft() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.NotStaker.selector, agentId, bob));
        stakeRegistry.unstake(agentId, 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.InsufficientStake.selector, MIN_STAKE, MIN_STAKE + 1));
        stakeRegistry.unstake(agentId, MIN_STAKE + 1);
    }

    function test_VoluntaryExit_RefundsEverything() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE * 2);

        uint256 balanceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        stakeRegistry.voluntaryExit(agentId);

        assertEq(usdc.balanceOf(alice), balanceBefore + MIN_STAKE * 2);
        assertEq(stakeRegistry.stakeOf(agentId), 0);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.NONE));
        assertEq(stakeRegistry.primaryAgentOf(alice), 0);
    }

    /* -------------------------------- slashing -------------------------------- */

    function test_Slash_WarningTakesTenPercentAndSplitsBounty() public {
        // Over-collateralised so a 10% warning keeps the agent above the eligibility floor.
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE * 2);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 challengerBefore = usdc.balanceOf(carol);

        vm.prank(owner);
        uint256 slashed = stakeRegistry.slashAgent(agentId, SlashLevel.WARNING, carol, keccak256("ev"), "late delivery");

        uint256 expected = MIN_STAKE / 5; // 10% of 2x MIN_STAKE
        assertEq(slashed, expected);
        assertEq(usdc.balanceOf(carol), challengerBefore + expected / 2, "challenger bounty");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + expected / 2, "protocol share");
        assertEq(stakeRegistry.stakeOf(agentId), MIN_STAKE * 2 - expected);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.ACTIVE), "still above min stake");
        assertEq(stakeRegistry.slashCount(agentId), 1);
        assertEq(stakeRegistry.slashedTotal(agentId), expected);
    }

    /// @dev A warning on a bare-minimum stake drops the agent below the eligibility floor,
    ///      so it must re-collateralise before it can transact again.
    function test_Slash_WarningBelowMinStakeDowngradesToPending() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.ACTIVE));

        vm.prank(owner);
        stakeRegistry.slashAgent(agentId, SlashLevel.WARNING, address(0), keccak256("ev"), "warning");
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.PENDING));
        assertFalse(stakeRegistry.isEligible(agentId));

        // Topping back up restores eligibility without waiting for any cooldown.
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE / 10 + 1);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.ACTIVE));
    }

    function test_Slash_SuspensionHalvesStakeAndStartsCooldown() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE * 2);

        vm.prank(owner);
        uint256 slashed = stakeRegistry.slashAgent(agentId, SlashLevel.SUSPENSION, carol, keccak256("dev"), "deviation");

        assertEq(slashed, MIN_STAKE);
        assertEq(stakeRegistry.stakeOf(agentId), MIN_STAKE);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.SUSPENDED));
        assertEq(stakeRegistry.suspendedUntil(agentId), uint64(block.timestamp) + 24 hours);

        // Suspended agents cannot unstake or exit — no escape hatch mid-punishment.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.AgentIsSuspended.selector, agentId));
        stakeRegistry.unstake(agentId, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.AgentIsSuspended.selector, agentId));
        stakeRegistry.voluntaryExit(agentId);

        // Cooldown gates reactivation.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaStakeRegistry.SuspensionCooldownActive.selector, uint64(block.timestamp) + 24 hours)
        );
        stakeRegistry.reactivate(agentId);

        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(alice);
        stakeRegistry.reactivate(agentId);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.ACTIVE));
    }

    function test_Slash_BanForfeitsEverythingAndBansIdentity() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE * 3);
        _setScore(agentId, 90);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(owner);
        uint256 slashed = stakeRegistry.slashAgent(agentId, SlashLevel.BAN, carol, keccak256("dev"), "envelope breach");

        assertEq(slashed, MIN_STAKE * 3, "BAN takes 100%");
        assertEq(stakeRegistry.stakeOf(agentId), 0);
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.BANNED));
        assertTrue(identity.isBanned(agentId), "ban must propagate to the identity registry");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + (MIN_STAKE * 3) / 2, "protocol keeps its half");

        // Terminal: no staking, no exit.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.AgentIsBanned.selector, agentId));
        stakeRegistry.stake(agentId, MIN_STAKE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.AgentIsBanned.selector, agentId));
        stakeRegistry.voluntaryExit(agentId);
    }

    function test_Slash_OnlySlasherRole() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE);

        uint256 slasherRole = uint256(stakeRegistry.SLASHER_ROLE());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaStakeRegistry.NotSlasher.selector, bob));
        stakeRegistry.slashAgent(agentId, SlashLevel.WARNING, address(0), bytes32(0), "rogue");
        assertEq(slasherRole, uint256(keccak256("AVAIRA_SLASHER_ROLE")));

        vm.prank(owner);
        stakeRegistry.setSlasher(bob, true);
        vm.prank(bob);
        stakeRegistry.slashAgent(agentId, SlashLevel.WARNING, address(0), bytes32(0), "authorised");
        assertEq(stakeRegistry.slashCount(agentId), 1);
    }

    /* ------------------------------- eligibility ------------------------------ */

    function test_IsEligible_RequiresStakeScoreAndStatus() public {
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE);
        assertFalse(stakeRegistry.isEligible(agentId), "no score yet");

        _setScore(agentId, MIN_SCORE - 1);
        assertFalse(stakeRegistry.isEligible(agentId), "score below floor");
        (, uint8 score,) = vault.checkGate(agentId);
        assertEq(score, MIN_SCORE - 1);

        _setScore(agentId, MIN_SCORE);
        assertTrue(stakeRegistry.isEligible(agentId));
        assertTrue(stakeRegistry.isEligible(alice), "address overload follows primary agent");

        // Dropping below min stake removes eligibility.
        vm.prank(alice);
        stakeRegistry.unstake(agentId, 1);
        assertFalse(stakeRegistry.isEligible(agentId));

        vm.prank(bob);
        assertFalse(stakeRegistry.isEligible(bob), "wallets with no agent are never eligible");
    }

    function test_IsStakedReviewer_TracksAccountStake() public {
        assertFalse(stakeRegistry.isStakedReviewer(alice));
        vm.prank(alice);
        stakeRegistry.stake(agentId, MIN_STAKE);
        assertTrue(stakeRegistry.isStakedReviewer(alice));
        vm.prank(alice);
        stakeRegistry.unstake(agentId, 1);
        assertFalse(stakeRegistry.isStakedReviewer(alice), "reviewer rights are capital-backed");
    }

    function test_ScoreReader_IsConfigurableByAdmin() public {
        vm.prank(owner);
        stakeRegistry.setScoreReader(address(reputation));
        assertEq(stakeRegistry.scoreOf(agentId), 0);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, bytes32(0))
        );
        stakeRegistry.setMinStake(1);

        vm.prank(owner);
        stakeRegistry.setMinScore(75);
        assertEq(stakeRegistry.minScore(), 75);
    }

    /* ---------------------------------- fuzz ---------------------------------- */

    /// @dev The slash math must conserve value for every stake/level combination.
    function testFuzz_Slash_ConservesValue(uint96 stakeSeed, uint8 levelSeed) public {
        uint256 amount = uint256(stakeSeed) % (MIN_STAKE * 100) + 1;
        vm.prank(alice);
        stakeRegistry.stake(agentId, amount);

        SlashLevel level = SlashLevel(uint8(bound(levelSeed, 1, 3)));
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 challengerBefore = usdc.balanceOf(carol);
        uint256 expectedPct = level == SlashLevel.WARNING ? 10 : level == SlashLevel.SUSPENSION ? 50 : 100;
        uint256 expectedSlashed = (amount * expectedPct) / 100;

        vm.prank(owner);
        uint256 slashed = stakeRegistry.slashAgent(agentId, level, carol, bytes32(0), "fuzz");

        assertEq(slashed, expectedSlashed);
        uint256 bounty = slashed / 2;
        assertEq(usdc.balanceOf(carol) - challengerBefore, bounty, "challenger gets half");
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, slashed - bounty, "treasury gets the rest");

        if (level == SlashLevel.BAN) {
            assertEq(stakeRegistry.stakeOf(agentId), 0, "BAN leaves no stake");
            assertEq(usdc.balanceOf(address(stakeRegistry)), 0, "no dust left behind");
        } else {
            assertEq(stakeRegistry.stakeOf(agentId) + slashed, amount, "stake + slashed == original");
            assertEq(usdc.balanceOf(address(stakeRegistry)), amount - slashed);
        }
    }

    function testFuzz_StakeUnstake_NeverCreatesValue(uint96 stakeSeed, uint96 unstakeSeed) public {
        uint256 amount = uint256(stakeSeed) % (MIN_STAKE * 50) + 1;
        // Leave a remainder so the position stays open for the voluntary exit below.
        uint256 pull = uint256(unstakeSeed) % amount;

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        stakeRegistry.stake(agentId, amount);
        vm.prank(alice);
        stakeRegistry.unstake(agentId, pull);
        vm.prank(alice);
        stakeRegistry.voluntaryExit(agentId);

        assertEq(usdc.balanceOf(alice), aliceBefore, "round trip is value-neutral");
        assertEq(usdc.balanceOf(address(stakeRegistry)), 0);
    }
}
