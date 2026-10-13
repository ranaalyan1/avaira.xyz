jest.mock("axios", () => ({
  defaults: {},
  interceptors: { response: { use: jest.fn() } },
}));

describe("api config", () => {
  const originalBackend = process.env.REACT_APP_BACKEND_URL;

  afterEach(() => {
    jest.resetModules();
    if (originalBackend === undefined) {
      delete process.env.REACT_APP_BACKEND_URL;
    } else {
      process.env.REACT_APP_BACKEND_URL = originalBackend;
    }
  });

  it("builds API URL from REACT_APP_BACKEND_URL and trims trailing slash", () => {
    process.env.REACT_APP_BACKEND_URL = "https://backend.example.com/";

    jest.isolateModules(() => {
      const { API_BASE, API } = require("./api");
      const axios = require("axios");

      expect(API_BASE).toBe("https://backend.example.com");
      expect(API).toBe("https://backend.example.com/api");
      expect(axios.defaults.withCredentials).toBe(true);
      expect(axios.defaults.timeout).toBe(15000);
    });
  });

  it("falls back safely when backend URL env is missing", () => {
    delete process.env.REACT_APP_BACKEND_URL;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    jest.isolateModules(() => {
      const { API_BASE, API } = require("./api");

      expect(API_BASE.length).toBeGreaterThan(0);
      expect(API).toBe(`${API_BASE}/api`);
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("SPA-rewrite guard", () => {
  // The deployment bug this pins: `/(.*) -> /index.html` means `/api/*` can be
  // answered by the app's own HTML with HTTP 200. Axios resolves, so the caller
  // gets a string where it expects an object.
  const html = '<!doctype html><html><head><title>AVAIRA</title></head></html>';

  const load = () => {
    let mod;
    jest.isolateModules(() => {
      mod = require("./api");
    });
    return mod;
  };

  it("treats a 200 text/html body as an error, not data", () => {
    const { isHtmlResponse, HTML_RESPONSE } = load();
    const response = { data: html, headers: { "content-type": "text/html; charset=utf-8" } };

    expect(isHtmlResponse(response)).toBe(true);
    expect(HTML_RESPONSE).toBe("AV_API_HTML_RESPONSE");
  });

  it("leaves real JSON and empty bodies alone", () => {
    const { isHtmlResponse } = load();

    expect(isHtmlResponse({ data: { user_id: "u1" }, headers: { "content-type": "application/json" } })).toBe(false);
    expect(isHtmlResponse({ data: "", headers: {} })).toBe(false); // 204 No Content
    expect(isHtmlResponse({ data: "ok", headers: { "content-type": "text/plain" } })).toBe(false);
  });

  it("registers the interceptor so HTTP responses are checked", () => {
    // axios and ./api have to be required in the *same* module registry, or the
    // mock the test holds is not the one the interceptor was registered on.
    jest.isolateModules(() => {
      const axios = require("axios");
      require("./api");
      expect(axios.interceptors.response.use).toHaveBeenCalled();
    });
  });

  it("never treats a non-object session payload as a signed-in user", () => {
    const { normalizeSessionUser } = load();

    // The regression: an HTML string is truthy, so `setUser(html)` un-hid the console.
    expect(normalizeSessionUser(html)).toBe(null);
    expect(normalizeSessionUser("")).toBe(null);
    expect(normalizeSessionUser(null)).toBe(null);
    expect(normalizeSessionUser(undefined)).toBe(null);
    expect(normalizeSessionUser(["not", "a", "user"])).toBe(null);
    expect(normalizeSessionUser(42)).toBe(null);

    const user = { user_id: "u1", email: "agent@avaira.xyz", is_admin: false };
    expect(normalizeSessionUser(user)).toEqual(user);
  });
});
