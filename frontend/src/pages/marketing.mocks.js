/**
 * Shared jest mocks for statically rendering the marketing pages.
 *
 * react-router-dom v7 publishes ESM only, which the jest 27 resolver shipped
 * with react-scripts cannot resolve; the marketing pages only need navigation
 * primitives. axios 1.x ships ESM the same resolver cannot parse; pages only
 * touch it from effects, which renderToStaticMarkup never runs. sonner and the
 * API constants are imported but never invoked during a static render.
 *
 * Imported FIRST (before any page import) by the design smoke test and the
 * prerender script so both see the same static-render world.
 */

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
    const Passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
    // A router Link renders an anchor with an href — mirror that, so tests can
    // assert on the destination the way a crawler would see it. Router-only
    // props are resolved here too: `end` is a NavLink matching flag (React warns
    // if it reaches the DOM) and NavLink's `className` is a function.
    const Anchor = ({ children, to, end, className, ...rest }) => {
      const target = typeof to === "string" ? to : rest.href;
      const resolved = typeof className === "function" ? className({ isActive: false, isPending: false }) : className;
      return React.createElement("a", { ...rest, href: target, className: resolved }, children);
    };
    return {
      BrowserRouter: Passthrough,
      MemoryRouter: Passthrough,
      Routes: Passthrough,
      Route: () => null,
      Navigate: () => null,
      Outlet: () => null,
      Link: Anchor,
      NavLink: Anchor,
      useNavigate: () => () => {},
      useLocation: () => ({ pathname: "/" }),
    };
  },
  { virtual: true }
);
