import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState, createContext, useContext, useCallback } from "react";
import axios from "axios";
import Layout from "@/components/Layout";
import Landing from "@/pages/Landing";
import Login from "@/pages/Login";
import NotFound from "@/pages/NotFound";
import Dashboard from "@/pages/Dashboard";
import AgentRegistry from "@/pages/AgentRegistry";
import ExecutionFlow from "@/pages/ExecutionFlow";
import FreezeSlash from "@/pages/FreezeSlash";
import Treasury from "@/pages/Treasury";
import Reputation from "@/pages/Reputation";
import Underwriters from "@/pages/Underwriters";
import Compliance from "@/pages/Compliance";
import SDKDocs from "@/pages/SDKDocs";
import HardeningReport from "@/pages/HardeningReport";
import DynamicProviderWrapper from "@/components/DynamicProviderWrapper";
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
          <Route path="/compliance" element={<Compliance />} />
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
        <div className="noise-overlay" />
        <DynamicProviderWrapper>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </DynamicProviderWrapper>
        <Toaster
          position="top-right"
          toastOptions={{
            style: { background: '#0A0A0A', border: '1px solid #333', color: '#E0E0E0', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.8125rem', borderRadius: '0' },
          }}
        />
      </div>
    </AuthContext.Provider>
  );
}

export default App;
