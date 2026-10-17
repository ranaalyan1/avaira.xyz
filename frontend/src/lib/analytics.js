/**
 * Conversion event tracking, gated on consent.
 *
 * `track(name, props)` is the only call sites use. Events are buffered until
 * the visitor grants the analytics category, then flushed; without consent
 * nothing leaves the page. Delivery is intentionally vendor-neutral: events
 * go to `window.dataLayer` (GTM-style) and to `window.plausible` when either
 * exists, so attaching a real analytics vendor later is a tag, not a refactor.
 *
 * Conversion events used across the site:
 *   signin_started       {provider}            visitor clicked an OAuth button
 *   console_opened       {source}              a "launch console" CTA was used
 *   docs_opened          {source}              a "read the docs" CTA was used
 *   contact_submitted    {topic}               the contact form posted OK
 *   outbound_github      {href}                a repository link was followed
 */
import { getConsent, onConsentChange } from "@/lib/consent";

const DEBUG = process.env.NODE_ENV === "development";
const queue = [];
let flushBound = false;

function deliver(event) {
  if (typeof window === "undefined") return;
  const payload = { event: event.name, ...event.props, ts: event.ts };
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(payload);
  if (typeof window.plausible === "function") {
    window.plausible(event.name, { props: event.props });
  }
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.debug("[analytics]", event.name, event.props);
  }
}

function flush() {
  while (queue.length) deliver(queue.shift());
}

function ensureFlushListener() {
  if (flushBound || typeof window === "undefined") return;
  flushBound = true;
  onConsentChange((consent) => {
    if (consent.analytics) flush();
    else queue.length = 0; // consent withdrawn: drop anything pending
  });
}

/** Record one conversion event. Safe to call anywhere, including SSR/tests. */
export function track(name, props = {}) {
  if (typeof window === "undefined") return;
  ensureFlushListener();
  const event = { name, props, ts: Date.now() };
  const consent = getConsent();
  if (consent.analytics) {
    deliver(event);
  } else if (!consent.decided) {
    // Banner not answered yet: hold the event, flush if they opt in.
    queue.push(event);
    if (queue.length > 50) queue.shift();
  }
  // Decided + declined: event is discarded.
}
