/**
 * AVAIRA design tokens for imperative consumers.
 *
 * Tailwind covers markup (`text-avaira-primary`, `border-avaira-border`, ...),
 * but Recharts, inline style objects and SVG fills need literal values. Keeping
 * them here means a palette change is one edit instead of 77 hex codes spread
 * over ten files.
 *
 * The values mirror src/index.css:
 *   dark console  → :root
 *   light surface → .theme-marketing
 */

export const DARK = {
    app: '#08090C',
    card: '#101218',
    raised: '#161920',
    inset: '#0C0E12',
    textPrimary: '#ECEFF4',
    textSecondary: '#A8B0BF',
    textMuted: '#6F7987',
    accent: '#6E6BF2',
    accentHover: '#827FFF',
    violet: '#9A6BFF',
    success: '#34D399',
    warning: '#F5B544',
    danger: '#F45B69',
    info: '#60A5FA',
    hairline: '#22252E',
    hairlineStrong: '#343844',
};

export const LIGHT = {
    app: '#FFFFFF',
    card: '#FFFFFF',
    raised: '#FAFAFB',
    inset: '#F5F6F8',
    textPrimary: '#16181D',
    textSecondary: '#5B6068',
    textMuted: '#858B94',
    accent: '#5B5BD6',
    accentHover: '#4A4AC4',
    violet: '#7C5CF0',
    success: '#16A34A',
    warning: '#B47B04',
    danger: '#D62D3C',
    info: '#2563EB',
    hairline: '#E8E9EC',
    hairlineStrong: '#D5D8DD',
};

/** Categorical series colours for charts, in draw order. */
export const CHART_COLORS = [
    DARK.accent,
    DARK.success,
    DARK.violet,
    DARK.warning,
    DARK.danger,
    DARK.info,
];

/** Colours keyed by execution/activity status returned by the API. */
export const STATUS_COLORS = {
    completed: DARK.success,
    settled: DARK.success,
    active: DARK.success,
    approved: DARK.success,
    pending_validation: DARK.warning,
    pending: DARK.warning,
    paused: DARK.warning,
    slash: DARK.warning,
    warning: DARK.warning,
    rejected_deviation: DARK.danger,
    permit_invalid: DARK.danger,
    failed: DARK.danger,
    frozen: DARK.danger,
    banned: DARK.danger,
    suspended: DARK.danger,
    execution: DARK.accent,
    executing: DARK.accent,
    registered: DARK.info,
    freeze: DARK.info,
};

/**
 * Avaira Score bands → colour, shared by Reputation and Agent Registry.
 * Both scales seen in the codebase are covered: the credit-style ladder used by
 * core/reputation.py (A+ … D) and the AAA … CCC ladder the registry UI maps.
 */
export const GRADE_COLORS = {
    'A+': DARK.success,
    AAA: DARK.success,
    A: DARK.success,
    AA: DARK.accent,
    'B+': DARK.accent,
    BBB: DARK.warning,
    B: DARK.warning,
    BB: DARK.warning,
    CCC: DARK.danger,
    C: DARK.danger,
    D: DARK.danger,
};

export const CHART_GRID = DARK.hairline;

export const chartAxis = {
    stroke: DARK.textMuted,
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
};

export const chartTooltipStyle = {
    background: DARK.card,
    border: `1px solid ${DARK.hairlineStrong}`,
    borderRadius: 8,
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
    color: DARK.textPrimary,
    boxShadow: '0 12px 32px -16px rgba(0,0,0,0.7)',
};

/** Resolve a status string to a colour, with a neutral fallback. */
export const statusColor = (status) => STATUS_COLORS[String(status || '').toLowerCase()] || DARK.textMuted;

/** Resolve an Avaira Score grade to a colour, tolerant of "A+ (92)" formats. */
export const gradeColor = (grade) => {
    const key = String(grade || '').trim().toUpperCase();
    if (GRADE_COLORS[key]) return GRADE_COLORS[key];
    const base = key.charAt(0);
    return GRADE_COLORS[base] || DARK.textMuted;
};
