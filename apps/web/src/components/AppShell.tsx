import { AnimatePresence, motion } from "framer-motion";
import { Activity, Bell, Bot, CircleUserRound, Gauge, LogOut, Menu, Moon, RadioTower, Search, Settings2, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { cn } from "../lib/utils";
import { useAuth } from "../providers/AuthProvider";
import { useTheme } from "../providers/ThemeProvider";
import { AssistantDrawer } from "./AssistantDrawer";
import { CommandSearch } from "./CommandSearch";

const navigation = [
  { to: "/", label: "Operations", icon: Gauge, end: true },
  { to: "/incidents", label: "Incidents", icon: Activity, end: false },
  { to: "/integrations", label: "Connectors", icon: RadioTower, end: false },
  { to: "/workspace", label: "Workspace", icon: Settings2, end: false }
];

export function AppShell() {
  const [mobileNav, setMobileNav] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const incidentId = location.pathname.startsWith("/incidents/") ? location.pathname.split("/")[2] : undefined;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setAssistantOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const NavContent = ({ mobile = false }: { mobile?: boolean }) => (
    <>
      <div className={cn("flex items-center gap-3", mobile ? "px-1" : "px-2")}>
        <div className="relative flex h-10 w-10 items-center justify-center rounded-control bg-ink text-panel">
          <Activity className="h-5 w-5" />
          <span className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-accent ring-2 ring-rail" />
        </div>
        <div>
          <p className="font-heading text-lg font-semibold tracking-[-0.025em]">ReplayOps</p>
          <p className="measurement-number text-[10px] text-muted">INCIDENT TIME MACHINE</p>
        </div>
      </div>

      <nav className={cn("mt-8 space-y-1", mobile && "mt-6")} aria-label="Primary navigation">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setMobileNav(false)}
            className={({ isActive }) => cn(
              "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold transition-colors",
              isActive ? "bg-ink text-panel" : "text-muted hover:bg-elevated hover:text-ink"
            )}
          >
            <item.icon className="h-[18px] w-[18px]" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto pt-8">
        <div className="rounded-panel bg-elevated p-3">
          <div className="flex items-center gap-2.5">
            <CircleUserRound className="h-5 w-5 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{user?.name}</p>
              <p className="truncate text-xs text-muted">{user?.demo ? "Demo responder" : user?.email}</p>
            </div>
          </div>
          <button className="control-quiet mt-2 w-full !justify-start !px-2" onClick={() => void signOut()}><LogOut className="mr-2 h-4 w-4" /> Sign out</button>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-[100dvh] bg-canvas text-ink">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-rail p-5 lg:flex"><NavContent /></aside>

      <AnimatePresence>
        {mobileNav && (
          <>
            <motion.button className="fixed inset-0 z-40 bg-ink/20 lg:hidden" onClick={() => setMobileNav(false)} aria-label="Close navigation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.aside className="fixed inset-y-0 left-0 z-50 flex w-[290px] flex-col bg-rail p-5 shadow-drawer lg:hidden" initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={{ type: "spring", stiffness: 390, damping: 34 }}>
              <button className="control-quiet absolute right-3 top-3 !px-3" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X className="h-4 w-4" /></button>
              <NavContent mobile />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <button className="control-quiet !px-3 lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></button>
          <button className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-control bg-rail px-3 text-left text-sm text-muted transition-colors hover:bg-elevated hover:text-ink sm:max-w-md" onClick={() => setSearchOpen(true)}>
            <Search className="h-4 w-4 shrink-0" />
            <span className="truncate">Search incident evidence</span>
            <kbd className="measurement-number ml-auto hidden rounded bg-panel px-1.5 py-0.5 text-[10px] text-faint sm:inline">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button className="control-quiet !px-3" onClick={toggleTheme} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
            <button className="control-quiet !px-3" aria-label="Notifications"><Bell className="h-4 w-4" /><span className="sr-only">2 unread</span></button>
            <button className="control-primary !px-3 sm:!px-4" onClick={() => setAssistantOpen(true)} aria-label="Ask ReplayOps"><Bot className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">Ask ReplayOps</span></button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8">
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-panel bg-ink p-1.5 text-panel shadow-drawer lg:hidden" aria-label="Mobile commands">
        {navigation.filter((item) => item.to !== "/workspace").map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cn("flex min-h-11 flex-1 items-center justify-center gap-2 rounded-control text-xs font-semibold", isActive ? "bg-panel text-ink" : "text-panel/70")}><item.icon className="h-4 w-4" />{item.label}</NavLink>
        ))}
        <button className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-control text-xs font-semibold text-panel/70" onClick={() => setAssistantOpen(true)}><Bot className="h-4 w-4" />Assistant</button>
      </nav>

      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <AssistantDrawer open={assistantOpen} incidentId={incidentId} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
