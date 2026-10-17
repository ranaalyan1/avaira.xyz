/**
 * Smoke tests for the site-polish layer: the contact page, the cookie
 * consent surfaces, consent-gated analytics and the SEO helpers.
 *
 * Same approach as design.smoke.test.js — react-dom/server static renders,
 * no testing-library dependency.
 */
import fs from "fs";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("axios", () => ({ __esModule: true, default: { get: async () => ({ data: {} }), post: async () => ({ data: {} }), defaults: {} } }));
jest.mock("sonner", () => ({ Toaster: () => null, toast: { success: () => {}, error: () => {}, info: () => {} } }));
jest.mock("@/lib/api", () => ({ API: "http://localhost:8001/api", API_BASE: "http://localhost:8001" }));
jest.mock("@/App", () => {
  const React = require("react");
  const AuthContext = React.createContext({ user: null, authReady: true, setUser: () => {}, logout: () => {} });
  return { AuthContext, useAuth: () => React.useContext(AuthContext) };
});
jest.mock(
  "react-router-dom",
  () => {
    const React = require("react");
    const Anchor = ({ children, to, ...rest }) =>
      React.createElement("a", { ...rest, href: typeof to === "string" ? to : rest.href }, children);
    return {
      Link: Anchor,
      NavLink: Anchor,
      useNavigate: () => () => {},
      useLocation: () => ({ pathname: "/", hash: "" }),
    };
  },
  { virtual: true }
);

import Contact from "@/pages/Contact";
import CookieConsent from "@/components/CookieConsent";
import Breadcrumbs from "@/components/marketing/Breadcrumbs";
import { breadcrumbJsonLd } from "@/lib/seo";
import { getConsent, saveConsent, CONSENT_KEY } from "@/lib/consent";
import { track } from "@/lib/analytics";

const render = (element) => renderToStaticMarkup(element);

describe("contact page", () => {
  it("renders the form with every field and the submit control", () => {
    const html = render(createElement(Contact));
    for (const id of ["contact-form", "contact-name", "contact-email", "contact-topic", "contact-message", "contact-submit"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it("stays inside the pixel scope and links onward", () => {
    const html = render(createElement(Contact));
    expect(html).toContain('class="px-site"');
    expect(html).toContain('data-testid="related-pages"');
    expect(html).toContain('href="/docs"');
  });
});

describe("breadcrumbs", () => {
  const trail = [["Home", "/"], ["The gate", "/gate"]];

  it("renders a nav with the current page marked", () => {
    const html = render(createElement(Breadcrumbs, { trail }));
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('href="/"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("The gate");
  });

  it("mirrors the visible trail in BreadcrumbList JSON-LD", () => {
    const block = breadcrumbJsonLd(trail);
    expect(block["@type"]).toBe("BreadcrumbList");
    expect(block.itemListElement).toHaveLength(2);
    expect(block.itemListElement[1].item).toBe("https://avaira.xyz/gate");
  });
});

describe("cookie consent", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows the banner until the visitor decides", () => {
    const html = render(createElement(CookieConsent));
    expect(html).toContain('data-testid="cookie-banner"');
    expect(html).toContain('data-testid="cookie-accept-all"');
    expect(html).toContain('data-testid="cookie-necessary-only"');
  });

  it("defaults to necessary-only and persists a decision", () => {
    expect(getConsent()).toMatchObject({ necessary: true, analytics: false, decided: false });
    saveConsent({ analytics: true });
    expect(getConsent()).toMatchObject({ necessary: true, analytics: true, decided: true });
    expect(JSON.parse(window.localStorage.getItem(CONSENT_KEY)).analytics).toBe(true);
  });

  it("hides the banner once decided and offers the reopen control", () => {
    saveConsent({ analytics: false });
    const html = render(createElement(CookieConsent));
    expect(html).not.toContain('data-testid="cookie-banner"');
    expect(html).toContain('data-testid="cookie-preferences-reopen"');
  });
});

describe("analytics consent gate", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete window.dataLayer;
  });

  it("sends nothing before consent and flushes after opt-in", () => {
    track("console_opened", { source: "/" });
    expect(window.dataLayer || []).toHaveLength(0);
    saveConsent({ analytics: true });
    expect(window.dataLayer.some((e) => e.event === "console_opened")).toBe(true);
  });

  it("delivers immediately once analytics is granted", () => {
    saveConsent({ analytics: true });
    track("contact_submitted", { topic: "integration" });
    expect(window.dataLayer.some((e) => e.event === "contact_submitted")).toBe(true);
  });

  it("drops events when the visitor declined", () => {
    saveConsent({ analytics: false });
    track("console_opened", { source: "/" });
    expect((window.dataLayer || []).some((e) => e.event === "console_opened")).toBe(false);
  });
});

describe("crawler surface files", () => {
  const PUBLIC = path.resolve(__dirname, "..", "..", "public");

  it("ships the icon set the head declares", () => {
    for (const file of [
      "favicon.ico",
      "manifest.webmanifest",
      "icons/favicon-16.png",
      "icons/favicon-32.png",
      "icons/apple-touch-icon.png",
      "icons/icon-192.png",
      "icons/icon-512.png",
      "icons/icon-512-maskable.png",
    ]) {
      expect(fs.existsSync(path.join(PUBLIC, file))).toBe(true);
    }
  });

  it("ships a share image for every public page in the sitemap", () => {
    const sitemap = fs.readFileSync(path.join(PUBLIC, "sitemap.xml"), "utf8");
    const routes = [...sitemap.matchAll(/<loc>https:\/\/avaira\.xyz(\/[a-z-]*)<\/loc>/g)].map((m) => m[1]);
    expect(routes).toContain("/gate");
    for (const route of routes) {
      if (route === "/login") continue; // login reuses the default card
      const name = route === "/" ? "og-home" : `og-${route.slice(1)}`;
      expect(fs.existsSync(path.join(PUBLIC, "og", `${name}.png`))).toBe(true);
    }
  });

  it("self-hosts every font the head preloads", () => {
    const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
    expect(html).not.toContain("fonts.googleapis.com");
    for (const m of html.matchAll(/\/fonts\/([a-z0-9-]+\.woff2)/g)) {
      expect(fs.existsSync(path.join(PUBLIC, "fonts", m[1]))).toBe(true);
    }
  });

  it("keeps the console out of robots.txt and the sitemap", () => {
    const robots = fs.readFileSync(path.join(PUBLIC, "robots.txt"), "utf8");
    const sitemap = fs.readFileSync(path.join(PUBLIC, "sitemap.xml"), "utf8");
    for (const route of ["/dashboard", "/agents", "/executions", "/treasury"]) {
      expect(robots).toContain(`Disallow: ${route}`);
      expect(sitemap).not.toContain(`avaira.xyz${route}<`);
    }
  });
});
