// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvairaCreditMarket} from "avaira/core/AvairaCreditMarket.sol";
import {SlashLevel} from "avaira/lib/AvairaTypes.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @title AvairaCreditMarketTest — Component 6 (score-gated credit)
/// @dev Proves the end of the thesis: a *slash-backed* reputation number becomes
///      cheaper capital. Same agent, same collateral, different score → different line.
contract AvairaCreditMarketTest is AvairaFixture {
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        agentId = _activeAgent(alice, MIN_STAKE, 0);
    }

    /* ---------------------------------- pricing -------------------------------- */

    function test_CollateralRatio_TracksScoreTiers() public {
        assertEq(market.collateralRatioBps(agentId), market.TIER_C_RATIO_BPS(), "ungraded is 150%");

        _setScore(agentId, 55);
        assertEq(market.collateralRatioBps(agentId), market.TIER_C_RATIO_BPS());

        _setScore(agentId, 60);
        assertEq(market.collateralRatioBps(agentId), market.TIER_B_RATIO_BPS(), "C grade is 125%");

        _setScore(agentId, 79);
        assertEq(market.collateralRatioBps(agentId), market.TIER_B_RATIO_BPS());

        _setScore(agentId, 80);
        assertEq(market.collateralRatioBps(agentId), market.TIER_A_RATIO_BPS(), "A grade is 110%");

        _setScore(agentId, 100);
        assertEq(market.collateralRatioBps(agentId), market.TIER_A_RATIO_BPS());
    }

    function test_Borrow_EnforcesTierCollateral() public {
        _setScore(agentId, 85); // 110%
        vm.prank(alice);
        market.depositCollateral(agentId, 110e6);

        assertEq(market.borrowCapacity(agentId), 100e6);

        // 101 USDC of debt needs 111.1 USDC of collateral at A-grade rates.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.InsufficientCollateral.selector, 111_100_000, 110e6));
        market.borrow(agentId, 101e6);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        market.borrow(agentId, 100e6);
        assertEq(market.debt(agentId), 100e6);
        assertEq(market.borrowCapacity(agentId), 0);
        assertEq(usdc.balanceOf(alice), aliceBefore + 100e6, "the line pays out in full");
    }

    function test_Borrow_UngradedAgentPaysForItAt150Percent() public {
        vm.prank(alice);
        market.depositCollateral(agentId, 150e6);
        assertEq(market.borrowCapacity(agentId), 100e6, "150% collateral buys a 100 USDC line");

        // The same 150 USDC of collateral now supports 136.36 USDC at A-grade rates.
        _setScore(agentId, 92);
        assertEq(market.borrowCapacity(agentId), (uint256(150e6) * 10_000) / market.TIER_A_RATIO_BPS());
        assertGt(market.borrowCapacity(agentId), 100e6, "a better score buys a bigger line");
    }

    function test_Borrow_RequiresOperatorAndLiquidity() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.NotAgentOperator.selector, agentId, bob));
        market.depositCollateral(agentId, 100e6);

        // The owner may borrow its own line, but a stranger never can.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.NotAgentOperator.selector, agentId, carol));
        market.borrow(agentId, 1e6);

        // Owner with no collateral yet cannot borrow at all.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.InsufficientCollateral.selector, 1_500_000, 0));
        market.borrow(agentId, 1e6);
    }

    function test_Borrow_RevertsWhenPoolIsDrained() public {
        // A whale borrows almost the whole pool at 150%.
        usdc.mint(bob, 1_000_000e6);
        uint256 whaleAgent = _activeAgent(bob, MIN_STAKE, 0);
        vm.startPrank(bob);
        market.depositCollateral(whaleAgent, 750_000e6);
        market.borrow(whaleAgent, 499_000e6);
        vm.stopPrank();

        vm.prank(alice);
        market.depositCollateral(agentId, 150e6);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaCreditMarket.InsufficientLiquidity.selector, 1_000e6, 2_000e6)
        );
        market.borrow(agentId, 2_000e6);
    }

    /* --------------------------------- defaults -------------------------------- */

    function test_ScoreDowngrade_MakesPositionLiquidatable() public {
        _setScore(agentId, 88);
        vm.prank(alice);
        market.depositCollateral(agentId, 110e6);
        vm.prank(alice);
        market.borrow(agentId, 100e6);
        assertFalse(market.isLiquidatable(agentId), "110% is enough at A grade");

        // A slash drops the agent from A to B: the same loan now needs 125%.
        _setScore(agentId, 70);
        assertTrue(market.isLiquidatable(agentId), "score downgrade tightens the line");

        uint256 liquidatorBefore = usdc.balanceOf(carol);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(carol);
        market.liquidate(agentId);

        assertEq(market.debt(agentId), 0);
        assertEq(market.collateral(agentId), 0, "position fully disposed of");
        // 100 USDC of debt + 5% liquidation incentive = 105 seized; 5 returns to the borrower.
        assertEq(usdc.balanceOf(carol), liquidatorBefore + 5e6, "liquidator earns the 5% incentive");
        assertEq(usdc.balanceOf(alice), aliceBefore + 5e6, "the rest of the collateral is returned");
    }

    function test_Liquidate_RevertsWhenHealthy() public {
        _setScore(agentId, 88);
        vm.prank(alice);
        market.depositCollateral(agentId, 200e6);
        vm.prank(alice);
        market.borrow(agentId, 100e6);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.NotLiquidatable.selector, agentId, 20_000, 11_000));
        market.liquidate(agentId);
    }

    /* ---------------------------------- repay ---------------------------------- */

    function test_Repay_ReducesDebtAndFreesCapacity() public {
        _setScore(agentId, 88);
        vm.startPrank(alice);
        market.depositCollateral(agentId, 110e6);
        market.borrow(agentId, 100e6);
        usdc.approve(address(market), type(uint256).max);
        market.repay(agentId, 40e6);
        vm.stopPrank();

        assertEq(market.debt(agentId), 60e6);
        assertEq(market.borrowCapacity(agentId), 40e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.RepayTooMuch.selector, 60e6, 61e6));
        market.repay(agentId, 61e6);
    }

    function test_BannedAgent_IsCutOff() public {
        _setScore(agentId, 88);
        vm.prank(alice);
        market.depositCollateral(agentId, 200e6);

        vm.prank(owner);
        stakeRegistry.slashAgent(agentId, SlashLevel.BAN, address(0), bytes32(0), "terminal");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaCreditMarket.AgentIsBanned.selector, agentId));
        market.borrow(agentId, 1e6);
    }

    /* ---------------------------------- fuzz ----------------------------------- */

    /// @dev No borrow path may ever exceed the score-implied collateral requirement.
    function testFuzz_Borrow_NeverExceedsTierRequirement(uint96 collateralSeed, uint96 borrowSeed, uint8 scoreSeed) public {
        uint256 posted = bound(uint256(collateralSeed), 1e6, 5_000e6);
        uint8 score = uint8(bound(scoreSeed, 0, 100));
        _setScore(agentId, score);

        vm.prank(alice);
        market.depositCollateral(agentId, posted);

        uint256 capacity = market.borrowCapacity(agentId);
        vm.assume(capacity > 0);
        uint256 amount = bound(uint256(borrowSeed), 1, capacity);

        vm.prank(alice);
        market.borrow(agentId, amount);

        uint256 ratio = market.collateralRatioBps(agentId);
        assertLe((market.debt(agentId) * ratio) / market.BPS(), posted, "debt must stay inside the tier requirement");
    }
}
