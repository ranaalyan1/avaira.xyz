/**
 * Design smoke test.
 *
 * The marketing surfaces are verified by tools outside this repo (playwright
 * scripts, docs) that address elements by data-testid, and `tools/doctor.py`
 * re-checks documented claims. Rendering the pages to static markup here means
 * a restyle can never silently drop the hooks those depend on, and it fails
 * fast on a component that throws at render time.
 *
 * No testing-library dependency: react-dom/server is already part of the app.
 */
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthContext } from "@/App";
import Landing from "@/pages/Landing";
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
    const Anchor = ({ children, ...rest }) => React.createElement("a", rest, children);
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

describe("landing page", () => {
  const html = render(<Landing />);

  // Every testid the previous design exposed, plus the anchors it linked to.
  const TESTIDS = [
    "landing-page", "nav-login-btn", "launch-protocol-btn", "hero-section",
    "hero-launch-btn", "hero-login-btn", "pillars-section", "pillar-rate",
    "pillar-clear", "pillar-insure", "how-it-works-section", "step-01",
    "step-02", "step-03", "step-04", "step-05", "step-06", "moats-section",
    "moat-0", "moat-1", "moat-2", "moat-3", "moat-4", "revenue-section",
    "sdk-section", "cta-section", "cta-launch-btn",
  ];

  it.each(TESTIDS)("keeps the %s hook", (id) => {
    expect(html).toContain(`data-testid="${id}"`);
  });

  it("keeps the section anchors the nav links to", () => {
    for (const anchor of ["#pillars", "#execution", "#moats", "#revenue", "#sdk", "#faq"]) {
      expect(html).toContain(`href="${anchor}"`);
    }
  });

  it("uses the light marketing scope", () => {
    expect(html).toContain("theme-marketing");
  });

  it("keeps the headline, the SDK snippet and the fee streams", () => {
    expect(html).toContain("Nothing spends");
    expect(html).toContain("until the gate says yes.");
    expect(html).toContain("AvairaClient");
    expect(html).toContain("Four fee streams, all of them from settled activity.");
    expect(html).toContain("85, 10 and 5 split");
  });

  // The page carries no pricing surface and no revenue projections: a figure a
  // reader cannot check against the repository is a claim, not a fact, and the
  // marketing surface only makes the second kind.
  it("has no pricing surface, no anchor to one and no money figures", () => {
    expect(html).not.toContain('href="#pricing"');
    expect(html).not.toMatch(/\$[0-9]/);
    expect(html.toLowerCase()).not.toContain("pricing");
    expect(html.toLowerCase()).not.toContain("per month");
  });

  // The art direction: every band and tile that carries a rendered frame loads
  // it from /art, and the frames are described for anyone who cannot see them.
  it("carries the rendered art for every image slot", () => {
    for (const art of [
      "/art/hero-gate.webp",
      "/art/gate-3d.webp",
      "/art/score-3d.webp",
      "/art/underwrite-3d.webp",
      "/art/decision-3d.webp",
      "/art/underwriter-network.webp",
    ]) {
      expect(html).toContain(art);
    }
    expect(html).toContain('data-testid="decision-band"');
    expect(html.match(/alt="/g).length).toBeGreaterThanOrEqual(8);
  });

  // The page is built from the protocol's own artefacts — corridors, traces,
  // spec tables — instead of generic feature cards. Those hooks are part of the
  // contract: losing them means the page went back to being a template.
  it("renders the gate artefacts", () => {
    for (const needle of [
      'data-testid="gate-pipeline-permit"',
      'data-testid="gate-pipeline-refuse"',
      'data-gate="envelope"',
      'data-gate="permit"',
      'data-testid="trace-permitted"',
      'data-testid="trace-refused"',
      'ENVELOPE_MISMATCH',
      'INTENT_ALREADY_EXECUTED',
      'data-testid="refusal-table"',
      'data-testid="evidence-table"',
      'data-testid="score-weights"',
      'data-testid="score-ladder"',
      'data-testid="penalty-ladder"',
    ]) {
      expect(html).toContain(needle);
    }
  });

  // Motion is a layer, not the content: the markup alone has to carry the
  // figures and the resolved geometry, and no copy may rely on a glyph standing
  // in for an icon or a sentence.
  it("carries no emoji or symbol glyphs", () => {
    expect(html).not.toMatch(/[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u{1F000}-\u{1FAFF}]/u);
  });

  it("prints the resolved state of every animated figure", () => {
    // Count-ups, corridor stages and the prover marker all render their final
    // value in static markup, so a crawler or a reduced-motion visitor reads
    // the real numbers.
    expect(html).toContain("94.4%");
    expect(html).toContain("8,031");
    expect(html).toContain("orion-11 87.4");
    expect(html).toContain("ENVELOPE_MISMATCH");
  });
});

describe("light surfaces render in the marketing scope", () => {
  it("login", () => {
    const html = render(<Login />);
    expect(html).toContain("theme-marketing");
    for (const id of ["login-page", "login-logo", "login-card", "google-login-btn", "x-login-btn", "back-home-btn"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it("not found", () => {
    expect(render(<NotFound />)).toContain('data-testid="not-found-page"');
  });
});

describe("console shell", () => {
  const html = render(<Layout />);

  it("keeps the shell hooks", () => {
    for (const id of ["app-layout", "mobile-menu-toggle", "sidebar", "sidebar-logo", "app-logo", "main-nav", "main-content"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it("keeps the session block and sign-out hook for a signed-in operator", () => {
    const signedIn = render(<Layout />, { ...ANON, user: { name: "Test Operator", email: "ops@avaira.xyz" } });
    expect(signedIn).toContain('data-testid="logout-btn"');
    expect(signedIn).toContain("Test Operator");
  });

  it("keeps every nav route hook", () => {
    for (const route of ["dashboard", "agents", "executions", "underwriters", "freeze", "treasury", "reputation", "sdk"]) {
      expect(html).toContain(`data-testid="nav-${route}"`);
    }
  });

  it("stays out of the light marketing scope", () => {
    expect(html).not.toContain("theme-marketing");
  });
});

describe("console pages render", () => {
  it.each([
    ["agent registry", <AgentRegistry />, ["class=\"page-title\"", "Agent Registry"]],
    ["execution flow", <ExecutionFlow />, ["Execution Flow"]],
  ])("%s", (_name, element, needles) => {
    const html = render(element);
    for (const needle of needles) expect(html).toContain(needle);
  });
});

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
