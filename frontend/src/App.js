import "@/App.css";
import "@/pixel.css";
import "@/theme-noir.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState, createContext, useContext, useCallback } from "react";
import Lenis from "lenis";
import axios from "axios";
import Layout from "@/components/Layout";
import Landing from "@/pages/Landing";
import GatePage from "@/pages/GatePage";
import ScorePage from "@/pages/ScorePage";
import EvidencePage from "@/pages/EvidencePage";
import DocsPage from "@/pages/DocsPage";
import Login from "@/pages/Login";
import Contact from "@/pages/Contact";
import NotFound from "@/pages/NotFound";
import CookieConsent from "@/components/CookieConsent";
import Dashboard from "@/pages/Dashboard";
import AgentRegistry from "@/pages/AgentRegistry";
import ExecutionFlow from "@/pages/ExecutionFlow";
import FreezeSlash from "@/pages/FreezeSlash";
import Treasury from "@/pages/Treasury";
import Reputation from "@/pages/Reputation";
import Underwriters from "@/pages/Underwriters";
import SDKDocs from "@/pages/SDKDocs";
import HardeningReport from "@/pages/HardeningReport";
import { Toaster } from "sonner";
import { API, HTML_RESPONSE, normalizeSessionUser } from "@/lib/api";

export const AuthContext = createContext({ user: null, authReady: false, setUser: () => {}, logout: () => {}, backendMisconfigured: false });
export const useAuth = () => useContext(AuthContext);

/**
 * Lenis smooth scroll — the scroll feel the new design is built around.
 * Skipped entirely for visitors who asked the OS for less motion; native
 * scrolling (and every anchor link) keeps working either way.
 */
function useSmoothScroll() {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;

    const lenis = new Lenis({ lerp: 0.12, wheelMultiplier: 1, smoothWheel: true });
    let frame;
    const raf = (time) => {
      lenis.raf(time);
      frame = window.requestAnimationFrame(raf);
    };
    frame = window.requestAnimationFrame(raf);
    return () => {
      window.cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, []);
}

function ProtectedRoute({ children }) {
  const { user, authReady } = useAuth();
  if (!authReady) {
    return <div className="p-6 font-mono text-xs text-avaira-muted">Checking session...</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function AppRoutes() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/gate" element={<GatePage />} />
        <Route path="/score" element={<ScorePage />} />
        <Route path="/evidence" element={<EvidencePage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/login" element={<Login />} />
        <Route
          element={(
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          )}
        >
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/agents" element={<AgentRegistry />} />
          <Route path="/executions" element={<ExecutionFlow />} />
          <Route path="/freeze" element={<FreezeSlash />} />
          <Route path="/treasury" element={<Treasury />} />
          <Route path="/reputation" element={<Reputation />} />
          <Route path="/underwriters" element={<Underwriters />} />
          <Route path="/hardening-report" element={<HardeningReport />} />
          <Route path="/sdk" element={<SDKDocs />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}

function App() {
  useSmoothScroll();
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  // True when /api/* is being answered by the SPA rewrite, i.e. this deployment
  // has no backend attached. The sign-in page says so instead of sending the
  // visitor into a redirect that can only land on the app's own 404.
  const [backendMisconfigured, setBackendMisconfigured] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/auth/me`, { withCredentials: true });
      // Only a user *object* counts as signed in. On a deployment where the SPA
      // rewrite answers /api/* (no backend configured), this call resolves with
      // the app's own HTML and the old `setUser(res.data)` marked an anonymous
      // visitor as authenticated — which rendered the console instead of /login.
      setUser(normalizeSessionUser(res.data));
    } catch (e) {
      // "Not logged in" (401) and "no backend at all" (HTML) both land here, and
      // only the second one is worth telling the visitor about.
      if (e && e.code === HTML_RESPONSE) setBackendMisconfigured(true);
    }
    finally { setAuthReady(true); }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const logout = async () => {
    try { await axios.post(`${API}/auth/logout`, {}, { withCredentials: true }); } catch {}
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, authReady, setUser, logout, backendMisconfigured }}>
      <div className="min-h-screen bg-avaira-bg">
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
        <CookieConsent />
        <Toaster
          position="top-right"
          toastOptions={{
            // Tokens resolve inside the console scope, where toasts are raised.
            style: {
              background: 'rgb(var(--surface-raised))',
              border: '1px solid rgb(var(--hairline-strong))',
              color: 'rgb(var(--text-primary))',
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: '0.8125rem',
              borderRadius: '10px',
              boxShadow: '0 12px 32px -16px rgba(0,0,0,0.6)',
            },
          }}
        />
      </div>
    </AuthContext.Provider>
  );
}

export default App;
