// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ScoreLib — the Avaira Score definition, frozen onchain.
/// @notice The score itself is computed offchain by the scorer service (Python) from
///         objective settlement/validation data, then posted onchain. What this library
///         guarantees is that the *definition* is public, versioned and identical for
///         every consumer: same weights, same grades, same rounding.
///
///         Weights (bps, 10_000 = 100%):
///             SuccessRate     3000
///             Consistency     2000
///             SlashHistory    2000
///             VolumeHandled   1500
///             AgeOnNetwork    1000
///             AppealWinRate    500
library ScoreLib {
    uint16 internal constant BPS = 10_000;

    uint16 internal constant W_SUCCESS_RATE = 3000;
    uint16 internal constant W_CONSISTENCY = 2000;
    uint16 internal constant W_SLASH_HISTORY = 2000;
    uint16 internal constant W_VOLUME_HANDLED = 1500;
    uint16 internal constant W_AGE_ON_NETWORK = 1000;
    uint16 internal constant W_APPEAL_WIN_RATE = 500;

    uint8 internal constant GRADE_A_PLUS = 90;
    uint8 internal constant GRADE_A = 80;
    uint8 internal constant GRADE_B = 70;
    uint8 internal constant GRADE_C = 60;

    /// @notice Maximum age of a posted score before consumers should treat it as stale.
    uint64 internal constant SCORE_FRESHNESS = 24 hours;

    /// @notice The six weights, in the order documented in the README and the scorer.
    function weights() internal pure returns (uint16[6] memory w) {
        w = [W_SUCCESS_RATE, W_CONSISTENCY, W_SLASH_HISTORY, W_VOLUME_HANDLED, W_AGE_ON_NETWORK, W_APPEAL_WIN_RATE];
    }

    /// @notice Letter grade for a 0–100 score. A+ (90–100), A (80–89), B (70–79), C (60–69), D (<60).
    function grade(uint8 score) internal pure returns (string memory) {
        if (score >= GRADE_A_PLUS) return "A+";
        if (score >= GRADE_A) return "A";
        if (score >= GRADE_B) return "B";
        if (score >= GRADE_C) return "C";
        return "D";
    }

    /// @notice True when `score` is at or above the eligibility floor.
    function isInvestmentGrade(uint8 score, uint8 floor) internal pure returns (bool) {
        return score >= floor;
    }
}
