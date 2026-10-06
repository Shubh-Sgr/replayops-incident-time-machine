#!/usr/bin/env node
/**
 * Drill: a release that passed its health check meets real traffic. Sends to a Generic webhook source what
 * a real stack would send over a few minutes:
 *   - an unrelated config change on another service, and a feature flag flipped on drill-payouts (red herring)
 *   - TypeError occurrences from wallet payouts, with a stack trace into drill/payouts-api/iban.ts, tagged with
 *     the running release (the git SHA, as Sentry's `release` or OpenTelemetry's `service.version` would be)
 *   - an error-tracker "new issue" alert, then a Grafana-format error-rate alert
 *
 * Usage (receiver endpoint and connector token from Integrations → your Generic webhook source):
 *   REPLAYOPS_RECEIVER=https://… REPLAYOPS_TOKEN=… node scripts/drill-runtime-errors.mjs <release-sha>
 */
const receiver = process.env.REPLAYOPS_RECEIVER;
const token = process.env.REPLAYOPS_TOKEN;
const release = (process.argv[2] ?? "").trim();
if (!receiver || !token || !/^[0-9a-f]{7,40}$/i.test(release)) {
  console.error("Set REPLAYOPS_RECEIVER and REPLAYOPS_TOKEN, and pass the deployed commit SHA: node scripts/drill-runtime-errors.mjs cf67512");
  process.exit(1);
}

const run = Date.now().toString(36);
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const service = "drill-payouts";
const environment = "production";
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

async function send(label, body) {
  const response = await fetch(receiver, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const text = await response.text();
  console.log(`${response.ok ? "✓" : "✗"} ${label}: ${response.status} ${text.slice(0, 200)}`);
  if (!response.ok) process.exit(1);
}

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

console.log(`\nDone. Open the new drill-payouts incident in ReplayOps and look at "What changed".`);
