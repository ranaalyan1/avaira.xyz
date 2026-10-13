import axios from "axios";

const rawBase = process.env.REACT_APP_BACKEND_URL;

if (!rawBase && typeof window !== "undefined") {
  // Keep the app functional in misconfigured environments.
  console.warn("REACT_APP_BACKEND_URL is not set. Falling back to current origin.");
}

export const API_BASE = (rawBase || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8001")).replace(/\/$/, "");
export const API = `${API_BASE}/api`;

// Use cookie-based sessions consistently across all API calls.
axios.defaults.withCredentials = true;
axios.defaults.timeout = 15000;

/** Error code set when an "API" response is really the SPA's own HTML. */
export const HTML_RESPONSE = "AV_API_HTML_RESPONSE";

/**
 * A deployed SPA rewrites every unknown path to `index.html` so deep links work
 * (see `vercel.json`: `/(.*) -> /index.html`). That rewrite also swallows
 * `/api/*`, so a request that should be a 404 from the API instead comes back as
 * the app's own HTML **with HTTP 200**. Axios resolves it, and the caller gets a
 * string where it expects an object.
 *
 * That is not a cosmetic problem: `GET /api/auth/me` returning HTML made
 * `setUser(html)` a truthy string, so `ProtectedRoute` rendered the console for
 * an anonymous visitor instead of redirecting to /login. Reject those responses
 * so every caller falls into the `catch` it already has.
 */
export function isHtmlResponse(response) {
  const contentType = (response && response.headers && response.headers["content-type"]) || "";
  return typeof (response && response.data) === "string" && contentType.includes("text/html");
}

axios.interceptors.response.use((response) => {
  if (isHtmlResponse(response)) {
    const url = (response.config && response.config.url) || "the API";
    const error = new Error(
      `${url} answered with HTML, not JSON — the API is not reachable at ${API_BASE}. ` +
        `The SPA rewrite is serving index.html for /api/* (set REACT_APP_BACKEND_URL to the backend).`
    );
    error.code = HTML_RESPONSE;
    error.response = response;
    throw error;
  }
  return response;
});

/**
 * `GET /api/auth/me` returns the user object, or 401 when signed out. Decide
 * "signed in" on the *shape* of the payload, never on the request having
 * resolved: any non-object body (HTML, a redirect page, a bare string) means
 * "not signed in".
 */
export function normalizeSessionUser(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data;
}
