import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, UserCheck, Workflow, ShieldOff, Wallet, TrendingUp, Code, Menu, X, Users, BookOpen, LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/App";

const NAV_ITEMS = [
  { path: "/dashboard", label: "DASHBOARD", icon: LayoutDashboard },
  { path: "/agents", label: "AGENT REGISTRY", icon: UserCheck },
  { path: "/executions", label: "EXECUTION FLOW", icon: Workflow },
  { path: "/underwriters", label: "UNDERWRITERS", icon: Users },
  { path: "/compliance", label: "COMPLIANCE", icon: ShieldCheck },
  { path: "/freeze", label: "FREEZE / SLASH", icon: ShieldOff },
  { path: "/treasury", label: "TREASURY", icon: Wallet },
  { path: "/reputation", label: "REPUTATION", icon: TrendingUp },
  { path: "/sdk", label: "SDK DOCS", icon: BookOpen },
];

const PAGE_META = {
  "/dashboard": "Protocol telemetry and live state",
  "/agents": "Registration, risk envelopes, and status control",
  "/executions": "Lifecycle traces and trust verification",
  "/underwriters": "Mission markets and underwriting coverage",
  "/compliance": "Cleanverse CVI/CVA — identity-bound asset movement",
  "/freeze": "Policy enforcement, freeze and slash actions",
  "/treasury": "Fee capture, split accounting, and treasury flow",
  "/reputation": "Score engine, rank movement, and trust data",
  "/sdk": "Developer integration docs and references",
};

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const currentNav = NAV_ITEMS.find((item) => item.path === location.pathname);

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="flex min-h-screen" data-testid="app-layout">
      {/* Mobile toggle */}
      <button
        data-testid="mobile-menu-toggle"
        className="fixed top-4 left-4 z-50 lg:hidden p-2 border border-avaira-border bg-avaira-card"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X size={20} className="text-avaira-primary" /> : <Menu size={20} className="text-avaira-primary" />}
      </button>

      {/* Sidebar */}
      <aside
        data-testid="sidebar"
        className={`fixed inset-y-0 left-0 z-40 w-56 bg-avaira-card border-r border-avaira-border flex flex-col transition-transform duration-300 ${mobileOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
      >
        {/* Logo */}
        <div className="p-5 border-b border-avaira-border flex items-center gap-3">
          <img src="/logo.png" alt="AVAIRA" className="w-10 h-10" data-testid="sidebar-logo" />
          <div>
            <h1 className="font-heading font-bold text-2xl tracking-tight text-avaira-primary uppercase" data-testid="app-logo">
              AVAIRA
            </h1>
            <p className="font-mono text-[8px] text-avaira-muted tracking-widest">EXECUTION CONTROL</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 overflow-y-auto" data-testid="main-nav">
          {NAV_ITEMS.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                data-testid={`nav-${item.path.slice(1)}`}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-5 py-2.5 text-xs font-mono tracking-wider transition-all duration-200 border-l-2 ${
                  isActive
                    ? "border-avaira-primary text-avaira-primary bg-avaira-primary/5"
                    : "border-transparent text-avaira-muted hover:text-foreground hover:border-avaira-border hover:bg-white/[0.02]"
                }`}
              >
                <item.icon size={16} strokeWidth={1.5} />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        {/* User / Footer */}
        <div className="border-t border-avaira-border">
          {user && (
            <div className="p-4 border-b border-avaira-border">
              <div className="flex items-center gap-2">
                {user.picture ? (
                  <img src={user.picture} alt="" className="w-6 h-6 rounded-full" />
                ) : (
                  <div className="w-6 h-6 bg-avaira-primary/20 flex items-center justify-center">
                    <span className="font-mono text-[10px] text-avaira-primary">{user.name?.[0] || '?'}</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[10px] text-foreground truncate">{user.name}</p>
                  <p className="font-mono text-[8px] text-avaira-dim truncate">{user.email}</p>
                </div>
                <button data-testid="logout-btn" onClick={handleLogout} className="p-1 text-avaira-dim hover:text-avaira-primary transition-colors">
                  <LogOut size={12} />
                </button>
              </div>
            </div>
          )}
          <div className="p-4">
            <div className="flex items-center gap-2">
              <span className="status-dot active" />
              <span className="font-mono text-[10px] text-avaira-green tracking-wider">PROTOCOL ONLINE</span>
            </div>
            <p className="font-mono text-[9px] text-avaira-dim mt-1">TRUST & ACCOUNTABILITY ENGINE</p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="app-main-surface flex-1 lg:ml-56 min-h-screen" data-testid="main-content">
        <div className="app-main-container">
          <header className="app-topbar px-4 sm:px-6 md:px-8 py-3 mt-16 lg:mt-0 pl-16 sm:pl-6 md:pl-8">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5">
              <p className="font-heading font-bold text-sm text-foreground uppercase tracking-tight">
                {currentNav?.label || "CONTROL PANEL"}
              </p>
              <p className="font-mono text-[10px] text-avaira-dim uppercase tracking-wider">
                {PAGE_META[location.pathname] || "Execution control operations"}
              </p>
            </div>
          </header>
          <div className="p-4 sm:p-6 md:p-8">
            <Outlet />
          </div>
        </div>
        <footer className="px-6 md:px-8 py-4 border-t border-avaira-border">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="font-mono text-[10px] text-avaira-dim">AVAIRA Protocol | v2.0-core</p>
            <p className="font-mono text-[10px] text-avaira-dim">Real-time trust and automated consequences</p>
          </div>
        </footer>
      </main>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-30 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}
    </div>
  );
}
