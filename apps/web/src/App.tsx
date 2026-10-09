import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { useAuth } from "./providers/AuthProvider";

const IncidentWorkbenchPage = lazy(() => import("./pages/IncidentWorkbenchPage").then((module) => ({ default: module.IncidentWorkbenchPage })));
const IncidentsPage = lazy(() => import("./pages/IncidentsPage").then((module) => ({ default: module.IncidentsPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((module) => ({ default: module.IntegrationsPage })));
const ReleasesPage = lazy(() => import("./pages/ReleasesPage").then((module) => ({ default: module.ReleasesPage })));
const WorkspacePage = lazy(() => import("./pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage })));
const AcceptInvitePage = lazy(() => import("./pages/AcceptInvitePage").then((module) => ({ default: module.AcceptInvitePage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));

function RouteFallback() {
  return <div className="flex min-h-[45dvh] items-center justify-center text-sm text-muted">Loading…</div>;
}

function ProtectedApp() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-canvas text-sm text-muted">Restoring session…</div>;
  if (!user) return <Navigate to="/login" state={{ from: `${location.pathname}${location.search}` }} replace />;
  return <AppShell />;
}

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedApp />}>
          <Route index element={<IncidentsPage />} />
          <Route path="incidents" element={<Navigate to="/" replace />} />
          <Route path="incidents/:id" element={<IncidentWorkbenchPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="releases" element={<ReleasesPage />} />
          <Route path="workspace" element={<WorkspacePage />} />
          <Route path="accept-invite" element={<AcceptInvitePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
