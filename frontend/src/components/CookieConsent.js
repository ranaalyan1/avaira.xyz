/**
 * Cookie banner + preferences panel.
 *
 * Two categories only, because that is all the site uses:
 *   necessary  — the session cookie and this consent record. Always on.
 *   analytics  — conversion events (src/lib/analytics.js). Off until granted.
 *
 * The banner renders once per browser until the visitor decides; the
 * preferences panel stays reachable afterwards through the floating
 * "Cookies" control so a decision is never final.
 */
import { useEffect, useState } from "react";
import { getConsent, saveConsent } from "@/lib/consent";

export default function CookieConsent() {
  const [consent, setConsent] = useState(() => getConsent());
  const [panelOpen, setPanelOpen] = useState(false);
  const [analyticsChoice, setAnalyticsChoice] = useState(consent.analytics);

  useEffect(() => {
    setAnalyticsChoice(consent.analytics);
  }, [consent.analytics]);

  const decide = (analytics) => {
    setConsent(saveConsent({ analytics }));
    setPanelOpen(false);
  };

  const bannerVisible = !consent.decided && !panelOpen;

  return (
    <>
      {bannerVisible && (
        <div className="ck-banner" role="region" aria-label="Cookie consent" data-testid="cookie-banner">
          <p className="ck-title">Cookies on this site</p>
          <p className="ck-body">
            Necessary cookies keep a signed-in session working. Optional analytics measure which
            pages convert. Nothing is set for the second purpose until you allow it.
          </p>
          <div className="ck-actions">
            <button type="button" className="ck-btn ck-btn-accent" onClick={() => decide(true)} data-testid="cookie-accept-all">
              Allow all
            </button>
            <button type="button" className="ck-btn" onClick={() => decide(false)} data-testid="cookie-necessary-only">
              Necessary only
            </button>
            <button type="button" className="ck-btn ck-btn-quiet" onClick={() => setPanelOpen(true)} data-testid="cookie-preferences-open">
              Preferences
            </button>
          </div>
        </div>
      )}

      {panelOpen && (
        <div className="ck-panel-veil" role="dialog" aria-modal="true" aria-label="Cookie preferences">
          <div className="ck-panel" data-testid="cookie-preferences-panel">
            <p className="ck-title">Cookie preferences</p>

            <div className="ck-row">
              <div>
                <p className="ck-row-name">Necessary</p>
                <p className="ck-body">Session cookie for sign-in and this consent record. Required for the site to work.</p>
              </div>
              <span className="ck-pill" aria-label="Always on">Always on</span>
            </div>

            <div className="ck-row">
              <div>
                <p className="ck-row-name">Analytics</p>
                <p className="ck-body">Anonymous conversion events: which call-to-action was used, whether the contact form was sent.</p>
              </div>
              <label className="ck-switch">
                <input
                  type="checkbox"
                  checked={analyticsChoice}
                  onChange={(e) => setAnalyticsChoice(e.target.checked)}
                  data-testid="cookie-analytics-toggle"
                />
                <span>{analyticsChoice ? "On" : "Off"}</span>
              </label>
            </div>

            <div className="ck-actions">
              <button type="button" className="ck-btn ck-btn-accent" onClick={() => decide(analyticsChoice)} data-testid="cookie-save">
                Save choices
              </button>
              <button type="button" className="ck-btn ck-btn-quiet" onClick={() => setPanelOpen(false)} data-testid="cookie-close">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {consent.decided && !panelOpen && (
        <button
          type="button"
          className="ck-reopen"
          onClick={() => setPanelOpen(true)}
          aria-label="Open cookie preferences"
          data-testid="cookie-preferences-reopen"
        >
          Cookies
        </button>
      )}
    </>
  );
}
