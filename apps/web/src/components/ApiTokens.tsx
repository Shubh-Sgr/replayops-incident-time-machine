import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useIsAdmin } from "../lib/useIsAdmin";
import { formatRelative } from "../lib/utils";
import type { ApiToken } from "../types";

const API_ORIGIN = (import.meta.env.VITE_API_URL ?? "http://localhost:8787/api").replace(/\/api\/?$/, "");

function CreatedToken({ token }: { token: ApiToken & { token: string } }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(token.token); setCopied(true); } catch { setCopied(false); } };
  return <div className="mt-4 rounded-control bg-success/10 p-4" aria-live="polite">
    <p className="text-sm font-semibold">Copy “{token.name}” now. It won't be shown again.</p>
    <div className="mt-2 flex items-center gap-2 rounded-control bg-panel p-2"><code className="measurement-number min-w-0 flex-1 break-all text-xs">{token.token}</code><button type="button" className="control-secondary !min-h-9 inline-flex items-center gap-1.5" onClick={() => void copy()}><Copy className="h-4 w-4" />{copied ? "Copied" : "Copy"}</button></div>
    <pre className="mt-3 overflow-x-auto rounded-control bg-ink p-3 text-xs leading-5 text-panel/90">{`export REPLAYOPS_API=${API_ORIGIN}\nexport REPLAYOPS_TOKEN=<the token above>\nnpm run replayops -- incidents`}</pre>
  </div>;
}

export function ApiTokens() {
  const client = useQueryClient();
  const isAdmin = useIsAdmin();
  const tokens = useQuery({ queryKey: ["api-tokens"], queryFn: api.apiTokens, enabled: isAdmin });
  const [name, setName] = useState("CI pipeline");
  const [role, setRole] = useState<ApiToken["role"]>("responder");
  const [expiresInDays, setExpiresInDays] = useState<number | null>(90);
  const [created, setCreated] = useState<(ApiToken & { token: string }) | null>(null);
  const create = useMutation({ mutationFn: () => api.createApiToken({ name, role, expiresInDays }), onSuccess: (value) => { setCreated(value); void client.invalidateQueries({ queryKey: ["api-tokens"] }); } });
  const revoke = useMutation({ mutationFn: api.revokeApiToken, onSuccess: () => void client.invalidateQueries({ queryKey: ["api-tokens"] }) });
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  if (!isAdmin) return <section className="surface-lined p-6 text-sm text-muted">Only workspace admins can create or revoke API tokens.</section>;

  return <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
    <section className="surface-lined overflow-hidden">
      <div className="px-5 py-5 sm:px-6"><h2 className="section-title">API tokens</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-muted">For scripts, CI jobs, and the <code>replayops</code> CLI. A token belongs to this workspace only and is never an admin. Responder tokens can open incidents, add evidence, notes and checks, and move the lifecycle; they can't change connectors, team, alerts, or settings.</p></div>
      {tokens.data?.length ? <ul className="divide-y divide-line border-t border-line">{tokens.data.map((token) => <li key={token.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0"><p className="font-semibold">{token.name} <span className="ml-1 rounded-full bg-elevated px-2 py-0.5 text-xs font-medium capitalize text-muted">{token.role}</span></p>
          <p className="measurement-number mt-1 text-xs text-muted">{token.prefix}… · created {formatRelative(token.createdAt)}{token.createdByEmail ? ` by ${token.createdByEmail}` : ""} · {token.lastUsedAt ? `last used ${formatRelative(token.lastUsedAt)}` : "never used"} · {token.expiresAt ? `expires ${new Date(token.expiresAt).toLocaleDateString()}` : "no expiry"}</p></div>
        <button className="control-quiet !min-h-9 !px-2.5 text-danger hover:text-danger" aria-label={`Revoke ${token.name}`} disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke “${token.name}”? Anything using it stops working immediately.`)) revoke.mutate(token.id); }}><Trash2 className="h-4 w-4" /></button>
      </li>)}</ul> : <p className="border-t border-line px-6 py-6 text-sm text-muted">{tokens.isLoading ? "Loading tokens…" : "No tokens yet."}</p>}
      {(tokens.error ?? revoke.error) && <p role="alert" className="border-t border-line px-6 py-3 text-sm text-danger">{(tokens.error ?? revoke.error)!.message}</p>}
    </section>
    <form className="surface-lined h-fit p-5 sm:p-6" onSubmit={submit}>
      <KeyRound className="h-6 w-6 text-accent" />
      <h2 className="mt-4 section-title">Create a token</h2>
      <label className="mt-4 block text-sm font-semibold">Name<input className="field mt-2" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required /></label>
      <label className="mt-4 block text-sm font-semibold">Access<select className="field mt-2" value={role} onChange={(e) => setRole(e.target.value as ApiToken["role"])}><option value="responder">Responder: read and update incidents</option><option value="viewer">Viewer: read only</option></select></label>
      <label className="mt-4 block text-sm font-semibold">Expires<select className="field mt-2" value={expiresInDays ?? "never"} onChange={(e) => setExpiresInDays(e.target.value === "never" ? null : Number(e.target.value))}><option value={30}>In 30 days</option><option value={90}>In 90 days</option><option value={365}>In a year</option><option value="never">Never</option></select></label>
      <button className="control-primary mt-5 inline-flex w-full items-center justify-center gap-2" disabled={create.isPending}>{create.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}Create token</button>
      {create.error && <p role="alert" className="mt-3 rounded-control bg-danger/10 p-3 text-sm text-danger">{create.error.message}</p>}
      {created && <CreatedToken token={created} />}
    </form>
  </div>;
}
