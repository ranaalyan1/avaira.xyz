/**
 * Pixel primitives.
 *
 * The marketing language in one place: a dot-matrix glyph generator (the brand
 * mark and page icons are 5x7 matrices, not images), frames that hold the
 * rendered pixel art, dotted-leader spec rows, the section index rule, the
 * ticker and the two chrome elements every marketing page shares.
 *
 * Geometry is deterministic: a glyph is a pure function of its seed, so the
 * same page always draws the same matrix.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpRight, Github, LogIn } from "lucide-react";
import Breadcrumbs from "@/components/marketing/Breadcrumbs";
import { track } from "@/lib/analytics";

/* ── brand type ───────────────────────────────────────────────────────────
 * Doto (dot matrix) for display, IBM Plex Mono for machine text. Loaded from
 * @fontsource in src/index.js, so there is no runtime request to a font CDN.
 */

const hash = (value) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
};

/**
 * Dot-matrix glyph. A 5x7 matrix derived from the seed string, drawn as
 * rects so it stays crisp at any size. Used as the brand mark and as the icon
 * for every numbered section.
 */
export function Glyph({ seed = "AVIRA", cols = 5, rows = 7, size = 26, className = "", solid = false }) {
  const h = hash(seed);
  const cell = 1;
  const dot = 0.66;
  const offset = (cell - dot) / 2;
  const cells = [];

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const bit = (h >>> ((x * rows + y) % 29)) & 1;
      const edge = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      const lit = solid ? bit || edge : bit;
      if (lit) {
        cells.push(
          <rect
            key={`${x}-${y}`}
            className="px-glyph-dot"
            x={x * cell + offset}
            y={y * cell + offset}
            width={dot}
            height={dot}
          />
        );
      }
    }
  }

  return (
    <svg
      className={`px-glyph ${className}`}
      width={size}
      height={(size * rows) / cols}
      viewBox={`0 0 ${cols} ${rows}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {cells}
    </svg>
  );
}

/* ── chrome ───────────────────────────────────────────────────────────── */

const NAV = [
  { to: "/gate", label: "Gate" },
  { to: "/score", label: "Score" },
  { to: "/evidence", label: "Evidence" },
  { to: "/docs", label: "Docs" },
];

/**
 * Navigation. Transparent over the hero frame, then a black surface once the
 * page has moved; the dotted progress rule underneath reads scroll position.
 */
export function PixelNav({ onLaunch, onSignIn }) {
  const navRef = useRef(null);
  const { pathname } = useLocation();

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      nav.style.setProperty("--progress", max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)).toFixed(4) : "0");
      nav.classList.toggle("is-stuck", window.scrollY > 20);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <nav className="px-nav" ref={navRef}>
      <div className="px-wrap px-nav-inner">
        <Link className="px-brand" to="/" aria-label="AVAIRA home">
          <Glyph seed="AVAIRA" size={22} solid />
          <span className="px-brand-name">Avaira</span>
        </Link>

        <div className="px-nav-links">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`px-nav-link${pathname === item.to ? " is-active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="px-nav-actions">
          <button className="px-btn px-btn-quiet" data-testid="nav-login-btn" onClick={onSignIn}>
            Sign in
          </button>
          <button
            className="px-btn px-btn-accent"
            data-testid="launch-protocol-btn"
            onClick={() => {
              track("console_opened", { source: `nav:${pathname}` });
              if (onLaunch) onLaunch();
            }}
          >
            Console
          </button>
        </div>
      </div>
      <span className="px-nav-progress" aria-hidden="true" />
    </nav>
  );
}

export function PixelFooter() {
  return (
    <footer className="px-footer">
      <div className="px-wrap">
        <div className="px-footer-grid">
          <div>
            <div className="px-brand">
              <Glyph seed="AVAIRA" size={22} solid />
              <span className="px-brand-name">Avaira</span>
            </div>
            <p className="px-body" style={{ marginTop: "1rem", maxWidth: "34ch" }}>
              Pre-execution control for autonomous agents. Enforcement runs before the action, not
              after the incident.
            </p>
            <p className="px-mono px-mute px-footer-tag" style={{ marginTop: "1.25rem" }}>
              <span className="px-block" aria-hidden="true" />
              execution control protocol
            </p>
          </div>

          <nav className="px-footer-col" aria-label="Protocol">
            <h4>Protocol</h4>
            <Link to="/gate#execution">The gate</Link>
            <Link to="/gate#moats">Refusals</Link>
            <Link to="/score#revenue">Score engine</Link>
            <Link to="/evidence">Evidence</Link>
            <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/contracts">Contracts</a>
            <a href="https://github.com/ranaalyan1/avaira.xyz/tree/main/verification">Verification</a>
          </nav>

          <nav className="px-footer-col" aria-label="Build">
            <h4>Build</h4>
            <Link to="/docs#sdk">Integration</Link>
            <Link to="/#pillars">Pillars</Link>
            <Link to="/#faq">Questions</Link>
            <Link to="/sdk">Console docs</Link>
            <a href="https://github.com/ranaalyan1/avaira.xyz">Source</a>
            <a href="https://github.com/ranaalyan1/avaira.xyz/blob/main/SECURITY.md">Security</a>
            <a href="https://github.com/ranaalyan1/avaira.xyz/blob/main/CHANGELOG.md">Changelog</a>
            <Link to="/contact">Contact</Link>
          </nav>

          <nav className="px-footer-col" aria-label="Console">
            <h4>Console</h4>
            <Link to="/dashboard">Dashboard</Link>
            <Link to="/agents">Agent registry</Link>
            <Link to="/executions">Execution flow</Link>
            <Link to="/treasury">Treasury</Link>
            <Link to="/underwriters">Underwriters</Link>
          </nav>
        </div>

        <div className="px-footer-base">
          <span>{new Date().getFullYear()} Avaira</span>
          <span>Nothing is spent until the gate returns a permit</span>
        </div>
      </div>
    </footer>
  );
}

/* ── section furniture ────────────────────────────────────────────────── */

export const SectionIndex = ({ n, label }) => (
    <p className="px-index" data-reveal>
    <span style={{ color: "var(--px-accent)" }}>{n}</span>
    <span>{label}</span>
  </p>
);

/* Every plate ships as a still and as a sequence. The still is what the markup
 * carries — crawlers, no-JS visitors and the smoke tests read it — and the
 * sequence is swapped in once the page has painted, and only for visitors who
 * have not asked for reduced motion. The pair is always the same scene, so the
 * swap is invisible. */
export const PixelArt = ({ png, gif, alt, className = "", loading = "lazy", ...rest }) => {
  const [src, setSrc] = useState(png);

  useEffect(() => {
    if (!gif || typeof window === "undefined") return undefined;
    const media = window.matchMedia;
    if (media && media("(prefers-reduced-motion: reduce)").matches) return undefined;

    let cancelled = false;
    let preload;
    // the sequence is fetched while the page is idle and only swapped in once
    // it is decoded, so the plate never flickers between the two frames
    const swap = () => {
      preload = new window.Image();
      preload.onload = () => {
        if (!cancelled) setSrc(gif);
      };
      preload.src = gif;
    };
    const idle = window.requestIdleCallback;
    const handle = idle ? idle(swap, { timeout: 1500 }) : window.setTimeout(swap, 300);
    const cancel = window.cancelIdleCallback;
    return () => {
      cancelled = true;
      if (preload) preload.onload = null;
      if (idle && cancel) cancel(handle);
      else window.clearTimeout(handle);
    };
  }, [gif]);

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      decoding="async"
      data-px-art=""
      data-px-still={png}
      data-px-motion={gif || undefined}
      {...rest}
    />
  );
};

export const PixelFrame = ({ src, gif, alt, ratio = "16 / 9", scan = true, caption, hint, className = "" }) => (
  <figure className={`px-frame ${className}`} style={ratio ? { aspectRatio: ratio } : undefined}>
    <PixelArt png={src} gif={gif} alt={alt} />
    {scan ? <span className="px-frame-scan" aria-hidden="true" /> : null}
    <span className="px-frame-tick px-frame-tick-tl" aria-hidden="true" />
    <span className="px-frame-tick px-frame-tick-tr" aria-hidden="true" />
    <span className="px-frame-tick px-frame-tick-bl" aria-hidden="true" />
    <span className="px-frame-tick px-frame-tick-br" aria-hidden="true" />
    {caption ? (
      <figcaption className="px-figure-cap">
        <span>{caption}</span>
        {hint ? <span>{hint}</span> : null}
      </figcaption>
    ) : null}
  </figure>
);

/** Rows of `key ......... value`, the spec-sheet primitive. */
export const SpecRows = ({ rows, title }) => (
  <div>
    {title ? <p className="px-label" style={{ marginBottom: "0.75rem" }}>{title}</p> : null}
    <div className="px-spec">
      {rows.map(([key, value, tone]) => (
        <div className="px-spec-row" key={key} data-reveal>
          <span className="px-spec-key">{key}</span>
          <span className={`px-spec-value${tone ? ` is-${tone}` : ""}`}>{value}</span>
        </div>
      ))}
    </div>
  </div>
);

/** Scrolling ticker — the protocol's own vocabulary, looped. */
export const Marquee = ({ items }) => {
  const run = [...items, ...items];
  return (
    <div className="px-marquee" aria-hidden="true">
      <div className="px-marquee-track">
        {run.map((item, index) => (
          <span className="px-marquee-item" key={`${item}-${index}`}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
};

/** Page header: index, display title, lede, optional pixel-art backdrop. */
export const PageHead = ({ n, section, title, lede, art, artGif, artAlt, meta, crumbs, children }) => (
  <header className="px-page-head" id="top">
    {art ? (
      <div className="px-page-head-art">
        <PixelArt png={art} gif={artGif} alt={artAlt || ""} loading="eager" fetchPriority="high" />
      </div>
    ) : null}
    <span className="px-page-head-veil" aria-hidden="true" />
    <div className="px-wrap px-page-head-inner">
      {crumbs ? <Breadcrumbs trail={crumbs} /> : null}
      <SectionIndex n={n} label={section} />
      <h1 className="px-dot px-display px-page-title" data-reveal>
        {title}
      </h1>
      {lede ? (
        <p className="px-body px-page-lede" data-reveal style={{ maxWidth: "58ch" }}>
          {lede}
        </p>
      ) : null}
      {meta ? <div className="px-hero-meta" data-reveal>{meta}</div> : null}
      {children}
    </div>
  </header>
);

/** The two console entry points, wired once and shared by every page. */
export const ConsoleActions = ({ onLaunch, onSignIn, size = "lg", launchTestId, signInTestId }) => {
  const { pathname } = useLocation();
  return (
    <div className="px-hero-actions">
      <button
        className={`px-btn px-btn-accent${size === "lg" ? " px-btn-lg" : ""}`}
        onClick={() => {
          track("console_opened", { source: pathname });
          if (onLaunch) onLaunch();
        }}
        data-testid={launchTestId}
      >
        Open the console
        <ArrowUpRight size={15} strokeWidth={2} />
      </button>
      {onSignIn ? (
        <button
          className={`px-btn px-btn-quiet${size === "lg" ? " px-btn-lg" : ""}`}
          onClick={onSignIn}
          data-testid={signInTestId}
        >
          <LogIn size={14} strokeWidth={2} />
          Sign in
        </button>
      ) : (
        <a
          className={`px-btn px-btn-quiet${size === "lg" ? " px-btn-lg" : ""}`}
          href="https://github.com/ranaalyan1/avaira.xyz"
          target="_blank"
          rel="noreferrer"
          onClick={() => track("outbound_github", { source: pathname })}
        >
          <Github size={14} strokeWidth={2} />
          Read the source
        </a>
      )}
    </div>
  );
};
