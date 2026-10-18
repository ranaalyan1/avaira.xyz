/**
 * Design smoke test.
 *
 * The marketing site is five routes and a console, and this file is the
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
import { renderToStaticMarkup } from "react-dom/server";

import { AuthContext } from "@/App";
import Home from "@/pages/Landing";
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

// react-router-dom v7 publishes ESM only, which the jest 27 resolver shipped
// with react-scripts cannot resolve. The marketing pages only need navigation
// primitives, so they are mocked rather than pulling the real package in.
// axios 1.x ships ESM, which the same jest resolver cannot parse. The pages only
// touch it from effects, which renderToStaticMarkup never runs.
jest.mock("axios", () => ({ __esModule: true, default: { get: async () => ({ data: {} }), post: async () => ({ data: {} }), defaults: {} } }));

// Same story for the toast helper: imported, never invoked during a static render.
jest.mock("sonner", () => ({ Toaster: () => null, toast: { success: () => {}, error: () => {}, info: () => {} } }));

// …and the API base URL constant.
jest.mock("@/lib/api", () => ({ API: "http://localhost:8001/api", API_BASE: "http://localhost:8001" }));

jest.mock("@/App", () => {
  const React = require("react");
  const AuthContext = React.createContext({ user: null, authReady: true, setUser: () => {}, logout: () => {} });
  // Read the provider so tests can render both signed-in and anonymous states.
  return { AuthContext, useAuth: () => React.useContext(AuthContext) };
});

jest.mock(
  "react-router-dom",
  () => {
    const React = require("react");
    const Passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
    // A router Link renders an anchor with an href — mirror that, so tests can
    // assert on the destination the way a crawler would see it.
    const Anchor = ({ children, to, ...rest }) =>
      React.createElement("a", { ...rest, href: typeof to === "string" ? to : rest.href }, children);
    return {
      BrowserRouter: Passthrough,
      MemoryRouter: Passthrough,
      Routes: Passthrough,
      Route: () => null,
      Navigate: () => null,
      Outlet: () => null,
      Link: Anchor,
      NavLink: Anchor,
      useNavigate: () => () => {},
      useLocation: () => ({ pathname: "/" }),
    };
  },
  { virtual: true }
);

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
      "hero-launch-btn", "hero-login-btn", "pillars-section", "pillar-rate",
      "pillar-clear", "pillar-insure", "cta-section", "cta-launch-btn",
    ],
    ids: ["pillars", "faq"],
    copy: ["Nothing spends", "until the gate", "94.4%", "8,031", "Committed before execution"],
    art: ["/art/hero.png", "/art/score.png", "/art/underwrite.png", "/art/network.png", "/art/permit.png", "/art/refuse.png"],
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
    art: ["/art/permit.png", "/art/refuse.png"],
  },
  {
    name: "score",
    element: <ScorePage />,
    testids: ["score-weights", "score-ladder", "penalty-ladder", "revenue-section"],
    ids: ["revenue", "penalty"],
    copy: ["orion-11 87.4", "85 / 10 / 5", "150% collateral terms"],
    art: ["/art/score.png", "/art/burn.png", "/art/network.png"],
  },
  {
    name: "evidence",
    element: <EvidencePage />,
    testids: ["evidence-table"],
    ids: ["top"],
    copy: ["make verify", "make redteam", "verification/reports/parity.json", "audit/specs"],
    art: ["/art/ledger.png"],
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

  it("the chrome deep-links into every section", () => {
    const html = render(<Home />);
    for (const link of ["/gate#execution", "/gate#moats", "/score#revenue", "/docs#sdk", "/#pillars", "/#faq"]) {
      has(html, `href="${link}"`);
    }
  });

  it.each(PAGES)("$name keeps its copy", ({ element, copy }) => {
    const html = render(element);
    for (const needle of copy) has(html, needle);
  });

  it.each(PAGES)("$name is in the pixel scope", ({ element }) => {
    has(render(element), 'class="px-site"');
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

  /* The plates are animated: each one ships as a still for the markup and a
   * looping sequence for the client. Both files have to exist on disk, the pair
   * has to be the same scene, and the still is what a crawler reads — so a
   * missing gif is a broken page, not a cosmetic problem. */
  const ART_DIR = path.resolve(__dirname, "..", "..", "public", "art");
  const stills = [];
  const motions = [];

  it.each(PAGES)("$name pairs every plate with an existing sequence", ({ element }) => {
    for (const match of render(element).matchAll(/<img[^>]*data-px-art=""[^>]*>/g)) {
      const tag = match[0];
      const still = /data-px-still="([^"]*)"/.exec(tag);
      const motion = /data-px-motion="([^"]*)"/.exec(tag);
      expect(still).not.toBeNull();
      expect(fs.existsSync(path.join(ART_DIR, path.basename(still[1])))).toBe(true);
      if (motion) {
        expect(motion[1]).toMatch(/\.gif$/);
        expect(fs.existsSync(path.join(ART_DIR, path.basename(motion[1])))).toBe(true);
        motions.push(motion[1]);
      } else {
        stills.push(still[1]);
      }
    }
  });

  it("animates the art the marketing site is built around", () => {
    const unique = [...new Set(motions)];
    for (const gif of ["/art/hero.gif", "/art/score.gif", "/art/permit.gif", "/art/refuse.gif"]) {
      expect(unique).toContain(gif);
    }
    expect(unique.length).toBeGreaterThanOrEqual(6);
  });

  it("still ships a static frame for every plate", () => {
    // the login plate is the one deliberate exception: it is background, and it
    // is described anyway
    expect(stills.length + motions.length).toBeGreaterThanOrEqual(12);
  });

  // Count-ups, corridor stages and the score marker all render their final
  // value in static markup, so a crawler or a reduced-motion visitor reads the
  // real numbers rather than a zero.
  it("renders every animated figure in its resolved state", () => {
    const home = render(<Home />);
    has(home, "94.4%");
    has(home, "8,031");

    const gate = render(<GatePage />);
    has(gate, "four planes cleared");

    const score = render(<ScorePage />);
    has(score, "orion-11 87.4");
  });
});

/* ── the two light pages ────────────────────────────────────────────────── */

describe("sign-in and 404", () => {
  it("login keeps its hooks in the pixel scope", () => {
    const html = render(<Login />);
    has(html, 'class="px-site px-login"');
    for (const id of ["login-page", "login-logo", "login-card", "google-login-btn", "x-login-btn", "back-home-btn"]) {
      has(html, `data-testid="${id}"`);
    }
  });

  it("explains a deployment with no backend instead of dead-ending", () => {
    // Without a backend, `${API}/auth/google/login` is answered by the SPA
    // rewrite, so the visitor lands on the app's own 404 page with no clue why.
    const html = render(<Login />, { ...ANON, backendMisconfigured: true });

    has(html, 'data-testid="login-backend-missing"');
    has(html, "REACT_APP_BACKEND_URL");
    // The buttons stay where they are (a crawler and a reader both see them), but
    // they cannot fire a redirect that can only 404.
    has(html, 'data-testid="google-login-btn"');
    has(html, 'data-testid="x-login-btn"');
    expect(html).toContain("disabled");
  });

  it("says nothing about a missing backend when the API is reachable", () => {
    const html = render(<Login />);

    expect(html).not.toContain('data-testid="login-backend-missing"');
    expect(html).not.toContain("disabled");
  });

  it("not found", () => {
    const html = render(<NotFound />);
    has(html, 'data-testid="not-found-page"');
    has(html, "No route here");
  });
});

/* ── the console ────────────────────────────────────────────────────────── */

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
    for (const route of ["dashboard", "agents", "executions", "underwriters", "freeze", "treasury", "reputation", "sdk"]) {
      has(html, `data-testid="nav-${route}"`);
    }
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
    // The console accent is the brand lime; red is reserved for danger.
    expect(DARK.accent).toBe("#CCFF00");
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
