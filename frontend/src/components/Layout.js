import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, UserCheck, Workflow, ShieldOff, Wallet, TrendingUp, BookOpen,
  Menu, X, Users, LogOut, ChevronRight, Search,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/App";

const NAV_GROUPS = [
  {
    label: "Monitor",
    items: [
      { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { path: "/agents", label: "Agent registry", icon: UserCheck },
      { path: "/executions", label: "Execution flow", icon: Workflow },
      { path: "/reputation", label: "Reputation", icon: TrendingUp },
    ],
  },
  {
    label: "Control",
    items: [
      { path: "/underwriters", label: "Underwriters", icon: Users },
      { path: "/freeze", label: "Freeze / slash", icon: ShieldOff },
      { path: "/treasury", label: "Treasury", icon: Wallet },
      { path: "/sdk", label: "SDK docs", icon: BookOpen },
    ],
  },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

const PAGE_META = {
  "/dashboard": "Protocol telemetry and live state",
  "/agents": "Registration, risk envelopes, and status control",
  "/executions": "Lifecycle traces and trust verification",
  "/underwriters": "Mission markets and underwriting coverage",
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
    <div className="flex min-h-screen bg-avaira-bg" data-testid="app-layout">
      {/* Mobile toggle */}
      <button
        data-testid="mobile-menu-toggle"
        aria-label="Toggle navigation"
        className="fixed left-4 top-3.5 z-50 rounded-lg border border-avaira-border bg-avaira-card p-2 lg:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Sidebar */}
      <aside
        data-testid="sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-[236px] flex-col border-r border-avaira-border bg-avaira-card/70 backdrop-blur-xl transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0`}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src="/logo.png" alt="AVAIRA" className="h-8 w-8 rounded-lg" data-testid="sidebar-logo" />
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground" data-testid="app-logo">
              AVAIRA
            </h1>
            <p className="truncate font-mono text-[9px] uppercase tracking-[0.16em] text-avaira-dim">
              Execution control
            </p>
          </div>
        </div>

        <div className="px-3 pb-2">
          <button className="flex w-full items-center gap-2 rounded-lg border border-avaira-border bg-avaira-inset px-2.5 py-1.5 text-left text-[12px] text-avaira-dim transition-colors hover:border-avaira-primary/40 hover:text-avaira-muted">
            <Search size={13} />
            <span className="flex-1">Search</span>
            <span className="font-mono text-[10px] tracking-wider">⌘K</span>
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-2" data-testid="main-nav">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="px-2.5 pb-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-avaira-dim">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      data-testid={`nav-${item.path.slice(1)}`}
                      onClick={() => setMobileOpen(false)}
                      className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors ${
                        isActive
                          ? "bg-avaira-primary/12 text-avaira-primary"
                          : "text-avaira-muted hover:bg-avaira-surface hover:text-foreground"
                      }`}
                    >
                      <item.icon size={15} strokeWidth={1.9} />
                      <span className="truncate">{item.label}</span>
                      {isActive && <ChevronRight size={13} className="ml-auto opacity-70" />}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer: session + health */}
        <div className="border-t border-avaira-border">
          {user && (
            <div className="border-b border-avaira-border p-3">
              <div className="flex items-center gap-2.5">
                {user.picture ? (
                  <img src={user.picture} alt="" className="h-7 w-7 rounded-full" />
                ) : (
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-avaira-primary/15">
                    <span className="text-[11px] font-medium text-avaira-primary">{user.name?.[0] || '?'}</span>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-foreground">{user.name}</p>
                  <p className="truncate font-mono text-[9px] text-avaira-dim">{user.email}</p>
                </div>
                <button
                  data-testid="logout-btn"
                  onClick={handleLogout}
                  aria-label="Sign out"
                  className="rounded-md p-1.5 text-avaira-dim transition-colors hover:bg-avaira-surface hover:text-avaira-red"
                >
                  <LogOut size={13} />
                </button>
              </div>
            </div>
          )}
          <div className="p-3">
            <div className="flex items-center gap-2">
              <span className="status-dot active" />
              <span className="text-[11px] font-medium text-avaira-muted">Protocol online</span>
            </div>
            <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-avaira-dim">
              Trust &amp; accountability engine
            </p>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="app-main-surface min-h-screen flex-1 lg:ml-[236px]" data-testid="main-content">
        <div className="app-main-container">
          <header className="app-topbar px-4 py-3 pl-16 sm:px-6 lg:pl-6 md:px-8">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[14px] font-semibold tracking-tight text-foreground">
                {currentNav?.label || "Control panel"}
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-avaira-dim">
                {PAGE_META[location.pathname] || "Execution control operations"}
              </p>
            </div>
          </header>
          <div className="p-4 sm:p-6 md:p-8">
            <Outlet />
          </div>
        </div>
        <footer className="border-t border-avaira-border px-6 py-4 md:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-mono text-[10px] text-avaira-dim">AVAIRA Protocol · v2.0-core</p>
            <p className="font-mono text-[10px] text-avaira-dim">
              Real-time trust and automated consequences
            </p>
          </div>
        </footer>
      </main>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}
    </div>
  );
}
