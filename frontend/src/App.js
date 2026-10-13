import "@/App.css";
import "@/pixel.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState, createContext, useContext, useCallback } from "react";
import axios from "axios";
import Layout from "@/components/Layout";
import Landing from "@/pages/Landing";
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
import { API } from "@/lib/api";

export const AuthContext = createContext({ user: null, authReady: false, setUser: () => {}, logout: () => {} });
export const useAuth = () => useContext(AuthContext);

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

  const checkAuth = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/auth/me`, { withCredentials: true });
      setUser(res.data);
    } catch { /* not logged in */ }
    finally { setAuthReady(true); }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const logout = async () => {
    try { await axios.post(`${API}/auth/logout`, {}, { withCredentials: true }); } catch {}
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, authReady, setUser, logout }}>
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
  );
}

export default App;
