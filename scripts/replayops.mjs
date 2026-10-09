#!/usr/bin/env node
// ReplayOps CLI: work an incident from a terminal or CI job. No dependencies; Node 18+.
//
//   export REPLAYOPS_API=https://replayops-incident-api.onrender.com   # API origin
//   export REPLAYOPS_TOKEN=rpo_…                                       # Settings → API tokens
//   npm run replayops -- incidents
//
// Recording a change uses a Generic connector instead of an API token:
//   export REPLAYOPS_INGEST_URL=https://…/ingest/<connector-id>  REPLAYOPS_CONNECTOR_TOKEN=…
//   npm run replayops -- change --service checkout-api --version v1.4.2 --previous v1.4.1

const HELP = `ReplayOps CLI

Usage: replayops <command> [options]

  incidents [--all]                     Open incidents with their next step (--all includes resolved)
  show <code|id>                        Facts, leading explanation, next step, and latest evidence
  note <code|id> <text…>                Add a comment to the incident
  open --title T --service S [--severity high] [--summary …] [--env production]
                                        Open an incident by hand
  status <code|id> fixed|resolve|reopen --reason "…" [--confirmed]
                                        Mark fixed, resolve (--confirmed when your sources
                                        haven't confirmed recovery), or reopen
  change --service S [--type deploy|feature_flag|config|migration|infra|rollback]
         [--version V] [--previous V] [--sha SHA] [--flag KEY --from X --to Y] [--env production]
                                        Record a change so it becomes a suspect (needs a connector)

Environment: REPLAYOPS_API, REPLAYOPS_TOKEN, REPLAYOPS_INGEST_URL, REPLAYOPS_CONNECTOR_TOKEN.
Add --json to any read command for machine-readable output.`;

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index];
  if (value.startsWith("--")) {
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; index += 1; }
  } else positional.push(value);
}
const [command, ...rest] = positional;

const fail = (message) => { console.error(`replayops: ${message}`); process.exit(1); };
const apiBase = () => {
  const base = process.env.REPLAYOPS_API?.replace(/\/$/, "");
  if (!base) fail("set REPLAYOPS_API to the API origin, e.g. https://replayops-incident-api.onrender.com");
  return base.endsWith("/api") ? base : `${base}/api`;
};

async function api(method, path, body) {
  const token = process.env.REPLAYOPS_TOKEN;
  if (!token) fail("set REPLAYOPS_TOKEN to an API token from Settings → API tokens");
  const response = await fetch(`${apiBase()}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).catch((error) => fail(`could not reach the API (${error.message}). Free Render instances can take ~50s to wake up; retry.`));
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) fail(`${response.status} ${typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? data)}`);
  return data;
}

const pad = (value, width) => String(value ?? "").slice(0, width).padEnd(width);
const ago = (iso) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 60 ? `${minutes}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

async function findIncident(reference) {
  if (!reference) fail("give an incident code (e.g. AUTO-1234) or id");
  const incidents = await api("GET", "/incidents");
  const match = incidents.find((item) => item.id === reference || item.code.toLowerCase() === reference.toLowerCase());
  if (!match) fail(`no incident ${reference} in this token's workspace`);
  return api("GET", `/incidents/${match.id}`);
}

async function incidentsCommand() {
  const incidents = (await api("GET", "/incidents")).filter((item) => flags.all || item.status !== "resolved");
  const rows = await Promise.all(incidents.slice(0, 20).map(async (item) => ({ ...item, next: item.status === "resolved" ? null : (await api("GET", `/incidents/${item.id}/diagnosis`).catch(() => null))?.nextAction })));
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(flags.all ? "No incidents." : "No open incidents. 🎉");
  console.log(`${pad("CODE", 18)}${pad("STATUS", 14)}${pad("SEV", 9)}${pad("SERVICE", 18)}${pad("STARTED", 10)}TITLE`);
  for (const item of rows) {
    console.log(`${pad(item.code, 18)}${pad(item.status, 14)}${pad(item.severity, 9)}${pad(item.service, 18)}${pad(ago(item.startedAt), 10)}${item.title}`);
    if (item.next) console.log(`${" ".repeat(18)}→ ${item.next.label}: ${item.next.reason}`);
  }
}

async function showCommand() {
  const incident = await findIncident(rest[0]);
  const [diagnosis, errors] = await Promise.all([api("GET", `/incidents/${incident.id}/diagnosis`), api("GET", `/incidents/${incident.id}/errors`)]);
  if (flags.json) return console.log(JSON.stringify({ incident, diagnosis, errors }, null, 2));
  console.log(`${incident.code}  ${incident.title}`);
  console.log(`${incident.status} · ${incident.severity} · ${incident.service} · ${incident.environment ?? "environment not set"} · started ${ago(incident.startedAt)}`);
  console.log(`\nNext step: ${diagnosis.nextAction.label}\n  ${diagnosis.nextAction.reason}`);
  const lead = diagnosis.hypotheses?.[0];
  if (lead) console.log(`\nLeading explanation (${lead.confidence}/100, ${lead.state}): ${lead.title}\n  Test: ${lead.nextTest}\n  Safe action: ${lead.safeAction}`);
  if (errors.length) {
    console.log("\nErrors:");
    for (const group of errors.slice(0, 5)) console.log(`  ${pad(`${group.count}×`, 6)}${group.type}: ${group.message.slice(0, 80)}${group.newSince ? `  [NEW after ${group.newSince.title}]` : ""}${group.topFrame ? `\n        at ${group.topFrame}` : ""}`);
  }
  console.log("\nLatest evidence:");
  for (const event of incident.events.slice(-8)) console.log(`  ${new Date(event.timestamp).toISOString().slice(11, 19)}  ${pad(event.kind, 11)}${pad(event.service, 18)}${event.title}`);
}

async function noteCommand() {
  const incident = await findIncident(rest[0]);
  const body = rest.slice(1).join(" ").trim();
  if (body.length < 2) fail("write the note after the incident code");
  await api("POST", `/incidents/${incident.id}/comments`, { body });
  console.log(`Noted on ${incident.code}.`);
}

async function openCommand() {
  if (!flags.title || !flags.service) fail("open needs --title and --service");
  const title = String(flags.title);
  const created = await api("POST", "/incidents", {
    title, service: String(flags.service), severity: flags.severity ?? "high", status: "investigating", owner: "CLI",
    summary: String(flags.summary ?? `${title}. Opened from the ReplayOps CLI.`).padEnd(12, "."), environment: flags.env ? String(flags.env) : undefined,
    startedAt: new Date().toISOString()
  });
  console.log(`Opened ${created.code}: ${created.title}`);
}

async function statusCommand() {
  const incident = await findIncident(rest[0]);
  const action = { fixed: "start_monitoring", monitoring: "start_monitoring", resolve: "resolve", reopen: "reopen" }[rest[1]];
  if (!action) fail("status needs fixed, resolve, or reopen");
  const reason = String(flags.reason ?? "");
  if (reason.length < 8) fail('give a --reason of at least 8 characters, e.g. --reason "Rolled back to v1.4.1"');
  await api("POST", `/incidents/${incident.id}/lifecycle`, { action, reason, expectedEvidenceRevision: incident.evidenceRevision ?? incident.updatedAt, ...(flags.confirmed ? { confirmed: true } : {}) });
  console.log(`${incident.code} → ${rest[1]}.`);
}

async function changeCommand() {
  const url = process.env.REPLAYOPS_INGEST_URL;
  const token = process.env.REPLAYOPS_CONNECTOR_TOKEN;
  if (!url || !token) fail("change needs REPLAYOPS_INGEST_URL and REPLAYOPS_CONNECTOR_TOKEN from a Generic connector");
  if (!flags.service) fail("change needs --service");
  const event = {
    kind: "change", changeType: flags.type ?? "deploy", service: flags.service, environment: flags.env ?? "production",
    version: flags.version, previousVersion: flags.previous, sha: flags.sha, author: flags.author ?? process.env.GITHUB_ACTOR ?? process.env.USER,
    flag: flags.flag, from: flags.from, to: flags.to, title: flags.title, timestamp: new Date().toISOString()
  };
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(event) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) fail(`${response.status} ${data.error ?? "delivery failed"}`);
  console.log(`Recorded ${event.changeType} for ${event.service}${data.incidentIds?.length ? ` (joined ${data.incidentIds.length} open incident${data.incidentIds.length > 1 ? "s" : ""})` : ""}.`);
}

const commands = { incidents: incidentsCommand, show: showCommand, note: noteCommand, open: openCommand, status: statusCommand, change: changeCommand };
if (!command || flags.help || command === "help") console.log(HELP);
else if (!commands[command]) fail(`unknown command "${command}". Run with --help.`);
else await commands[command]();
