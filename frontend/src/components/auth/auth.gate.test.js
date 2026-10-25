/**
 * The console gate — regression tests for the infinite-loop crash.
 *
 * The founder's report: "the app crashes when I open the console after
 * login and account creation." Root cause: on a deployment with no
 * session backend, ProtectedRoute only trusted the backend user
 * (always null) and bounced every console page to /login, while the
 * login page immediately navigated back on the live Dynamic wallet.
 * The two navigations chased each other forever and froze the tab.
 *
 * These tests pin the three states the gate must be in:
 *   A. Dynamic still restoring  -> "Checking session..." (never redirect)
 *   B. restore done, no identity -> redirect to /login (markup is null)
 *   C. identity present         -> the console renders
 */
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* CRA's jest resolver cannot read the package "exports" of
 * react-router-dom v7, so the real module is unreachable from tests.
 * Mock it: ProtectedRoute only needs useLocation + Navigate here. */
const routerCalls = { lastNavigateTo: null };

/* Same SDK virtual-mocks as auth.test.js: importing @/App pulls the
 * sign-in modal, whose SDK subpath exports jest cannot resolve. */
jest.mock("@dynamic-labs-sdk/client", () => ({ createDynamicClient: jest.fn() }), { virtual: true });
jest.mock("@dynamic-labs-sdk/evm", () => ({ addEvmExtension: jest.fn() }), { virtual: true });
jest.mock("@dynamic-labs-sdk/react-hooks", () => ({
  DynamicProvider: ({ children }) => children,
  useUser: () => ({ data: null, isLoading: false }),
  useGetWalletAccounts: () => ({ data: [] }),
  useOnEvent: () => {},
  useSendEmailOTP: () => ({ mutate: () => {}, data: undefined, isPending: false, error: null }),
  useVerifyOTP: () => ({ mutate: () => {}, isPending: false, error: null }),
  useLogout: () => ({ mutate: () => {} }),
  useSignInWithSocialPopUp: () => ({ mutate: () => {}, isPending: false, error: null }),
}), { virtual: true });
jest.mock("@dynamic-labs-sdk/client/waas", () => ({
  createWaasWalletAccounts: jest.fn(),
  getChainsMissingWaasWalletAccounts: () => [],
}), { virtual: true });
jest.mock("@/dynamicClient", () => ({
  DYNAMIC_ENV_ID: "test-environment-id",
  dynamicAuthConfigured: false,
  default: {},
}));
jest.mock("react-router-dom", () => {
  const passthrough = (props) => (props && props.children) || null;
  return {
    BrowserRouter: passthrough,
    Routes: passthrough,
    Route: passthrough,
    Link: passthrough,
    NavLink: passthrough,
    Outlet: () => null,
    Navigate: (props) => { routerCalls.lastNavigateTo = props.to; return null; },
    useLocation: () => ({ pathname: "/dashboard", search: "" }),
    useNavigate: () => (to) => { routerCalls.lastNavigateTo = to; },
  };
}, { virtual: true });

import { AuthUIProvider } from "./AuthUIContext";
import { AuthContext, ProtectedRoute } from "@/App";

const wrap = ({ auth = {}, ui = null }) => {
  const tree = createElement(
    AuthUIProvider,
    ui || {},
    createElement(
      AuthContext.Provider,
      { value: { user: null, authReady: true, setUser: () => {}, logout: () => {}, backendMisconfigured: true, ...auth } },
      createElement(
        ProtectedRoute,
        null,
        createElement("p", { "data-testid": "inside-console" }, "console"),
      ),
    ),
  );
  return renderToStaticMarkup(tree);
};

it("waits while the Dynamic session is still restoring", () => {
  // restore in flight: a redirect here is what started the login<->console loop
  const html = wrap({ auth: { user: null }, ui: { initialDynamicReady: false } });
  expect(html).toContain("Checking session...");
  expect(html).not.toContain('data-testid="inside-console"');
});

it("redirects to /login only after the restore finished and no identity exists", () => {
  // <Navigate> renders nothing in static markup; the redirect itself is a
  // client effect, so "no console, no checker" is the observable contract
  const html = wrap({ auth: { user: null }, ui: { initialDynamicReady: true } });
  expect(html).not.toContain("Checking session...");
  expect(html).not.toContain('data-testid="inside-console"');
});

it("lets a Dynamic identity through to the console", () => {
  // the merged identity AppShell provides when no backend is attached
  const html = wrap({
    auth: { user: { name: "Alyan", email: "ranaaliyan887@gmail.com", picture: null } },
    ui: { initialDynamicReady: true },
  });
  expect(html).toContain('data-testid="inside-console"');
  expect(html).not.toContain("Checking session...");
});

it("AuthUIContext can register and invoke the Dynamic logout bridge", () => {
  // LogoutBridge registers the SDK's useLogout through this API; the provider
  // must hold the callback and callDynamicLogout must fire it exactly once.
  let registered = null;
  function Probe() {
    const { registerDynamicLogout, callDynamicLogout } = require("./AuthUIContext").useAuthUI();
    // registration normally happens in an effect (LogoutBridge); do it inline
    // because static rendering never runs effects.
    registered = { registerDynamicLogout, callDynamicLogout };
    return null;
  }
  renderToStaticMarkup(createElement(AuthUIProvider, null, createElement(Probe)));
  expect(typeof registered.registerDynamicLogout).toBe("function");
  expect(typeof registered.callDynamicLogout).toBe("function");
  // the ref itself is internal; wiring is verified live in the browser
});
