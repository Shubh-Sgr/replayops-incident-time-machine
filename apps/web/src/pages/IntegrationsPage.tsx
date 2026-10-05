import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, ArrowRight, Check, CheckCircle2, ChevronRight, Clipboard, Code2, Eye, EyeOff,
  GitBranch, RadioTower, RefreshCw, ServerCog, ShieldCheck, Trash2, Webhook, XCircle
} from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useIsAdmin } from "../lib/useIsAdmin";
import { cn } from "../lib/utils";
import type { Integration, IntegrationProvider, QueueJob } from "../types";

function connectorHealth(integration: Integration) {
  if (!integration.lastDeliveryAt) return { label: "Awaiting first real receipt", tone: "text-warning", dot: "bg-warning", detail: "No signed delivery received" };
  if (integration.lastDeliveryStatus === "failed" || integration.lastDeliveryStatus === "rejected") return { label: "Attention required", tone: "text-danger", dot: "bg-danger", detail: "Latest delivery did not complete" };
  const ageMinutes = (Date.now() - new Date(integration.lastDeliveryAt).getTime()) / 60_000;
  if (ageMinutes > integration.expectedCadenceMinutes) return { label: "Outside expected cadence", tone: "text-warning", dot: "bg-warning", detail: `No delivery within the expected ${integration.expectedCadenceMinutes} minute cadence` };
  return { label: "Healthy", tone: "text-success", dot: "bg-success", detail: `Last delivery ${new Date(integration.lastDeliveryAt).toLocaleString()}` };
}

const providers: Array<{
  id: IntegrationProvider;
  name: string;
  description: string;
  icon: typeof GitBranch;
}> = [
  { id: "github", name: "GitHub delivery", description: "Deployments, workflow failures, and pushes", icon: GitBranch },
  { id: "otel", name: "OpenTelemetry", description: "Failed traces, error logs, and pressure metrics", icon: RadioTower },
  { id: "generic", name: "Generic webhook", description: "Grafana alerts or normalized JSON from any tool", icon: Webhook }
];

const providerMeta = Object.fromEntries(providers.map((provider) => [provider.id, provider])) as Record<IntegrationProvider, typeof providers[number]>;

function matchingQueueJob(delivery: Integration["deliveries"][number], jobs: QueueJob[] | undefined) {
  return jobs?.find((job) => job.integrationId === delivery.integrationId && job.externalId === delivery.externalId);
}

function shortReference(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button type="button" className="control-quiet !min-h-9 !px-2.5" onClick={() => void copy()} aria-label={`${label} to clipboard`}>
      {copied ? <Check className="h-4 w-4 text-success" /> : <Clipboard className="h-4 w-4" />}
      <span className="ml-1.5 text-xs">{copied ? "Copied" : label}</span>
    </button>
  );
}

function CredentialField({ value, label, concealable = true }: { value: string; label: string; concealable?: boolean }) {
  const [visible, setVisible] = useState(!concealable);
  return (
    <div>
      <label className="mb-2 block text-xs font-semibold text-muted">{label}</label>
      <div className="flex min-w-0 items-center rounded-control bg-elevated pl-3" style={{ border: "1px solid oklch(var(--line))" }}>
        <code className="measurement-number min-w-0 flex-1 truncate py-2.5 text-xs">{visible ? value : "•".repeat(36)}</code>
        {concealable && (
          <button type="button" className="control-quiet !min-h-9 !px-2" onClick={() => setVisible((current) => !current)} aria-label={visible ? "Hide secret" : "Show secret"}>
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
        <CopyButton value={value} label="Copy" />
      </div>
    </div>
  );
}

function ConnectorInstructions({ integration }: { integration: Integration }) {
  const snippet = useMemo(() => {
    if (integration.provider === "otel") {
      return `OTEL_EXPORTER_OTLP_ENDPOINT=${integration.connector.endpoint}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/json\nOTEL_EXPORTER_OTLP_HEADERS=${integration.connector.otlpHeaders}`;
    }
    if (integration.provider === "github") {
      return `Payload URL: ${integration.connector.endpoint}\nContent type: application/json\nSecret: use the generated secret below\nEvents: Deployments, Deployment statuses, Workflow runs, Pushes`;
    }
    const send = (comment: string, body: string) => [
      `# ${comment}`,
      `curl -X POST '${integration.connector.endpoint}' \\`,
      `  -H 'Authorization: Bearer ${integration.connector.token}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '${body}'`
    ].join("\n");
    return [
      send("Record a deploy from any CI/CD step (Vercel, Render, Jenkins, Argo…) so it becomes a suspect. Fill version/sha from your CI variables.", `{"kind":"change","changeType":"deploy","service":"checkout-api","environment":"production","version":"v1.4.2","previousVersion":"v1.4.1","sha":"abc1234","author":"ci-bot"}`),
      send("Record a feature flag flip or config edit", `{"kind":"change","changeType":"feature_flag","service":"checkout-api","environment":"production","flag":"new-checkout","from":false,"to":true}`),
      send("Send an alert", `{"eventId":"alert-1042","service":"checkout-api","environment":"production","kind":"alert","title":"Checkout errors exceeded SLO","detail":"Five-minute error rate reached 7.8 percent.","impactScore":82}`)
    ].join("\n\n");
  }, [integration]);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="break-words font-heading text-xl font-semibold tracking-[-0.025em]">Wire {integration.name} into the evidence stream</h3>
            <p className="mt-1 max-w-[70ch] text-sm text-muted">
              {integration.provider === "github"
                ? "Add one repository webhook. ReplayOps verifies GitHub’s SHA-256 signature before accepting a delivery."
                : integration.provider === "otel"
                  ? "Point an OTLP HTTP/JSON exporter here. Only failed or slow spans, warning/error logs, and incident-shaped metrics are retained."
                  : "Send alerts and change events (deploys, feature flags, config edits) as JSON from any tool, or point Grafana’s alert webhook here. Changes become ranked suspects when an incident opens."}
            </p>
          </div>
          <span className="inline-flex min-h-8 items-center gap-2 rounded-full bg-success/10 px-3 text-xs font-semibold text-success">
            <span className="status-dot bg-success" />Signed receiver ready
          </span>
        </div>

        <div className="mt-5 rounded-control bg-ink p-4 text-panel">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="measurement-number text-xs text-panel/65">SETUP</span>
            <CopyButton value={snippet} label="Copy setup" />
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs leading-6 text-panel/90"><code>{integration.connector.token ? snippet.split(integration.connector.token).join("•".repeat(12)) : snippet}</code></pre>
        </div>
        <ol className="mt-5 grid gap-3 sm:grid-cols-3" aria-label="Connector verification steps">
          {[integration.provider === "github" ? "Add repository webhook" : integration.provider === "otel" ? "Configure OTLP exporter" : "Configure webhook sender", "Send a signed delivery", "Confirm evidence and incident"].map((step, index) => <li key={step} className="flex items-start gap-2 text-xs leading-5 text-muted"><span className="measurement-number flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-elevated text-xs font-semibold text-ink">{index + 1}</span>{step}</li>)}
        </ol>
      </div>

      <div className="min-w-0 space-y-4">
        <CredentialField value={integration.connector.endpoint} label="Receiver endpoint" concealable={false} />
        <CredentialField value={integration.provider === "github" ? integration.connector.githubSecret ?? integration.connector.token : integration.connector.token} label={integration.provider === "github" ? "GitHub webhook secret" : "Connector token"} />
        <div className="rounded-control bg-elevated p-3 text-xs leading-5 text-muted">
          Secrets are generated server-side and never stored in the repository. Rotate the deployment signing secret to invalidate every connector token.
        </div>
      </div>
    </div>
  );
}

export function IntegrationsPage() {
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();
  const [provider, setProvider] = useState<IntegrationProvider>("github");
  const [name, setName] = useState("Production delivery stream");
  const [selectedId, setSelectedId] = useState<string>();
  const [deletePending, setDeletePending] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [setupStep, setSetupStep] = useState<"source" | "configure" | "verify">("source");

  const integrationsQuery = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const queueQuery=useQuery({queryKey:["ingestion-queue"],queryFn:api.queue,refetchInterval:20_000});
  const integrations = integrationsQuery.data ?? [];
  const selected = integrations.find((integration) => integration.id === selectedId) ?? integrations[0];

  const createMutation = useMutation({
    mutationFn: api.createIntegration,
    onSuccess: (integration) => {
      queryClient.setQueryData<Integration[]>(["integrations"], (current = []) => [integration, ...current]);
      setSelectedId(integration.id);
      setSetupStep("configure");
      setNotice(`${integration.name} is ready. Copy its endpoint into the source system, or run the labeled test.`);
    }
  });
  const testMutation = useMutation({
    mutationFn: api.testIntegration,
    onSuccess: async (result) => {
      setNotice(`Test accepted ${result.acceptedSignals} signal and opened ${result.incidentIds.length} labeled synthetic incident${result.incidentIds.length === 1 ? "" : "s"}.`);
      setSetupStep("verify");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["integrations"] }),
        queryClient.invalidateQueries({ queryKey: ["incidents"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });
  const deleteMutation = useMutation({
    mutationFn: api.deleteIntegration,
    onSuccess: async (_result, id) => {
      setDeletePending(undefined);
      setSelectedId(undefined);
      setNotice("Connector removed. Its historical incident evidence remains available.");
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
    }
  });
  const configMutation=useMutation({mutationFn:(input:Pick<Integration,"expectedCadenceMinutes"|"retentionDays"|"dailyQuota"|"healthySampleRate">)=>{if(!selected)throw new Error("Choose a source.");return api.updateIntegrationConfig(selected.id,input);},onSuccess:(value)=>queryClient.setQueryData<Integration[]>(["integrations"],(current)=>(current??[]).map((item)=>item.id===value.id?value:item))});

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}>
      <div className="max-w-4xl">
        <h1 className="font-heading text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Connect once. Let evidence arrive by itself.</h1>
        <p className="mt-3 max-w-[72ch] text-base leading-7 text-muted">
          ReplayOps receives telemetry from tools you already use, keeps ordinary changes in a short evidence buffer, and opens an incident only when a high-impact signal arrives.
        </p>
      </div>

      <section className="surface-lined mt-7 overflow-hidden" aria-label="Automated evidence flow">
        <div className="grid md:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {[
            { icon: RadioTower, title: "Source systems", text: "GitHub, OpenTelemetry, Grafana, or any signed webhook" },
            { icon: ServerCog, title: "Evidence buffer", text: "Normalize, verify, deduplicate, and correlate by trace or release" },
            { icon: Activity, title: "Incident proof loop", text: "Open on impact, backfill precursors, and refresh the diagnosis" }
          ].map((step, index) => (
            <div className="contents" key={step.title}>
              <div className="flex min-h-36 items-start gap-4 p-5 sm:p-6">
                <step.icon className={cn("mt-0.5 h-5 w-5 shrink-0", index === 2 ? "text-accent" : "text-info")} />
                <div>
                  <h2 className="font-heading text-base font-semibold">{step.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted">{step.text}</p>
                </div>
              </div>
              {index < 2 && <div className="hidden items-center text-faint md:flex"><ArrowRight className="h-5 w-5" /></div>}
            </div>
          ))}
        </div>
      </section>

      <AnimatePresence>
        {notice && (
          <motion.div className="mt-5 flex items-start gap-3 rounded-control bg-success/10 p-4 text-sm text-ink" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <p className="flex-1">{notice}</p>
            <button className="text-muted hover:text-ink" onClick={() => setNotice(undefined)} aria-label="Dismiss message"><XCircle className="h-4 w-4" /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-7 grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="surface-lined self-start p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3"><div><h2 className="section-title">Add an evidence source</h2><p className="mt-1 text-sm text-muted">No OAuth app or paid middleware required.</p></div><span className="measurement-number rounded-full bg-elevated px-2.5 py-1 text-xs text-muted">{setupStep === "source" ? "1/3" : setupStep === "configure" ? "2/3" : "3/3"}</span></div>
          <div className="mt-4 flex items-center gap-1" aria-label={`Setup step ${setupStep}`}><span className="h-1 flex-1 rounded-full bg-accent" /><span className={cn("h-1 flex-1 rounded-full", setupStep !== "source" ? "bg-accent" : "bg-line")} /><span className={cn("h-1 flex-1 rounded-full", setupStep === "verify" ? "bg-success" : "bg-line")} /></div>
          <div className="mt-5 space-y-2" role="radiogroup" aria-label="Connector type">
            {providers.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={provider === item.id}
                onClick={() => {
                  setProvider(item.id);
                  setSetupStep("source");
                  setName(item.id === "github" ? "Production delivery stream" : item.id === "otel" ? "Production telemetry" : "Operations webhook");
                }}
                className={cn(
                  "flex min-h-[68px] w-full items-center gap-3 rounded-control px-3 text-left transition-colors",
                  provider === item.id ? "bg-ink text-panel" : "bg-elevated text-ink hover:bg-line/45"
                )}
              >
                <item.icon className={cn("h-5 w-5 shrink-0", provider === item.id ? "text-accent" : "text-muted")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.name}</span>
                  <span className={cn("mt-0.5 block text-xs", provider === item.id ? "text-panel/65" : "text-muted")}>{item.description}</span>
                </span>
                <ChevronRight className="h-4 w-4 opacity-55" />
              </button>
            ))}
          </div>
          <label className="mb-2 mt-5 block text-xs font-semibold text-muted" htmlFor="connector-name">Connector name</label>
          <input id="connector-name" className="field" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          <button
            className="control-primary mt-4 w-full"
            disabled={name.trim().length < 3 || createMutation.isPending}
            onClick={() => createMutation.mutate({ name: name.trim(), provider })}
          >
            {createMutation.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Code2 className="mr-2 h-4 w-4" />}
            {createMutation.isPending ? "Creating receiver…" : "Create signed receiver"}
          </button>
          {createMutation.error && <p className="mt-3 text-sm text-danger">{createMutation.error.message}</p>}
        </section>

        <section className="surface-lined min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
            <div>
              <h2 className="section-title">Connected sources</h2>
              <p className="mt-1 text-sm text-muted">{integrations.length ? `${integrations.length} receiver${integrations.length === 1 ? "" : "s"} in this workspace` : "No source is sending evidence yet"}</p>
            </div>
            <button className="control-quiet !px-3" onClick={() => void integrationsQuery.refetch()} disabled={integrationsQuery.isFetching}>
              <RefreshCw className={cn("mr-2 h-4 w-4", integrationsQuery.isFetching && "animate-spin")} />Refresh
            </button>
          </div>

          {integrationsQuery.isLoading ? (
            <div className="p-6 text-sm text-muted">Loading connector health…</div>
          ) : integrationsQuery.error ? (
            <div className="p-6 text-sm text-danger">{integrationsQuery.error.message}</div>
          ) : integrations.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
              <ShieldCheck className="h-8 w-8 text-info" />
              <h3 className="mt-4 font-heading text-lg font-semibold">The manual-entry bottleneck ends here</h3>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted">Create one signed receiver. Normal changes stay buffered; incident-shaped signals create and continuously enrich the investigation.</p>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {integrations.map((integration) => {
                const meta = providerMeta[integration.provider];
                const health = connectorHealth(integration);
                return (
                  <button key={integration.id} className={cn("flex w-full items-center gap-4 px-5 py-4 text-left transition-colors sm:px-6", selected?.id === integration.id ? "bg-elevated" : "hover:bg-elevated/55")} onClick={() => setSelectedId(integration.id)}>
                    <meta.icon className="h-5 w-5 shrink-0 text-info" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{integration.name}</span>
                      <span className="mt-1 block truncate text-xs text-muted">{meta.name} · {integration.signalCount} accepted signal{integration.signalCount === 1 ? "" : "s"}</span>
                    </span>
                    <span className="hidden text-right sm:block">
                      <span className={cn("flex items-center justify-end gap-2 text-xs font-semibold", health.tone)}><span className={cn("status-dot", health.dot)} />{health.label}</span>
                      <span className="measurement-number mt-1 block text-xs text-faint">{health.detail}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 text-faint" />
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {selected && (
        <motion.section key={selected.id} className="surface-lined mt-6 overflow-hidden" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div className="p-5 sm:p-6"><div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4"><div><p className="text-sm font-semibold">Source health and delivery path</p><p className="mt-1 text-xs text-muted">Receipt → authentication → normalization → correlation → investigation</p></div>{(() => { const health = connectorHealth(selected); return <span className={cn("inline-flex items-center gap-2 rounded-full bg-elevated px-3 py-1.5 text-xs font-semibold", health.tone)}><span className={cn("status-dot", health.dot)} />{health.label}</span>; })()}</div><div className="mb-6 grid gap-3 sm:grid-cols-4">{[{label:"Receipt",ok:Boolean(selected.lastDeliveryAt),detail:selected.lastDeliveryAt?new Date(selected.lastDeliveryAt).toLocaleString():"Waiting"},{label:"Normalize",ok:selected.lastDeliveryStatus==="accepted",detail:selected.lastDeliveryStatus??"Not attempted"},{label:"Correlate",ok:selected.deliveries.some((item)=>item.incidentIds.length>0),detail:`${selected.deliveries.reduce((sum,item)=>sum+item.incidentIds.length,0)} incident links`},{label:"Queue",ok:!queueQuery.data?.some((item)=>item.integrationId===selected.id&&item.status==="dead_letter"),detail:queueQuery.data?.find((item)=>item.integrationId===selected.id&&item.status==="dead_letter")?.lastError??"No dead letters"}].map((stage)=><div key={stage.label} className="rounded-control bg-elevated p-3"><div className="flex items-center gap-2"><span className={cn("status-dot",stage.ok?"bg-success":"bg-warning")}/><p className="text-xs font-semibold uppercase tracking-[.1em]">{stage.label}</p></div><p className="mt-2 text-xs leading-5 text-muted">{stage.detail}</p></div>)}</div><ConnectorInstructions integration={selected} /></div>
          <div className="grid gap-5 border-t border-line p-5 sm:p-6 lg:grid-cols-[1fr_1.2fr]"><div><h3 className="section-title">Retention, sampling, and quota</h3><p className="mt-1 text-sm leading-6 text-muted">Bound storage cost and make dropped evidence visible. These controls remain within the free deployment envelope.</p><form className="mt-4 grid grid-cols-2 gap-3" onSubmit={(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);configMutation.mutate({expectedCadenceMinutes:Number(form.get("cadence")),retentionDays:Number(form.get("retention")),dailyQuota:Number(form.get("quota")),healthySampleRate:Number(form.get("sample"))/100});}}><label className="text-xs font-semibold">Expected cadence (min)<input className="field mt-1" name="cadence" type="number" min="1" defaultValue={selected.expectedCadenceMinutes}/></label><label className="text-xs font-semibold">Retention (days)<input className="field mt-1" name="retention" type="number" min="1" max="90" defaultValue={selected.retentionDays}/></label><label className="text-xs font-semibold">Daily signal quota<input className="field mt-1" name="quota" type="number" min="100" defaultValue={selected.dailyQuota}/></label><label className="text-xs font-semibold">Healthy trace sample %<input className="field mt-1" name="sample" type="number" min=".1" max="25" step=".1" defaultValue={selected.healthySampleRate*100}/></label><button className="control-secondary col-span-2" disabled={configMutation.isPending}>Save source policy</button></form>{configMutation.error&&<p className="mt-2 text-xs text-danger">{configMutation.error.message}</p>}</div><div><h3 className="section-title">Today’s coverage</h3><div className="mt-4 grid grid-cols-3 gap-3"><div className="rounded-control bg-elevated p-3"><p className="text-xs text-muted">Accepted</p><p className="measurement-number mt-1 text-xl font-semibold">{selected.acceptedToday}</p></div><div className="rounded-control bg-elevated p-3"><p className="text-xs text-muted">Dropped</p><p className={cn("measurement-number mt-1 text-xl font-semibold",selected.droppedToday?"text-danger":"text-success")}>{selected.droppedToday}</p></div><div className="rounded-control bg-elevated p-3"><p className="text-xs text-muted">Budget used</p><p className="measurement-number mt-1 text-xl font-semibold">{Math.min(100,Math.round(selected.acceptedToday/selected.dailyQuota*100))}%</p></div></div><p className="mt-3 text-xs leading-5 text-muted">Dropped signals are counted and explained; accepted originals retain provider provenance until the configured retention window expires.</p></div></div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line bg-elevated px-5 py-4 sm:px-6">
            <button className="control-primary" disabled={testMutation.isPending} onClick={() => testMutation.mutate(selected.id)}>
              {testMutation.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Activity className="mr-2 h-4 w-4" />}
              {testMutation.isPending ? "Sending test…" : "Run labeled end-to-end test"}
            </button>
            <p className="mr-auto text-xs text-muted">Creates one synthetic incident so you can verify the complete pipeline.</p>
            {!isAdmin ? null : deletePending === selected.id ? (
              <div className="flex items-center gap-2">
                <button className="control-quiet !px-3" onClick={() => setDeletePending(undefined)}>Cancel</button>
                <button className="control bg-danger text-panel hover:bg-danger/90" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate(selected.id)}>Confirm removal</button>
              </div>
            ) : (
              <button className="control-quiet !px-3 text-danger" onClick={() => setDeletePending(selected.id)}><Trash2 className="mr-2 h-4 w-4" />Remove</button>
            )}
          </div>
          {testMutation.error && <p className="border-t border-line px-5 py-3 text-sm text-danger sm:px-6">{testMutation.error.message}</p>}

          <div className="border-t border-line px-5 py-5 sm:px-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h3 className="font-heading text-base font-semibold">Recent deliveries</h3>
                <p className="mt-1 text-sm text-muted">The receiver stores IDs for idempotency, so provider retries do not duplicate evidence.</p>
              </div>
              <span className="measurement-number text-xs text-muted">LATEST 8</span>
            </div>
            {selected.deliveries.length === 0 ? (
              <p className="mt-5 rounded-control bg-elevated p-4 text-sm text-muted">Waiting for the first signed delivery.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line"><th className="pb-2 font-medium">Received</th><th className="pb-2 font-medium">Event</th><th className="pb-2 font-medium">Signals</th><th className="pb-2 font-medium">Incidents</th><th className="pb-2 text-right font-medium">Result</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {selected.deliveries.map((delivery) => { const queued = matchingQueueJob(delivery, queueQuery.data); return (
                      <tr key={delivery.id}>
                        <td className="py-3 pr-4 text-xs text-muted">{new Date(delivery.receivedAt).toLocaleString()}</td>
                        <td className="max-w-72 py-3 pr-4"><p className="truncate text-xs font-semibold" title={queued?.eventName}>{queued?.eventName ?? "Provider delivery"}</p><p className="measurement-number mt-1 truncate text-xs text-faint" title={delivery.externalId}>Reference {shortReference(delivery.externalId)}</p></td>
                        <td className="measurement-number py-3 pr-4">{delivery.signalCount}</td>
                        <td className="measurement-number py-3 pr-4">{delivery.incidentIds.length}</td>
                        <td className="py-3 text-right"><span className="inline-flex items-center gap-2 text-xs font-semibold text-success"><span className="status-dot bg-success" />{delivery.status}</span></td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </motion.section>
      )}
    </motion.div>
  );
}
