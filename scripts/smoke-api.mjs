// End-to-end smoke test for a running demo-mode ReplayOps API (ENABLE_DEMO_MODE=true, no DATABASE_URL).
// Usage: npm run dev (in another terminal), then: npm run smoke   — or API=http://host:port node scripts/smoke-api.mjs
// It walks ingestion, incident CRUD, search, the check → proposal → validation → independent review →
// recovery → monitoring → resolve journey, and error handling, then removes what it created.
const BASE = process.env.API ?? "http://localhost:8787";
const tok = (id, email) => "demo-session." + Buffer.from(JSON.stringify({ id, email })).toString("base64url");
const OP = tok("00000000-0000-4000-8000-000000000001", "operator@replayops.dev");
const RV = tok("00000000-0000-4000-8000-000000000002", "reviewer@replayops.dev");
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
async function call(method, path, body, token = OP, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const now = Date.now(); const iso = (ms) => new Date(ms).toISOString();

// Platform
let r = await call("GET", "/health", undefined, null).catch(() => { console.error(`Cannot reach ${BASE}. Start the API with npm run dev first.`); process.exit(1); }); check("health", r.status === 200 && r.body.status === "ok");
r = await call("GET", "/api/incidents", undefined, null); check("unauthenticated rejected", r.status === 401);
r = await call("GET", "/api/nope"); check("unknown route 404", r.status === 404);
r = await call("POST", "/api/incidents", "{bad json"); check("malformed JSON is 400 not 500", r.status === 400, `got ${r.status} ${JSON.stringify(r.body).slice(0,120)}`);
r = await call("GET", "/api/dashboard"); check("dashboard", r.status === 200 && Array.isArray(r.body.incidents), `${r.body.incidents?.length} incidents`);
r = await call("GET", "/api/workspace"); check("workspace context", r.status === 200, JSON.stringify(r.body).slice(0,120));

// Ingestion
r = await call("POST", "/api/integrations", { name: "E2E generic", provider: "generic" }); check("create connector", r.status === 201);
const integ = r.body;
r = await call("POST", `/ingest/${integ.id}`, { service: "orders-api", kind: "alert", title: "Orders 5xx spike", detail: "5xx rate crossed 12% on POST /orders", impactScore: 92, environment: "production", timestamp: iso(now - 600000), eventId: "e2e-evt-1" }, null, { "x-replayops-token": "wrong" });
check("ingest rejects bad token", r.status === 401);
r = await call("POST", `/ingest/${integ.id}`, { service: "orders-api", kind: "alert", title: "Orders 5xx spike", detail: "5xx rate crossed 12% on POST /orders", impactScore: 92, environment: "production", timestamp: iso(now - 600000), eventId: "e2e-evt-1" }, null, { "x-replayops-token": integ.connector.token, "x-request-id": "e2e-delivery-1" });
check("ingest alert creates incident", [200, 202].includes(r.status) && r.body.incidentIds?.length > 0, JSON.stringify(r.body).slice(0, 160));
const ingestedId = r.body.incidentIds?.[0];
r = await call("POST", `/ingest/${integ.id}`, { service: "orders-api", kind: "alert", title: "Orders 5xx spike", detail: "5xx rate crossed 12% on POST /orders", impactScore: 92, environment: "production", timestamp: iso(now - 600000), eventId: "e2e-evt-1" }, null, { "x-replayops-token": integ.connector.token, "x-request-id": "e2e-delivery-1" });
check("duplicate delivery idempotent", r.status === 200 && r.body.status === "duplicate", JSON.stringify(r.body).slice(0, 120));
r = await call("POST", `/api/integrations/${integ.id}/test`); check("connector self-test", r.status === 202, JSON.stringify(r.body).slice(0, 120));
const selfTestId = r.body?.incidentIds?.[0];
r = await call("GET", "/api/ingestion-queue"); check("ingestion queue list", r.status === 200 && Array.isArray(r.body));

// Incident CRUD
r = await call("POST", "/api/incidents", { title: "x", summary: "short", service: "a", severity: "bad", status: "investigating", owner: "M", startedAt: "nope" });
check("create validation errors 400", r.status === 400);
r = await call("POST", "/api/incidents", { title: "E2E latency regression on orders", summary: "P95 latency on POST /orders rose from 300ms to 2.4s after deploy.", service: "orders-api", environment: "production", customerImpact: "Checkout slow for ~8% of users", severity: "high", status: "investigating", owner: "Maya Chen", startedAt: iso(now - 3600000) });
check("create incident", r.status === 201, r.body?.code);
const inc = r.body;
r = await call("POST", `/api/incidents/${inc.id}/events`, { timestamp: iso(now - 3500000), service: "orders-api", kind: "deploy", title: "Deploy v2.4.1", detail: "Rolled out orders-api v2.4.1 with new ORM version", impactScore: 40, metadata: { traceId: "abc123" } });
check("add event", r.status === 201); const ev1 = r.body;
r = await call("POST", `/api/incidents/${inc.id}/events`, { timestamp: iso(now - 3400000), service: "orders-db", kind: "metric", title: "Query time p95 up", detail: "SELECT on orders_items p95 went from 20ms to 1.9s", impactScore: 85 });
check("add second event", r.status === 201); const ev2 = r.body;
r = await call("PATCH", `/api/incidents/${inc.id}/events/${ev2.id}`, { detail: "SELECT on order_items p95 went from 20ms to 1.9s (N+1 query)", correctionReason: "Fixed table name" });
check("correct event", r.status === 200);
r = await call("PATCH", `/api/incidents/${inc.id}/events/00000000-0000-4000-8000-00000000dead`, { detail: "does not exist at all" });
check("patch missing event 404", r.status === 404);
r = await call("PATCH", `/api/incidents/${inc.id}`, { status: "resolved" }); check("direct resolve blocked", r.status === 409);
r = await call("PATCH", `/api/incidents/${inc.id}`, { status: "identified" }); check("update status", r.status === 200 && r.body.status === "identified");
r = await call("GET", `/api/incidents/${inc.id}/events?limit=20`); check("paginated events", r.status === 200 && r.body.total === 2);
r = await call("GET", `/api/incidents/${inc.id}/diagnosis`); check("diagnosis", r.status === 200, Object.keys(r.body ?? {}).join(","));
r = await call("GET", `/api/incidents/${inc.id}/intelligence`); check("intelligence", r.status === 200);
r = await call("POST", "/api/search", { query: "orders latency" }); check("search finds new incident", r.status === 200 && r.body.some((x) => x.incident.id === inc.id));
r = await call("POST", "/api/search", { query: inc.code }); check("search by code", r.status === 200 && r.body[0]?.incident.id === inc.id);
r = await call("POST", "/api/assistant", { question: "What caused the latency?", incidentId: inc.id }); check("assistant answer with citations", r.status === 200 && r.body.citations?.length > 0, r.body?.mode);
r = await call("GET", "/api/incidents/does-not-exist"); check("missing incident 404", r.status === 404);

// Casework journey
r = await call("GET", `/api/incidents/${inc.id}/casework`); check("casework snapshot", r.status === 200, `caseKind=${r.body?.caseKind}`);
const tmpl = r.body.suggestedChecks[1];
r = await call("POST", `/api/incidents/${inc.id}/checks`, { templateId: tmpl.id, title: tmpl.title, question: tmpl.question, method: tmpl.method, expectedSignal: tmpl.expectedSignal, conditions: "prod, last 1h", assignee: "Maya Chen", evidenceIds: [ev1.id] });
check("create check", r.status === 201); const chk = r.body;
r = await call("PATCH", `/api/incidents/${inc.id}/checks/${chk.id}`, { status: "supported", result: "no" }); check("check outcome requires result", r.status === 400);
r = await call("PATCH", `/api/incidents/${inc.id}/checks/${chk.id}`, { status: "supported", result: "ORM upgrade introduced N+1 on order_items", evidenceIds: [ev1.id, ev2.id] }); check("record check outcome", r.status === 200);
r = await call("PATCH", `/api/incidents/${inc.id}/checks/00000000-0000-4000-8000-00000000dead`, { status: "supported", result: "whatever this is" }); check("patch missing check -> 404", r.status === 404, `got ${r.status}`);
r = await call("POST", `/api/incidents/${inc.id}/proposals`, { title: "Revert ORM", change: "Pin ORM back to 5.2.0 in orders-api", rollbackPlan: "Redeploy v2.4.1 image", target: { service: "orders-api", environment: "production" } });
check("create proposal v1", r.status === 201 && r.body.version === 1); const prop = r.body;
r = await call("POST", `/api/incidents/${inc.id}/proposals/${prop.id}/review-request`); check("review needs passing validation", r.status === 409);
r = await call("POST", `/api/incidents/${inc.id}/validations`, { proposalId: prop.id, kind: "manual", status: "passed", summary: "Staging load test p95 310ms", provenance: { operator: "Maya" } }); check("manual validation", r.status === 201);
r = await call("POST", `/api/incidents/${inc.id}/validations`, { proposalId: prop.id, kind: "ci", status: "passed", summary: "CI run", provenance: { repository: "x/y", workflow: "ci", sha: "abc", runId: 1, attempt: 1 } }); check("CI validation w/o matching event rejected", r.status === 400);
r = await call("POST", `/api/incidents/${inc.id}/proposals/${prop.id}/review-request`); check("request review", r.status === 201); const review = r.body;
r = await call("PATCH", `/api/incidents/${inc.id}/proposal-reviews/${review.id}`, { status: "approved", reason: "I approve my own change" }); check("self-approval blocked (403)", r.status === 403);
r = await call("PATCH", `/api/incidents/${inc.id}/proposal-reviews/${review.id}`, { status: "approved", reason: "Rollback plan verified" }, RV); check("independent approval", r.status === 200 && r.body.status === "approved", JSON.stringify(r.body).slice(0,120));
r = await call("POST", `/api/incidents/${inc.id}/recovery-criteria`, { kind: "runtime", name: "POST /orders p95", source: "Grafana", query: "histogram_quantile(0.95, ...)", unit: "ms", comparison: "lte", targetValue: 400, minConsecutiveWindows: 2, maxAgeMinutes: 30, observationMinutes: 10, deliveryIdentity: null });
check("recovery criterion", r.status === 201); const crit = r.body;
const meas = (value, endOffsetMin) => ({ criterionId: crit.id, value, unit: "ms", source: "Grafana", query: "p95", windowStartedAt: iso(now - (endOffsetMin + 5) * 60000), windowEndedAt: iso(now - endOffsetMin * 60000), observedAt: iso(now - endOffsetMin * 60000), state: "valid", note: "" });
r = await call("POST", `/api/incidents/${inc.id}/measurements`, meas(320, 10)); check("measurement 1", r.status === 201);
r = await call("POST", `/api/incidents/${inc.id}/measurements`, meas(300, 5)); check("measurement 2", r.status === 201);
r = await call("POST", `/api/incidents/${inc.id}/measurements`, { ...meas(300, 5), windowEndedAt: iso(now - 20 * 60000) }); check("inverted window rejected 4xx", r.status >= 400 && r.status < 500, `got ${r.status}`);
r = await call("GET", `/api/incidents/${inc.id}/casework`); check("recovery verified", r.body.recovery.state === "verified", r.body.recovery.reason);
let cur = (await call("GET", `/api/incidents/${inc.id}`)).body; const rev = cur.evidenceRevision ?? cur.updatedAt;
r = await call("POST", `/api/incidents/${inc.id}/lifecycle`, { action: "resolve", reason: "Recovered after revert", expectedEvidenceRevision: rev }); check("resolve before monitoring blocked", r.status === 409, r.body?.error);
r = await call("POST", `/api/incidents/${inc.id}/lifecycle`, { action: "start_monitoring", reason: "Revert deployed, observing", expectedEvidenceRevision: "2020-01-01T00:00:00.000Z" }); check("stale revision rejected", r.status === 409);
r = await call("POST", `/api/incidents/${inc.id}/lifecycle`, { action: "start_monitoring", reason: "Revert deployed, observing", expectedEvidenceRevision: rev }); check("start monitoring", r.status === 200 && r.body.status === "monitoring", `got ${r.status} ${r.body?.error ?? ""}`);
cur = (await call("GET", `/api/incidents/${inc.id}`)).body;
r = await call("POST", `/api/incidents/${inc.id}/lifecycle`, { action: "resolve", reason: "Recovered after revert", expectedEvidenceRevision: cur.evidenceRevision ?? cur.updatedAt }); check("resolve", r.status === 200 && r.body.status === "resolved", `got ${r.status} ${r.body?.error ?? ""}`);
r = await call("GET", "/api/audit"); const audits = r.body.map((a) => a.action);
check("audit has lifecycle transitions", audits.some((a) => /monitoring/i.test(a)) && audits.some((a) => /resolved/i.test(a)), audits.slice(0, 8).join(" | "));
cur = (await call("GET", `/api/incidents/${inc.id}`)).body;
r = await call("POST", `/api/incidents/${inc.id}/lifecycle`, { action: "reopen", reason: "Regression seen again", expectedEvidenceRevision: cur.evidenceRevision ?? cur.updatedAt }); check("reopen", r.status === 200 && r.body.status === "investigating" && !r.body.resolvedAt);

// Newer failure blocks
r = await call("POST", `/api/incidents/${inc.id}/measurements`, meas(900, 1)); r = await call("GET", `/api/incidents/${inc.id}/casework`); check("newer failure -> failed", r.body.recovery.state === "failed", r.body.recovery.state);

// Evidence change marks checks needs_recheck
await call("POST", `/api/incidents/${inc.id}/evidence-review`);
await call("POST", `/api/incidents/${inc.id}/events`, { timestamp: iso(now - 60000), service: "orders-api", kind: "alert", title: "Latency again", detail: "p95 back to 900ms after cache flush", impactScore: 70 });
r = await call("GET", `/api/incidents/${inc.id}/casework`); check("evidence change -> needs_recheck", r.body.evidenceReview.changed && r.body.checks.some((c) => c.conclusionState === "needs_recheck"));

// HTTP replay, comments, postmortem, bundle
r = await call("POST", `/api/incidents/${inc.id}/http-replays`, { name: "POST orders repro", applicationVersion: "v2.4.1", request: { method: "GET", path: "/health", headers: {} }, assertions: { status: 200 }, dependencies: [] }); check("create http replay", r.status === 201); const spec = r.body;
r = await call("POST", `/api/http-replays/${spec.id}/execute`); check("execute http replay (unsupported w/o target ok)", r.status === 201, `${r.status} ${r.body?.status} ${r.body?.reason ?? r.body?.error ?? ""}`.slice(0, 160));
r = await call("POST", `/api/incidents/${inc.id}/comments`, { body: "Looks like the ORM bump", eventId: ev1.id }); check("comment", r.status === 201);
r = await call("PUT", `/api/incidents/${inc.id}/postmortem`, { summary: "s", rootCause: "N+1", impact: "8%", recovery: "revert", followUps: "add test", status: "draft" }); check("postmortem", r.status === 200);
r = await call("POST", `/api/incidents/${inc.id}/evidence-bundle`); check("evidence bundle", r.status === 201);
r = await call("PATCH", "/api/hypothesis-tests/00000000-0000-4000-8000-00000000dead", { status: "supported", result: "evidence text here" }); check("patch missing hypothesis test -> 404", r.status === 404, `got ${r.status}`);
r = await call("PATCH", "/api/mitigations/00000000-0000-4000-8000-00000000dead", { status: "approved" }); check("patch missing mitigation -> 409", r.status === 409, `got ${r.status}`);
r = await call("POST", "/api/ingestion-queue/nope/retry"); check("retry missing job -> 404", r.status === 404, `got ${r.status}`);
r = await call("GET", `/api/incidents/does-not-exist/mitigations`); check("mitigations for missing incident -> 404", r.status === 404, `got ${r.status}`);

// Cleanup
if (ingestedId) { r = await call("GET", `/api/incidents/${ingestedId}`); check("ingested incident readable", r.status === 200, `${r.body?.code} env=${r.body?.environment}`); }
r = await call("DELETE", `/api/incidents/${inc.id}`); check("delete incident", r.status === 204);
for (const id of [ingestedId, selfTestId]) if (id) await call("DELETE", `/api/incidents/${id}`);
r = await call("DELETE", `/api/integrations/${integ.id}`); check("delete connector", r.status === 204);
const failed = results.filter((x) => !x.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); if (failed.length) { console.log("FAILED:", failed.map((x) => x.name).join("; ")); process.exitCode = 1; }
