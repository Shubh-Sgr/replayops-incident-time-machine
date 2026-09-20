import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { useAuth } from "./providers/AuthProvider";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const IncidentWorkbenchPage = lazy(() => import("./pages/IncidentWorkbenchPage").then((module) => ({ default: module.IncidentWorkbenchPage })));
const IncidentsPage = lazy(() => import("./pages/IncidentsPage").then((module) => ({ default: module.IncidentsPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));

function RouteFallback() {
  return <div className="flex min-h-[45dvh] items-center justify-center text-sm text-muted">Calibrating workspace…</div>;
}

function ProtectedApp() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-canvas text-sm text-muted">Restoring session…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <AppShell />;
}

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedApp />}>
          <Route index element={<DashboardPage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="incidents/:id" element={<IncidentWorkbenchPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
