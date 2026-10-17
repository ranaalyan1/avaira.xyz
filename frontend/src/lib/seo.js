/**
 * Per-page SEO.
 *
 * CRA has no server render, so the document head is owned by this hook: each
 * page declares its own title, description, canonical URL, Open Graph card and
 * (optionally) JSON-LD, and the hook writes them into <head> on mount and on
 * every route change. The static pre-render in public/index.html carries the
 * home page's copy of the same tags, so crawlers that do not execute
 * JavaScript still read a complete head for the landing page.
 */
import { useEffect } from "react";

export const SITE_ORIGIN = "https://avaira.xyz";
export const SITE_NAME = "AVAIRA Protocol";
const TITLE_SUFFIX = " | AVAIRA";
const DEFAULT_IMAGE = `${SITE_ORIGIN}/og.png`;
const DEFAULT_IMAGE_ALT = "AVAIRA Protocol: nothing spends until the gate returns a permit";

const MANAGED_ATTR = "data-seo-managed";

function upsertMeta(lookup, attrs) {
  let el = document.head.querySelector(lookup);
  if (!el) {
    el = document.createElement("meta");
    document.head.appendChild(el);
  }
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}

function upsertLink(rel, href) {
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
  return el;
}

/** Serialise one or more JSON-LD blocks into managed <script> tags. */
function writeJsonLd(blocks) {
  document.head
    .querySelectorAll(`script[${MANAGED_ATTR}="jsonld"]`)
    .forEach((el) => el.remove());
  if (!blocks) return;
  const list = Array.isArray(blocks) ? blocks : [blocks];
  list.forEach((block) => {
    if (!block) return;
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.setAttribute(MANAGED_ATTR, "jsonld");
    script.textContent = JSON.stringify(block);
    document.head.appendChild(script);
  });
}

/**
 * Declare the document head for the current page.
 *
 * @param {object} opts
 * @param {string}  opts.title        page title (suffix appended unless `fullTitle`)
 * @param {boolean} [opts.fullTitle]  use `title` verbatim
 * @param {string}  opts.description  meta + og + twitter description
 * @param {string}  opts.path         canonical path, e.g. "/gate"
 * @param {string}  [opts.image]      absolute or site-relative share image
 * @param {string}  [opts.imageAlt]   alt text for the share image
 * @param {string}  [opts.type]       og:type, defaults to "website"
 * @param {boolean} [opts.noindex]    true for console / error surfaces
 * @param {object|object[]} [opts.jsonLd] Schema.org block(s) for this page
 */
export function useSeo({
  title,
  fullTitle = false,
  description,
  path = "/",
  image,
  imageAlt,
  type = "website",
  noindex = false,
  jsonLd,
} = {}) {
  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const resolvedTitle = fullTitle ? title : `${title}${TITLE_SUFFIX}`;
    const url = `${SITE_ORIGIN}${path}`;
    const img = image
      ? image.startsWith("http")
        ? image
        : `${SITE_ORIGIN}${image}`
      : DEFAULT_IMAGE;
    const alt = imageAlt || DEFAULT_IMAGE_ALT;

    document.title = resolvedTitle;

    upsertMeta('meta[name="description"]', { name: "description", content: description || "" });
    upsertMeta('meta[name="robots"]', {
      name: "robots",
      content: noindex ? "noindex, nofollow" : "index, follow",
    });
    upsertLink("canonical", url);

    // Open Graph
    upsertMeta('meta[property="og:type"]', { property: "og:type", content: type });
    upsertMeta('meta[property="og:site_name"]', { property: "og:site_name", content: SITE_NAME });
    upsertMeta('meta[property="og:url"]', { property: "og:url", content: url });
    upsertMeta('meta[property="og:title"]', { property: "og:title", content: resolvedTitle });
    upsertMeta('meta[property="og:description"]', { property: "og:description", content: description || "" });
    upsertMeta('meta[property="og:image"]', { property: "og:image", content: img });
    upsertMeta('meta[property="og:image:alt"]', { property: "og:image:alt", content: alt });
    upsertMeta('meta[property="og:image:width"]', { property: "og:image:width", content: "1200" });
    upsertMeta('meta[property="og:image:height"]', { property: "og:image:height", content: "630" });

    // Twitter / X
    upsertMeta('meta[name="twitter:card"]', { name: "twitter:card", content: "summary_large_image" });
    upsertMeta('meta[name="twitter:url"]', { name: "twitter:url", content: url });
    upsertMeta('meta[name="twitter:title"]', { name: "twitter:title", content: resolvedTitle });
    upsertMeta('meta[name="twitter:description"]', { name: "twitter:description", content: description || "" });
    upsertMeta('meta[name="twitter:image"]', { name: "twitter:image", content: img });
    upsertMeta('meta[name="twitter:image:alt"]', { name: "twitter:image:alt", content: alt });

    writeJsonLd(jsonLd);

    return undefined;
    // jsonLd is declared inline at call sites; serialise it for comparison so a
    // stable object literal does not retrigger the effect every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, fullTitle, description, path, image, imageAlt, type, noindex, JSON.stringify(jsonLd || null)]);
}

/** BreadcrumbList JSON-LD for a trail of [label, path] pairs. */
export function breadcrumbJsonLd(trail) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map(([name, itemPath], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: `${SITE_ORIGIN}${itemPath}`,
    })),
  };
}
