/**
 * Cookie / storage consent state.
 *
 * One record in localStorage, one custom event. The banner and the
 * preferences panel write through `saveConsent`; anything that wants to act
 * on consent (the analytics module) reads `getConsent()` and listens for
 * `avaira:consent`. "Necessary" is always on: it covers the session cookie
 * that signs a visitor in and this consent record itself.
 */

export const CONSENT_KEY = "avaira.consent.v1";
export const CONSENT_EVENT = "avaira:consent";

export const DEFAULT_CONSENT = Object.freeze({
  necessary: true,
  analytics: false,
  decided: false, // becomes true once the visitor acts on the banner
});

export function getConsent() {
  if (typeof window === "undefined") return { ...DEFAULT_CONSENT };
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return { ...DEFAULT_CONSENT };
    const parsed = JSON.parse(raw);
    return {
      necessary: true,
      analytics: Boolean(parsed.analytics),
      decided: Boolean(parsed.decided),
    };
  } catch {
    return { ...DEFAULT_CONSENT };
  }
}

export function saveConsent({ analytics }) {
  const record = { necessary: true, analytics: Boolean(analytics), decided: true, updatedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  } catch {
    // Storage denied (private mode, policy): treat as session-only consent.
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: record }));
  return record;
}

export function onConsentChange(handler) {
  const listener = (event) => handler(event.detail || getConsent());
  window.addEventListener(CONSENT_EVENT, listener);
  return () => window.removeEventListener(CONSENT_EVENT, listener);
}
