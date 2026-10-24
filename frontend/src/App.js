import "@/App.css";
import "@/pixel.css";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useEffect, useState, createContext, useContext, useCallback } from "react";
import axios from "axios";
import Layout from "@/components/Layout";
import Landing from "@/pages/Landing";
import ExecutionPage from "@/pages/ExecutionPage";
import EvidenceImmersive from "@/pages/EvidenceImmersive";
import GatePage from "@/pages/GatePage";
import ScorePage from "@/pages/ScorePage";
import EvidencePage from "@/pages/EvidencePage";
import DocsPage from "@/pages/DocsPage";
import Login from "@/pages/Login";
import NotFound from "@/pages/NotFound";
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthUIProvider, useAuthUI } from "@/components/auth/AuthUIContext";
import { DynamicAuthLayer } from "@/components/auth/DynamicAuth";
import SignInModal from "@/components/auth/SignInModal";
import { API, HTML_RESPONSE, normalizeSessionUser } from "@/lib/api";
import { ScrollTop } from "@/pages/immersive/shell";

/* one query client for the whole app (required by the Dynamic hooks) */
const queryClient = new QueryClient();

export const AuthContext = createContext({ user: null, authReady: false, setUser: () => {}, logout: () => {}, backendMisconfigured: false });
export const useAuth = () => useContext(AuthContext);

function ProtectedRoute({ children }) {
  const { user, authReady } = useAuth();
  const location = useLocation();
  if (!authReady) {
    return <div className="p-6 font-mono text-xs text-avaira-muted">Checking session...</div>;
  }
  if (!user) {
    /* keep where they were going: /login sends them back after sign-in */
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return children;
}

function AppRoutes() {
  return (
    <>
      <ScrollTop />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/execution" element={<ExecutionPage />} />
        <Route path="/evidence" element={<EvidenceImmersive />} />
        <Route path="/gate" element={<GatePage />} />
        <Route path="/score" element={<ScorePage />} />
        <Route path="/ledger" element={<EvidencePage />} />
        <Route path="/docs" element={<DocsPage />} />
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
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  // True when /api/* is being answered by the SPA rewrite, i.e. this deployment
  // has no backend attached. The sign-in page says so instead of sending the
  // visitor into a redirect that can only land on the app's own 404.
  const [backendMisconfigured, setBackendMisconfigured] = useState(false);

  const checkAuth = useCallback(async () => {
    /* no REACT_APP_BACKEND_URL means no session backend is attached to this
       deployment: the probe below would be answered by the SPA rewrite and
       could never return a session. Skip it instead of firing a doomed
       request on every page load. */
    if (!process.env.REACT_APP_BACKEND_URL) {
      setBackendMisconfigured(true);
      setAuthReady(true);
      return;
    }
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
    <AuthUIProvider>
      <AppShell user={user} setUser={setUser} authReady={authReady} logout={logout} backendMisconfigured={backendMisconfigured} />
    </AuthUIProvider>
  );
}

/* The tree under the light auth-UI context: TanStack Query outside,
   DynamicProvider (when configured) inside, modal + routes last. */
function AppShell({ user, setUser, authReady, logout, backendMisconfigured }) {
  const { setDynamicAuth } = useAuthUI();
  return (
    <QueryClientProvider client={queryClient}>
      <DynamicAuthLayer onState={setDynamicAuth}>
        {/* full email-OTP + embedded-wallet flow when configured */}
        <SignInModal />
      </DynamicAuthLayer>
      <AuthContext.Provider value={{ user, authReady, setUser, logout, backendMisconfigured }}>
      <div className="min-h-screen bg-avaira-bg">
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
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
    </QueryClientProvider>
  );
}

export default App;
