#!/usr/bin/env node
/**
 * Production drills for the drill-payouts service: sends to a Generic webhook source what a real stack (app
 * errors, error tracker, Grafana, config/flag tooling) would send. Each scenario is a real-world incident shape.
 *
 *   iban-bug <release-sha>   A release passed its health check but crashes wallet payouts (TypeError in a file
 *                            it changed). A feature flag flipped minutes earlier is the red herring.
 *   db-pool  <release-sha>   A config change (DB_POOL_MAX 50 → 5) starves the connection pool long after a clean
 *                            release. An unrelated deploy of another service happens meanwhile.
 *   db-pool-fix              The config is rolled back and Grafana reports the latency alert resolved.
 *
 * Usage (receiver endpoint and connector token from Integrations → your Generic webhook source):
 *   REPLAYOPS_RECEIVER=https://… REPLAYOPS_TOKEN=… node scripts/drill-runtime-errors.mjs <scenario> [release-sha]
 */
const receiver = process.env.REPLAYOPS_RECEIVER;
const token = process.env.REPLAYOPS_TOKEN;
const [scenario, releaseArg] = process.argv.slice(2);
const release = (releaseArg ?? "").trim();
const needsRelease = scenario === "iban-bug" || scenario === "db-pool";
if (!receiver || !token || !["iban-bug", "db-pool", "db-pool-fix"].includes(scenario) || (needsRelease && !/^[0-9a-f]{7,40}$/i.test(release))) {
  console.error("Usage: REPLAYOPS_RECEIVER=… REPLAYOPS_TOKEN=… node scripts/drill-runtime-errors.mjs <iban-bug|db-pool|db-pool-fix> [deployed commit SHA]");
  process.exit(1);
}

if (!/\/ingest\/[0-9a-f-]{36}\/?$/i.test(receiver)) {
  console.error(`REPLAYOPS_RECEIVER must be the source's full Receiver endpoint, like https://…/ingest/<source-id>. Got: ${receiver}`);
  console.error("Copy it from Integrations → your Generic webhook source → Receiver endpoint.");
  process.exit(1);
}

const run = Date.now().toString(36);
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const service = "drill-payouts";
const environment = "production";

async function send(label, body) {
  const response = await fetch(receiver, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const text = await response.text();
  console.log(`${response.ok ? "✓" : "✗"} ${label}: ${response.status} ${text.slice(0, 200)}`);
  if (!response.ok) process.exit(1);
}

if (scenario === "iban-bug") {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'iban')",
    "    at validateIban (/app/drill/payouts-api/iban.ts:12:51)",
    "    at sendPayout (/app/drill/payouts-api/send.ts:5:16)",
    "    at PayoutWorker.process (/app/node_modules/@acme/queue/dist/worker.js:88:20)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)"
  ].join("\n");
  const crash = (payout, minutesAgo) => ({
    eventId: `drill-${run}-error-${payout}`, kind: "metric", service, environment, release, timestamp: ago(minutesAgo),
    title: "TypeError in payout worker", detail: `Wallet payout ${payout} failed while sending.`, impactScore: 55, severity: "medium",
    error: { type: "TypeError", message: `Cannot read properties of undefined (reading 'iban') for payout wp_${payout}`, stack },
    metadata: { route: "worker:payouts.send", payoutMethod: "wallet" }
  });
  await send("changes (unrelated config + feature flag)", { events: [
    { eventId: `drill-${run}-config`, kind: "change", changeType: "config", service: "notifications", environment, timestamp: ago(6), title: "SMTP pool size 10 → 20 on notifications", key: "smtp.pool", from: 10, to: 20, author: "ops-bot" },
    { eventId: `drill-${run}-flag`, kind: "change", changeType: "feature_flag", service, environment, timestamp: ago(4.5), flag: "instant-payouts", from: false, to: true, author: "product" }
  ] });
  await send("first errors + error-tracker alert", { events: [
    crash(48213, 3.5), crash(48219, 3.2),
    { ...crash(48222, 3), eventId: `drill-${run}-issue`, kind: "alert", title: "New issue: TypeError: Cannot read properties of undefined (reading 'iban')", detail: "First seen in drill-payouts production. 3 events, 3 users in 30s.", impactScore: 82, severity: "high" }
  ] });
  await send("more errors", { events: [crash(48230, 2.5), crash(48241, 1.8), crash(48257, 1.1), crash(48263, 0.5)] });
  await send("Grafana error-rate alert", { status: "firing", alerts: [{
    status: "firing", fingerprint: `drill-${run}-error-rate`, startsAt: ago(1),
    labels: { alertname: "PayoutsErrorRateHigh", service, environment, severity: "critical" },
    annotations: { summary: "drill-payouts error rate 6.4% (SLO 1%)", description: "5xx/failed payouts above SLO for 5 minutes. Wallet payouts only." }
  }] });
}

const latencyAlert = (status, at) => ({ status, alerts: [{
  status, fingerprint: "drill-payouts-p95-latency", startsAt: status === "firing" ? at : ago(3), endsAt: status === "resolved" ? at : "0001-01-01T00:00:00Z",
  labels: { alertname: "PayoutsLatencyHigh", service, environment, severity: "critical" },
  annotations: status === "firing"
    ? { summary: "drill-payouts p95 latency 4.2s (SLO 800ms)", description: "p95 above SLO for 3 minutes; 12% of payout requests time out." }
    : { summary: "drill-payouts p95 latency back to 310ms", description: "p95 below SLO for 5 minutes." }
}] });

if (scenario === "db-pool") {
  const stack = [
    "Error: timeout exceeded when trying to connect",
    "    at /app/node_modules/pg-pool/index.js:45:11",
    "    at withConnection (/app/drill/payouts-api/db.ts:18:9)",
    "    at sendPayout (/app/drill/payouts-api/send.ts:5:16)"
  ].join("\n");
  const timeout = (payout, minutesAgo) => ({
    eventId: `drill-${run}-timeout-${payout}`, kind: "metric", service, environment, release, timestamp: ago(minutesAgo),
    title: "Payout timed out waiting for a DB connection", detail: `Payout ${payout} waited 5s for a pooled connection.`, impactScore: 52, severity: "medium",
    error: { type: "TimeoutError", message: `timeout exceeded when trying to connect (payout ${payout})`, stack },
    metadata: { route: "POST /payouts", poolWaiting: 37 }
  });
  await send("changes (another team's deploy + the pool config change)", { events: [
    { eventId: `drill-${run}-notif-deploy`, kind: "change", changeType: "deploy", service: "notifications", environment, version: "v2.14.0", timestamp: ago(9), author: "notifications-team" },
    { eventId: `drill-${run}-pool`, kind: "change", changeType: "config", service, environment, timestamp: ago(6), title: "DB_POOL_MAX 50 → 5 on drill-payouts", key: "DB_POOL_MAX", from: 50, to: 5, author: "platform-oncall", url: "https://github.com/Shubh-Sgr/replayops-incident-time-machine/pulls" }
  ] });
  await send("first timeouts", { events: [timeout(51001, 4.6), timeout(51007, 4.2), timeout(51012, 3.9)] });
  await send("Grafana p95 latency alert (firing)", latencyAlert("firing", ago(3.5)));
  await send("more timeouts", { events: [timeout(51020, 3), timeout(51026, 2.2), timeout(51031, 1.4), timeout(51044, 0.6)] });
}

if (scenario === "db-pool-fix") {
  await send("config rolled back", { kind: "change", changeType: "config", eventId: `drill-${run}-pool-revert`, service, environment, timestamp: ago(0.5), title: "DB_POOL_MAX 5 → 50 on drill-payouts (revert)", key: "DB_POOL_MAX", from: 5, to: 50, author: "platform-oncall" });
  await send("Grafana p95 latency alert (resolved)", latencyAlert("resolved", ago(0)));
}

console.log(`\nDone (${scenario}). Open the drill-payouts incident in ReplayOps.`);
