import { AnimatePresence, motion } from "framer-motion";
import { Activity, Bell, CircleUserRound, LogOut, Menu, Moon, RadioTower, Rocket, Search, Settings2, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "../lib/utils";
import { api } from "../lib/api";
import { useAuth } from "../providers/AuthProvider";
import { useTheme } from "../providers/ThemeProvider";
import { CommandSearch } from "./CommandSearch";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const navigation = [
  { to: "/", label: "Incidents", icon: Activity, end: true },
  { to: "/releases", label: "Releases", icon: Rocket, end: false },
  { to: "/integrations", label: "Sources", icon: RadioTower, end: false },
  { to: "/workspace", label: "Settings", icon: Settings2, end: false }
];

export function AppShell() {
  const location = useLocation();
  const [mobileNav, setMobileNav] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const notifications = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, refetchInterval: 20_000 });
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  const queryClient=useQueryClient();
  const notificationState=useMutation({mutationFn:({id,input}:{id:string;input:{read?:boolean;resolved?:boolean}})=>api.updateNotification(id,input),onSuccess:()=>void queryClient.invalidateQueries({queryKey:["notifications"]})});

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
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
          <p className="measurement-number text-xs text-muted">INCIDENT TIME MACHINE</p>
        </div>
      </div>

      <WorkspaceSwitcher onSwitched={() => setMobileNav(false)} />

      <nav className={cn("mt-6 space-y-1", mobile && "mt-5")} aria-label="Primary navigation">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setMobileNav(false)}
            className={({ isActive }) => cn(
              "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold transition-colors",
              isActive || (item.to === "/" && location.pathname.startsWith("/incidents/")) ? "bg-ink text-panel" : "text-muted hover:bg-elevated hover:text-ink"
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
              <p className="truncate text-xs text-muted">{user?.demo ? "Demo" : user?.email} · <span className="capitalize">{workspace.data?.role ?? "checking role"}</span></p>
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
            <kbd className="measurement-number ml-auto hidden rounded bg-panel px-1.5 py-0.5 text-xs text-faint sm:inline">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button className="control-quiet !px-3" onClick={toggleTheme} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
            <div className="relative"><button className="control-quiet relative !px-3" aria-label="Action notifications" onClick={() => setNotificationsOpen((value) => !value)}><Bell className="h-4 w-4" />{notifications.data?.some((item)=>!item.read) ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger" /> : null}<span className="sr-only">{notifications.data?.length ?? 0} actions need attention</span></button>{notificationsOpen && <div className="absolute right-0 top-12 z-40 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-panel border border-line bg-panel shadow-drawer"><div className="border-b border-line px-4 py-3"><p className="text-sm font-semibold">Actions needing attention</p><p className="mt-0.5 text-xs text-muted">Open the exact task or resolve the reminder when it is no longer actionable.</p></div><div className="max-h-96 overflow-y-auto">{notifications.data?.map((item) => <div key={item.id} className={cn("border-b border-line px-4 py-3 last:border-b-0",!item.read&&"bg-info/5")}><Link to={item.href} onClick={() => {notificationState.mutate({id:item.id,input:{read:true}});setNotificationsOpen(false);}} className="block hover:text-info"><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold">{item.title}</p><span className={cn("measurement-number text-xs uppercase",item.urgency==="urgent"?"text-danger":"text-muted")}>{item.urgency}</span></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{item.detail}</p><p className="mt-1 text-xs text-faint">{item.reason}</p></Link><button className="mt-2 text-xs font-semibold text-muted underline hover:text-ink" onClick={()=>notificationState.mutate({id:item.id,input:{read:true,resolved:true}})}>Resolve reminder</button></div>)}{notifications.data && !notifications.data.length && <div className="px-4 py-10 text-center text-sm text-muted">No operational actions are waiting.</div>}</div></div>}</div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8">
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-panel bg-ink p-1.5 text-panel shadow-drawer lg:hidden" aria-label="Mobile commands">
        {navigation.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cn("flex min-h-11 flex-1 items-center justify-center gap-2 rounded-control text-xs font-semibold", isActive ? "bg-panel text-ink" : "text-panel/70")}><item.icon className="h-4 w-4" />{item.label}</NavLink>
        ))}
      </nav>

      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
