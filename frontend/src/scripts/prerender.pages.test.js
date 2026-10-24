/**
 * Prerender the marketing routes into real HTML — the P0 half of the SEO fix.
 *
 * CRA serves an empty #root with a boot loader, so a crawler without a JS
 * engine (or a social previewer) saw only the title. This script renders each
 * public page to static markup with ReactDOM/server — the same render path the
 * design smoke test exercises — and splices it into the built index.html
 * shell, one file per route under build/. React still takes over on the client
 * (createRoot replaces the snapshot), so the runtime is unchanged: the
 * snapshot exists for crawlers, previews and first paint.
 *
 * It lives under testMatch so jest will run it, but it self-skips when no
 * build/ exists (CI test runs, local test runs): the snapshot step only makes
 * sense after `craco build`, where the postbuild hook runs it:
 *   craco test --watchAll=false --testPathPattern prerender.pages
 */
import fs from "fs";
import path from "path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "../pages/marketing.mocks";
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

const ROOT = path.normalize(path.join(__dirname, "..", ".."));
const BUILD = path.join(ROOT, "build");
const HAS_BUILD = fs.existsSync(path.join(BUILD, "index.html"));
const ANON = { user: null, authReady: true, setUser: () => {}, logout: () => {} };

/* route -> rendered page + the <title> the client would set via usePageTitle */
const ROUTES = [
  { route: "/", title: "AVAIRA — Nothing spends until the gate returns a permit", Element: Home },
  { route: "/execution", title: "Execution — five functions, nine refusals — AVAIRA", Element: ExecutionPage },
  { route: "/evidence", title: "Evidence — deployed, wired, verifiable — AVAIRA", Element: ImmersiveEvidence },
  { route: "/gate", title: "Gate mechanics — AVAIRA", Element: GatePage },
  { route: "/score", title: "The Avaira score — AVAIRA", Element: ScorePage },
  { route: "/ledger", title: "Evidence ledger — AVAIRA", Element: EvidencePage },
  { route: "/docs", title: "Docs and SDK — AVAIRA", Element: DocsPage },
  { route: "/login", title: "Sign in — AVAIRA", Element: Login },
];

const render = (Element) =>
  renderToStaticMarkup(
    createElement(AuthContext.Provider, { value: ANON }, createElement(Fragment, null, createElement(Element)))
  );

(HAS_BUILD ? it : it.skip)("prerenders every public route into build/", () => {
  expect(fs.existsSync(path.join(BUILD, "index.html"))).toBe(true);
  const shell = fs.readFileSync(path.join(BUILD, "index.html"), "utf8");

  const rootOpen = shell.indexOf('<div id="root">');
  expect(rootOpen).toBeGreaterThan(-1);
  /* the bundle loads from <head>; #root is followed by the <noscript> fallback */
  const innerEnd = shell.indexOf("<noscript", rootOpen);
  const inner = shell.slice(rootOpen + '<div id="root">'.length, innerEnd);
  expect(inner.trimEnd().endsWith("</div>")).toBe(true); /* root's own closing tag */

  let saved = 0;
  for (const { route, title, Element } of ROUTES) {
    const markup = render(Element);
    expect(markup.length).toBeGreaterThan(1500); /* an empty shell is a bug, not a snapshot */

    /* the <title> lives in the head, before #root — swap it in the composed document */
    const html = (
      shell.slice(0, rootOpen + '<div id="root">'.length) +
      markup +
      "</div>" +
      shell.slice(innerEnd)
    ).replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);

    const out = route === "/" ? path.join(BUILD, "index.html") : path.join(BUILD, route, "index.html");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    saved += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`Prerendered ${saved}/${ROUTES.length} routes into build/`);
});
