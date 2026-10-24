/**
 * Console navigation data — one definition, read by the sidebar, the page
 * header and the command palette.
 *
 * Keeping it here (instead of inside Layout) means the palette can list the
 * same destinations without importing the layout component, and adding a page
 * once makes it reachable from the sidebar, the ⌘K palette and the header.
 */
import {
  LayoutDashboard, UserCheck, Workflow, ShieldOff, Wallet, TrendingUp, BookOpen, Users,
  ShieldCheck, Home, Layers, BookText, Receipt, LogIn,
} from "lucide-react";

export const NAV_GROUPS = [
  {
    label: "Monitor",
    items: [
      { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, meta: "Protocol telemetry and live state" },
      { path: "/agents", label: "Agent registry", icon: UserCheck, meta: "Registration, risk envelopes, and status control" },
      { path: "/executions", label: "Execution flow", icon: Workflow, meta: "Lifecycle traces and trust verification" },
      { path: "/reputation", label: "Reputation", icon: TrendingUp, meta: "Score engine, rank movement, and trust data" },
    ],
  },
  {
    label: "Control",
    items: [
      { path: "/underwriters", label: "Underwriters", icon: Users, meta: "Mission markets and underwriting coverage" },
      { path: "/freeze", label: "Freeze / slash", icon: ShieldOff, meta: "Policy enforcement, freeze and slash actions" },
      { path: "/treasury", label: "Treasury", icon: Wallet, meta: "Fee capture, split accounting, and treasury flow" },
      { path: "/sdk", label: "SDK docs", icon: BookOpen, meta: "Developer integration docs and references" },
    ],
  },
  {
    label: "Evidence",
    items: [
      { path: "/hardening-report", label: "Hardening report", icon: ShieldCheck, meta: "Sample agent hardening transcript" },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

/** Path -> subtitle for the console header. */
export const PAGE_META = NAV_ITEMS.reduce((acc, item) => {
  acc[item.path] = item.meta;
  return acc;
}, {});

/**
 * The public pages, so ⌘K can cross the console/marketing boundary. These are
 * real routes (see App.js), not marketing anchors.
 */
export const PUBLIC_ITEMS = [
  { path: "/", label: "Home", icon: Home, meta: "The boundary — landing page" },
  { path: "/gate", label: "Gate mechanics", icon: Layers, meta: "Four planes, nine refusal codes" },
  { path: "/score", label: "The score", icon: TrendingUp, meta: "Weights, bands and penalties" },
  { path: "/evidence", label: "Evidence", icon: Receipt, meta: "Deployments and verification receipts" },
  { path: "/ledger", label: "Evidence ledger", icon: BookText, meta: "Reproducible reports and targets" },
  { path: "/docs", label: "Docs and SDK", icon: BookOpen, meta: "Integration guide" },
  { path: "/login", label: "Sign in", icon: LogIn, meta: "Session and identity" },
];

/**
 * Accept only a same-origin absolute path from `?redirect=`.
 *
 * The login page hands this value to the OAuth start URL, so an unchecked
 * `redirect` would let a crafted link (`/login?redirect=https://evil.example`)
 * bounce a freshly authenticated visitor off-site. Anything that is not a
 * single-slash path falls back to the console.
 */
export const safeInternalPath = (value, fallback = "/dashboard") => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
};

/** Everything the palette can navigate to, in display order. */
export const PALETTE_ITEMS = [
  ...NAV_ITEMS.map((item) => ({ ...item, group: "Console" })),
  ...PUBLIC_ITEMS.map((item) => ({ ...item, group: "Public pages" })),
];
