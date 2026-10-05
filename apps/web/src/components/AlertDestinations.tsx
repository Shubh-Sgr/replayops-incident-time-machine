import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, CheckCircle2, LoaderCircle, Send, Trash2, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { cn, formatRelative } from "../lib/utils";
import type { AlertChannel, AlertChannelKind, AlertEventType, Severity } from "../types";

const kinds: Array<{ id: AlertChannelKind; label: string; field: string; placeholder: string; help: string }> = [
  { id: "email", label: "Email", field: "Email addresses", placeholder: "you@example.com, oncall@example.com", help: "Up to 10 addresses, separated by commas. Sent through the API's Resend account (free tier: 100 emails a day)." },
  { id: "ntfy", label: "Phone push", field: "ntfy topic URL", placeholder: "https://ntfy.sh/your-secret-topic", help: "Free, no account: install the ntfy app (iOS/Android), subscribe to the topic below, and keep the topic name secret. Critical incidents ring through as urgent." },
  { id: "discord", label: "Discord", field: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", help: "Channel settings → Integrations → Webhooks → New webhook → Copy URL." },
  { id: "slack", label: "Slack", field: "Webhook URL", placeholder: "https://hooks.slack.com/services/…", help: "Slack → Apps → Incoming Webhooks → Add to a channel, then paste the webhook URL." },
  { id: "webhook", label: "Webhook", field: "Webhook URL", placeholder: "https://ops.example.com/replayops", help: "Any HTTPS endpoint. Each POST is signed with x-replayops-signature (HMAC-SHA256 of the body)." }
];
const defaultName: Record<AlertChannelKind, string> = { email: "On-call email", ntfy: "My phone", discord: "#incidents", slack: "#incidents", webhook: "Ops webhook" };
const randomTopic = () => `replayops-${Array.from(crypto.getRandomValues(new Uint8Array(9)), (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 16)}`;
const eventLabels: Record<AlertEventType, string> = { opened: "Incident opened", monitoring: "Monitoring recovery", resolved: "Resolved", reopened: "Reopened" };
const allEvents = Object.keys(eventLabels) as AlertEventType[];
const severities: Severity[] = ["low", "medium", "high", "critical"];

function ChannelRow({ channel, isAdmin }: { channel: AlertChannel; isAdmin: boolean }) {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ["alert-channels"] });
  const test = useMutation({ mutationFn: () => api.testAlertChannel(channel.id), onSettled: refresh });
  const update = useMutation({ mutationFn: (input: Parameters<typeof api.updateAlertChannel>[1]) => api.updateAlertChannel(channel.id, input), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.deleteAlertChannel(channel.id), onSuccess: refresh });
  const toggleEvent = (event: AlertEventType) => {
    const events = channel.events.includes(event) ? channel.events.filter((item) => item !== event) : [...channel.events, event];
    if (events.length) update.mutate({ events });
  };
  const error = test.error ?? update.error ?? remove.error;
  return <li className="px-5 py-4 sm:px-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-semibold">{channel.name}<span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-medium capitalize text-muted">{channel.kind}</span>{!channel.enabled && <span className="rounded-full bg-warning/12 px-2 py-0.5 text-xs font-medium text-warning">Paused</span>}</p>
        <p className="measurement-number mt-1 break-all text-xs text-muted">{channel.target}</p>
        <p className={cn("mt-2 flex items-center gap-1.5 text-xs", channel.lastStatus === "failed" ? "text-danger" : channel.lastStatus === "delivered" ? "text-success" : "text-muted")}>
          {channel.lastStatus === "failed" ? <TriangleAlert className="h-3.5 w-3.5" /> : channel.lastStatus === "delivered" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          {channel.lastStatus === "delivered" ? `Last alert delivered ${formatRelative(channel.lastSentAt!)}` : channel.lastStatus === "failed" ? `Last alert failed ${formatRelative(channel.lastSentAt!)}: ${channel.lastError}` : "No alert sent yet. Send a test to confirm it works."}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button className="control-secondary inline-flex items-center gap-2 !min-h-9" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Send test</button>
        {isAdmin && <button className="control-quiet !min-h-9 !px-2.5 text-danger hover:text-danger" aria-label={`Remove ${channel.name}`} onClick={() => { if (window.confirm(`Stop sending alerts to ${channel.name}?`)) remove.mutate(); }}><Trash2 className="h-4 w-4" /></button>}
      </div>
    </div>
    {isAdmin && <div className="mt-3 flex flex-wrap items-center gap-2">
      {allEvents.map((event) => <button key={event} type="button" aria-pressed={channel.events.includes(event)} onClick={() => toggleEvent(event)} className={cn("rounded-full px-2.5 py-1 text-xs font-semibold transition-colors", channel.events.includes(event) ? "bg-ink text-panel" : "bg-elevated text-muted hover:text-ink")}>{eventLabels[event]}</button>)}
      <label className="ml-auto flex items-center gap-2 text-xs text-muted">Minimum severity<select className="field !min-h-8 !w-auto !py-1 text-xs" value={channel.minSeverity} onChange={(e) => update.mutate({ minSeverity: e.target.value as Severity })}>{severities.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" className="h-4 w-4 accent-[oklch(var(--accent))]" checked={channel.enabled} onChange={(e) => update.mutate({ enabled: e.target.checked })} />On</label>
    </div>}
    {channel.kind === "webhook" && channel.signingSecret && <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer font-semibold">Signing secret</summary><code className="measurement-number mt-2 block break-all rounded-control bg-elevated p-2">{channel.signingSecret}</code><p className="mt-1">Verify: <code>x-replayops-signature == "sha256=" + HMAC_SHA256(secret, raw body)</code>.</p></details>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error.message}</p>}
  </li>;
}

export function AlertDestinations() {
  const client = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  const channels = useQuery({ queryKey: ["alert-channels"], queryFn: api.alertChannels });
  const isAdmin = workspace.data?.role === "admin";
  const options = useQuery({ queryKey: ["alert-channel-options"], queryFn: api.alertChannelOptions, staleTime: 300_000 });
  const [kind, setKind] = useState<AlertChannelKind>("email");
  const [name, setName] = useState(defaultName.email);
  const [url, setUrl] = useState("");
  const [minSeverity, setMinSeverity] = useState<Severity>("low");
  const selected = kinds.find((item) => item.id === kind)!;
  const create = useMutation({
    mutationFn: () => api.createAlertChannel({ name, kind, url, events: allEvents, minSeverity }),
    onSuccess: async (channel) => { setUrl(""); await client.invalidateQueries({ queryKey: ["alert-channels"] }); void api.testAlertChannel(channel.id).finally(() => void client.invalidateQueries({ queryKey: ["alert-channels"] })); }
  });
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };

  return <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
    <section className="surface-lined overflow-hidden">
      <div className="px-5 py-5 sm:px-6"><h2 className="section-title">Where incident alerts go</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-muted">ReplayOps posts here when an incident opens automatically, when a fix moves it to monitoring, when it is resolved, and if it is reopened. Each message links straight to the investigation.</p></div>
      {channels.isLoading ? <p className="border-t border-line px-6 py-5 text-sm text-muted">Loading destinations…</p>
        : channels.data?.length ? <ul className="divide-y divide-line border-t border-line">{channels.data.map((channel) => <ChannelRow key={channel.id} channel={channel} isAdmin={isAdmin} />)}</ul>
          : <div className="border-t border-line px-6 py-8 text-sm text-muted"><BellRing className="mb-3 h-6 w-6 text-warning" />No destinations yet, so a new incident is only visible to someone who has ReplayOps open. Add an email address or your phone. Both are free.</div>}
      {channels.error && <p role="alert" className="border-t border-line px-6 py-4 text-sm text-danger">{channels.error.message}</p>}
    </section>
    <form className="surface-lined h-fit p-5 sm:p-6" onSubmit={submit}>
      <BellRing className="h-6 w-6 text-accent" />
      <h2 className="mt-4 section-title">Add a destination</h2>
      <div className="mt-4 flex flex-wrap gap-1 rounded-control bg-rail p-1" role="radiogroup" aria-label="Destination type">{kinds.map((item) => <button key={item.id} type="button" role="radio" aria-checked={kind === item.id} onClick={() => { setKind(item.id); setName(defaultName[item.id]); setUrl(item.id === "ntfy" ? `https://ntfy.sh/${randomTopic()}` : ""); }} className={cn("min-h-9 rounded-control px-3 text-sm font-semibold", kind === item.id ? "bg-ink text-panel" : "text-muted hover:text-ink")}>{item.label}</button>)}</div>
      <p className="mt-3 text-xs leading-5 text-muted">{selected.help}</p>
      <label className="mt-4 block text-sm font-semibold">Name<input className="field mt-2" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required /></label>
      <label className="mt-4 block text-sm font-semibold">{selected.field}<input type={kind === "email" ? "text" : "url"} inputMode={kind === "email" ? "email" : "url"} className="field mt-2" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={selected.placeholder} autoComplete="off" required /></label>
      {kind === "ntfy" && url && <p className="mt-2 text-xs leading-5 text-muted">In the ntfy app, tap <strong className="text-ink">+</strong> and subscribe to <code className="measurement-number break-all text-ink">{url.replace(/^https:\/\/ntfy\.sh\//, "")}</code>.</p>}
      {kind === "email" && options.data && !options.data.emailConfigured && <p className="mt-2 rounded-control bg-warning/12 p-3 text-xs leading-5 text-warning">Email isn't configured on the API yet. Add RESEND_API_KEY and INVITE_FROM_EMAIL in Render (free Resend account), or use Phone push.</p>}
      <label className="mt-4 block text-sm font-semibold">Only alert at or above<select className="field mt-2" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)}>{severities.map((item) => <option key={item} value={item}>{item === "low" ? "low (everything)" : item}</option>)}</select></label>
      <button className="control-primary mt-5 inline-flex w-full items-center justify-center gap-2" disabled={create.isPending || !isAdmin}>{create.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}{create.isPending ? "Saving…" : "Save and send a test"}</button>
      {!isAdmin && workspace.data && <p className="mt-3 text-xs text-muted">Only workspace admins can add destinations.</p>}
      {create.error && <p role="alert" className="mt-3 rounded-control bg-danger/10 p-3 text-sm text-danger">{create.error.message}</p>}
      <p className="mt-4 border-t border-line pt-4 text-xs leading-5 text-muted">The URL is stored server-side and shown masked afterwards. Alerts are best effort: a failing destination never blocks evidence intake.</p>
    </form>
  </div>;
}
