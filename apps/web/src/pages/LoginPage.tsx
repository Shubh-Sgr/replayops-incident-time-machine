import { motion } from "framer-motion";
import { Activity, ArrowRight, CheckCircle2, Github, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { CausalTrace } from "../components/CausalTrace";
import { TEST_CREDENTIALS, useAuth } from "../providers/AuthProvider";
import type { Incident } from "../types";

const previewIncident: Incident = {
  id: "preview",
  code: "ROP-1842",
  title: "Checkout retry amplification",
  summary: "Synthetic preview",
  service: "checkout-api",
  severity: "critical",
  status: "identified",
  owner: "Maya Chen",
  startedAt: "2026-09-20T05:41:12.000Z",
  resolvedAt: null,
  createdAt: "2026-09-20T05:44:00.000Z",
  updatedAt: "2026-09-20T06:06:00.000Z",
  events: [
    { id: "p1", incidentId: "preview", timestamp: "2026-09-20T05:41:12.000Z", service: "inventory-api", kind: "metric", title: "Replica lag", detail: "Replica lag crossed the checkout consistency budget.", impactScore: 46 },
    { id: "p2", incidentId: "preview", timestamp: "2026-09-20T05:45:03.000Z", service: "checkout-api", kind: "alert", title: "Retry amplification", detail: "Retries increased 7.2× across synchronized checkout workers.", impactScore: 91 },
    { id: "p3", incidentId: "preview", timestamp: "2026-09-20T05:47:19.000Z", service: "payments-api", kind: "alert", title: "SLO breach", detail: "Authorization latency reached 3.8 seconds.", impactScore: 96 }
  ]
};

export function LoginPage() {
  const { user, loading, signIn, signUp, signInWithGithub, enterDemo, demoAvailable } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-canvas"><LoaderCircle className="h-6 w-6 animate-spin text-accent" /></div>;
  if (user) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = mode === "login" ? await signIn(email, password) : await signUp(name, email, password);
      if (result.message) setSuccess(result.message);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function githubLogin() {
    setError("");
    setSuccess("");
    try {
      await signInWithGithub();
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "GitHub authentication failed.");
    }
  }

  return (
    <main className="grid min-h-[100dvh] bg-canvas lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,0.85fr)]">
      <section className="relative hidden overflow-hidden bg-rail p-8 lg:flex lg:flex-col xl:p-12">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-control bg-ink text-panel"><Activity className="h-5 w-5" /></div>
          <div><p className="font-heading text-xl font-semibold">ReplayOps</p><p className="measurement-number text-[10px] text-muted">INCIDENT TIME MACHINE</p></div>
        </div>
        <div className="my-auto max-w-4xl">
          <motion.h1 className="max-w-3xl font-heading text-5xl font-semibold leading-[1.02] tracking-[-0.035em] xl:text-6xl" initial={{ opacity: 0.5, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>See the failure propagate. Then test the fix against time.</motion.h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted">ReplayOps reconstructs disconnected operational evidence into a causal sequence engineers can inspect, challenge, and replay.</p>
          <div className="mt-9"><CausalTrace incident={previewIncident} compact /></div>
          <p className="measurement-number mt-3 text-[10px] text-faint">SYNTHETIC INCIDENT PREVIEW · NO CUSTOMER DATA</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted"><ShieldCheck className="h-4 w-4 text-success" /> Evidence-linked hypotheses. Human-approved action.</div>
      </section>

      <section className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-control bg-ink text-panel"><Activity className="h-5 w-5" /></div>
            <div><p className="font-heading text-xl font-semibold">ReplayOps</p><p className="measurement-number text-[10px] text-muted">INCIDENT TIME MACHINE</p></div>
          </div>
          <h2 className="font-heading text-3xl font-semibold tracking-[-0.03em]">{mode === "login" ? "Return to operations" : "Create your responder account"}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{mode === "login" ? "Open your incident workspace and continue from the latest evidence." : "Create an account and a private incident workspace is provisioned automatically."}</p>

          {mode === "login" && demoAvailable && (
            <div className="mt-6 rounded-control bg-elevated p-4">
              <div className="flex items-start gap-3">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">Test credentials</p>
                  <p className="measurement-number mt-1 break-all text-xs text-muted">{TEST_CREDENTIALS.email}</p>
                  <p className="measurement-number mt-1 text-xs text-muted">{TEST_CREDENTIALS.password}</p>
                </div>
                <button type="button" className="control-quiet !min-h-9 shrink-0 !px-3" onClick={() => { setEmail(TEST_CREDENTIALS.email); setPassword(TEST_CREDENTIALS.password); setError(""); }}>Fill</button>
              </div>
            </div>
          )}

          <form className="mt-6 space-y-4" onSubmit={submit}>
            {mode === "signup" && <label className="block text-sm font-semibold">Name<input className="field mt-2" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label>}
            <label className="block text-sm font-semibold">Work email<input type="email" className="field mt-2" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
            <label className="block text-sm font-semibold">Password<input type="password" className="field mt-2" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} required /></label>
            {error && <p role="alert" className="rounded-control bg-danger/10 p-3 text-sm text-danger">{error}</p>}
            {success && <p role="status" className="flex items-start gap-2 rounded-control bg-success/10 p-3 text-sm text-success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{success}</p>}
            <button type="submit" className="control-primary flex w-full items-center justify-center gap-2" disabled={submitting}>{submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <>{mode === "login" ? "Sign in" : "Create account"}<ArrowRight className="h-4 w-4" /></>}</button>
          </form>

          <div className="my-5 flex items-center gap-3 text-xs text-faint"><span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" /></div>
          <button className="control-secondary flex w-full items-center justify-center gap-2" onClick={() => void githubLogin()}><Github className="h-4 w-4" /> Continue with GitHub</button>
          {demoAvailable && <button className="control-quiet mt-2 flex w-full items-center justify-center" onClick={enterDemo}>Explore the synthetic workspace</button>}

          <p className="mt-8 text-center text-sm text-muted">{mode === "login" ? "New to ReplayOps?" : "Already have an account?"} <button className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-ink" onClick={() => { setMode((current) => current === "login" ? "signup" : "login"); setError(""); setSuccess(""); }}>{mode === "login" ? "Create an account" : "Sign in"}</button></p>
        </div>
      </section>
    </main>
  );
}
