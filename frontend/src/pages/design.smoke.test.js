/**
 * Design smoke test.
 *
 * The marketing site is seven routes and a console, and this file is the
 * contract between them and the rest of the repository: every documented
 * data-testid and anchor still has to render, the pixel scope has to wrap every
 * marketing page, the rendered art has to be described, and the two rules the
 * design settled on — no pricing surfaces, no emoji or symbol glyphs — are
 * enforced mechanically rather than remembered.
 *
 * No testing-library dependency: react-dom/server is already part of the app.
 */
import fs from "fs";
import path from "path";
import { createElement, Fragment } from "react";
import ErrorBoundary from "@/components/ErrorBoundary";
import { renderToStaticMarkup } from "react-dom/server";

/* the static-render world (router, axios, sonner, API mocks) is shared with the
 * prerender script so the tested markup and the shipped markup agree. */
import "./marketing.mocks";
import { AuthContext } from "@/App";
import Home from "@/pages/Landing";
import ExecutionPage from "@/pages/ExecutionPage";
import ImmersiveEvidence from "@/pages/EvidenceImmersive";
import GatePage from "@/pages/GatePage";
import ScorePage from "@/pages/ScorePage";
import EvidencePage from "@/pages/EvidencePage";
import DocsPage from "@/pages/DocsPage";
import Login from "@/pages/Login";
import NotFound from "@/pages/NotFound";
import Layout from "@/components/Layout";
import AgentRegistry from "@/pages/AgentRegistry";
import ExecutionFlow from "@/pages/ExecutionFlow";
import { DARK, LIGHT, gradeColor, statusColor } from "@/lib/palette";

const ANON = { user: null, authReady: true, setUser: () => {}, logout: () => {} };

const render = (element, auth = ANON) =>
  renderToStaticMarkup(
    createElement(AuthContext.Provider, { value: auth }, createElement(Fragment, null, element))
  );

const has = (html, needle) => expect(html).toContain(needle);

/* ── the five marketing routes ──────────────────────────────────────────── */

const PAGES = [
  {
    name: "home",
    element: <Home />,
    testids: [
      "landing-page", "nav-login-btn", "launch-protocol-btn", "hero-section",
      "hero-launch-btn", "hero-login-btn", "problem-section", "boundary-section",
      "boundary-act-identity", "boundary-act-stake", "boundary-act-score",
      "boundary-act-intent", "boundary-act-time",
      "cta-section", "cta-launch-btn", "footer-section",
    ],
    ids: ["hero", "boundary"],
    copy: [
      "An agent proposes", "verifies", "ENVELOPE_MISMATCH",
      "not affiliated with Robinhood", "Founded by", "@avairaprotocol",
      "linkedin.com/in/m-alyan-ashraf",
    ],
    art: [],
  },
  {
    name: "execution",
    element: <ExecutionPage />,
    testids: [
      "workflow-section", "decision-section", "cta-section", "footer-section",
    ],
    ids: ["execution"],
    copy: [
      "Five functions", "commitIntent", "checkGate", "attestOutcome",
      "challengeDeviation", "ENVELOPE_MISMATCH", "INTENT_NOT_COMMITTED",
    ],
    art: [],
  },
  {
    name: "evidence",
    element: <ImmersiveEvidence />,
    testids: [
      "evidence-section", "evidence-table", "architecture-section",
      "cta-section", "footer-section",
    ],
    ids: ["evidence", "architecture"],
    copy: [
      "chain id 46630", "157", "0 violations", "IdentityRegistry",
      "Gateway service", "not affiliated with Robinhood",
    ],
    art: [],
  },
  {
    name: "gate",
    element: <GatePage />,
    testids: [
      "how-it-works-section", "step-01", "step-02", "step-03", "step-04", "step-05",
      "step-06", "gate-pipeline-permit", "gate-pipeline-refuse", "moats-section",
      "moat-0", "moat-1", "moat-2", "moat-3", "moat-4", "refusal-table",
      "trace-permitted", "trace-refused",
    ],
    ids: ["execution", "moats"],
    copy: ["ENVELOPE_MISMATCH", "INTENT_ALREADY_EXECUTED", 'data-gate="envelope"', 'data-gate="permit"'],
    art: [],
  },
  {
    name: "score",
    element: <ScorePage />,
    testids: ["score-weights", "score-ladder", "penalty-ladder", "revenue-section"],
    ids: ["revenue", "penalty"],
    copy: ["orion-11 87.4", "85 / 10 / 5", "150% collateral terms"],
    art: [],
  },
  {
    name: "ledger",
    element: <EvidencePage />,
    testids: ["evidence-table"],
    ids: ["top"],
    copy: ["make verify", "make redteam", "verification/reports/parity.json", "audit/specs"],
    art: [],
  },
  {
    name: "docs",
    element: <DocsPage />,
    testids: ["sdk-section"],
    ids: ["top"],
    copy: ["@avaira/sdk", "AvairaClient", "protect_crew", "max_spend_usd", "EIP-712"],
    art: [],
  },
];

const ART_DIR_PUBLIC = path.resolve(__dirname, "..", "..", "public");

describe("marketing site", () => {
  it.each(PAGES)("$name keeps its hooks", ({ element, testids }) => {
    const html = render(element);
    for (const id of testids) has(html, `data-testid="${id}"`);
  });

  // The section ids the site has always exposed stay addressable, so an old
  // deep link still lands on the section that answers it.
  it.each(PAGES)("$name keeps its section ids", ({ element, ids }) => {
    const html = render(element);
    for (const id of ids) has(html, `id="${id}"`);
  });

  /* Every in-app deep link has to land on a section that exists. The footer
   * shipped two anchors (/#pillars, /#faq) for sections no page renders, so the
   * links were dead; this walks the links and checks the target markup. */
  it("only deep-links to sections that exist", () => {
    const routes = {
      "/": <Home />,
      "/execution": <ExecutionPage />,
      "/evidence": <ImmersiveEvidence />,
      "/gate": <GatePage />,
      "/score": <ScorePage />,
      "/ledger": <EvidencePage />,
      "/docs": <DocsPage />,
    };
    const rendered = Object.fromEntries(
      Object.entries(routes).map(([route, element]) => [route, render(element)]),
    );

    let checked = 0;
    for (const [route, html] of Object.entries(rendered)) {
      for (const match of html.matchAll(/href="(\/[^"#]*)?#([^"]+)"/g)) {
        const target = match[1] || route;
        expect(rendered[target]).toBeDefined();
        has(rendered[target], `id="${match[2]}"`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the chrome deep-links into every narrative page", () => {
    // the top nav is the page selector; the landing links every sibling route
    for (const link of ["/", "/execution", "/evidence", "/docs", "/gate"]) {
      const html = render(<Home />);
      has(html, `href="${link}"`);
    }
  });

  it.each(PAGES)("$name keeps its copy", ({ element, copy }) => {
    const html = render(element);
    for (const needle of copy) has(html, needle);
  });

  it.each(PAGES)("$name is in its declared scope", ({ element }) => {
    // every marketing route is immersive now — the pixel scope survives only
    // inside the console (Layout), which is a different surface.
    has(render(element), 'class="landing-immersive"');
  });

  // The page carries no pricing surface and no revenue projections: a figure a
  // reader cannot check against the repository is a claim, not a fact, and the
  // marketing site only makes the second kind.
  it.each(PAGES)("$name has no pricing surface", ({ element }) => {
    const html = render(element);
    expect(html).not.toContain('href="#pricing"');
    expect(html).not.toMatch(/\$[0-9]/);
    expect(html.toLowerCase()).not.toContain("pricing");
    expect(html.toLowerCase()).not.toContain("per month");
  });

  // No emoji, arrows, checkmarks or keyboard glyphs standing in for an icon or
  // a sentence: icons come from lucide, marks are drawn as SVG matrices.
  it.each(PAGES)("$name carries no symbol glyphs", ({ element }) => {
    expect(render(element)).not.toMatch(/[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\u25A0-\u25FF\uFE0F\u{1F000}-\u{1FAFF}]/u);
  });

  // Every rendered frame is referenced and described.
  it.each(PAGES)("$name carries its rendered art with alt text", ({ element, art }) => {
    const html = render(element);
    for (const src of art) has(html, src);
    for (const match of html.matchAll(/<img[^>]*alt="([^"]*)"/g)) {
      expect(match[1].length).toBeGreaterThan(0);
    }
  });

  /* The pixel art plates were retired with the pixel pages: the immersive
   * routes render 3D scenes and typographic figures instead of GIF plates.
   * What stays enforced is that any image a page ships is described. */
  it.each(PAGES)("$name describes every image it ships", ({ element }) => {
    for (const match of render(element).matchAll(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"/g)) {
      expect(match[1].length).toBeGreaterThan(0);
      expect(match[2].length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(ART_DIR_PUBLIC, path.basename(match[1])))).toBe(true);
    }
  });

  // Count-ups, corridor stages and the score marker all render their final
  // value in static markup, so a crawler or a reduced-motion visitor reads the
  // real numbers rather than a zero.
  it("renders every animated figure in its resolved state", () => {
    const evidence = render(<ImmersiveEvidence />);
    has(evidence, "157"); // the Foundry count, in static markup
    has(evidence, "chain id 46630");

    const gate = render(<GatePage />);
    has(gate, "four planes cleared");

    const score = render(<ScorePage />);
    has(score, "orion-11 87.4");
  });
});

/* ── the two light pages ────────────────────────────────────────────────── */

describe("sign-in and 404", () => {
  it("login keeps its hooks in the immersive scope", () => {
    const html = render(<Login />);
    has(html, 'class="landing-immersive"');
    for (const id of ["login-page", "login-logo", "login-card", "back-home-btn"]) {
      has(html, `data-testid="${id}"`);
    }
  });

  it("offers the Dynamic flow instead of dead backend OAuth buttons", () => {
    // the old page pointed at `${API}/auth/google/login`, which the SPA rewrite
    // answers with the app's own 404. The new page opens the shared sign-in
    // modal; the trigger hook is what the rest of the site binds to.
    const html = render(<Login />);
    has(html, 'data-testid="login-signin-btn"');
    expect(html).not.toContain("google");
    expect(html).not.toContain("auth/x/login");
  });

  it("explains an unconfigured Dynamic environment instead of dead-ending", () => {
    // jest runs without REACT_APP_DYNAMIC_ENV_ID, so the default auth-UI
    // context reports authConfigured=false — the same state a bare deployment
    // would ship.
    const html = render(<Login />);
    has(html, 'data-testid="login-auth-missing"');
    has(html, "REACT_APP_DYNAMIC_ENV_ID");
  });

  it("not found", () => {
    const html = render(<NotFound />);
    has(html, 'data-testid="not-found-page"');
    has(html, "No route here");
  });
});

describe("console shell", () => {
  const html = render(<Layout />);

  it("keeps the shell hooks", () => {
    for (const id of ["app-layout", "mobile-menu-toggle", "sidebar", "sidebar-logo", "app-logo", "main-nav", "main-content"]) {
      has(html, `data-testid="${id}"`);
    }
  });

  it("keeps the session block and sign-out hook for a signed-in operator", () => {
    const signedIn = render(<Layout />, { ...ANON, user: { name: "Test Operator", email: "ops@avaira.xyz" } });
    has(signedIn, 'data-testid="logout-btn"');
    has(signedIn, "Test Operator");
  });

  it("keeps every nav route hook", () => {
    for (const route of ["dashboard", "agents", "executions", "underwriters", "freeze", "treasury", "reputation", "sdk", "hardening-report"]) {
      has(html, `data-testid="nav-${route}"`);
    }
  });

  it("gives the sidebar search hint a control that opens the palette", () => {
    // The hint used to sit on a button with no handler at all.
    has(html, 'data-testid="open-command-palette"');
    has(html, 'aria-haspopup="dialog"');
    has(html, 'aria-expanded="false"');
    has(html, 'aria-controls="console-sidebar"');
    // the palette itself is not mounted until it is opened
    expect(html).not.toContain('data-testid="command-palette"');
  });

  it("stays out of the marketing pixel scope", () => {
    expect(html).not.toContain("px-site");
  });
});

describe("console pages render", () => {
  it.each([
    ["agent registry", <AgentRegistry />, ['class="page-title"', "Agent Registry"]],
    ["execution flow", <ExecutionFlow />, ["Execution Flow"]],
  ])("%s", (_name, element, needles) => {
    const html = render(element);
    for (const needle of needles) has(html, needle);
  });
});

/* ── palette ────────────────────────────────────────────────────────────── */

describe("palette", () => {
  it("keeps the dark console and light marketing tokens apart", () => {
    expect(DARK.accent).not.toEqual(LIGHT.accent);
    expect(DARK.app).not.toEqual(LIGHT.app);
    // The console accent is indigo; red is reserved for danger.
    expect(DARK.accent).toBe("#6E6BF2");
    expect(DARK.danger).toBe("#F45B69");
  });

  it("maps both Avaira Score ladders", () => {
    expect(gradeColor("A+")).toEqual(gradeColor("AAA"));
    expect(gradeColor("D")).toEqual(DARK.danger);
    expect(gradeColor(undefined)).toEqual(DARK.textMuted);
  });

  it("falls back to a muted colour for unknown statuses", () => {
    expect(statusColor("something-new")).toEqual(DARK.textMuted);
    expect(statusColor("completed")).toEqual(DARK.success);
  });
});

/* ── the error boundary: a render crash must never white-screen the app ── */

function BoundaryBomb({ boom }) {
  if (boom) throw new Error("OTP wallet detonated at render");
  return createElement("p", { "data-testid": "boundary-child" }, "alive");
}

it("renders children untouched when nothing throws", () => {
  const html = render(
    createElement(ErrorBoundary, null, createElement(BoundaryBomb, { boom: false })),
  );
  has(html, 'data-testid="boundary-child"');
  expect(html).not.toContain('data-testid="app-error-boundary"');
});

it("puts the failure on screen instead of unmounting the app", () => {
  // React's server renderer does not run error boundaries, so the fallback is
  // asserted the way the client reaches it: an error already caught in state.
  expect(ErrorBoundary.getDerivedStateFromError(new Error("x")).error.message).toBe("x");

  class PrimedBoundary extends ErrorBoundary {
    constructor(props) {
      super(props);
      this.state = { error: new Error("OTP wallet detonated at render") };
    }
  }
  const html = render(
    createElement(PrimedBoundary, null, createElement(BoundaryBomb, { boom: false })),
  );
  has(html, 'data-testid="app-error-boundary"');
  has(html, "OTP wallet detonated at render");
  // the crashed subtree is gone; the reload affordance is there
  expect(html).not.toContain('data-testid="boundary-child"');
  has(html, 'data-testid="app-error-reload"');
});
