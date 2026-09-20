import type { Activity, DashboardData, Incident, ReplayRun } from "./types.js";

export const seedIncidents: Incident[] = [
  {
    id: "inc-1842", code: "ROP-1842", title: "Checkout retries amplified inventory latency",
    summary: "A delayed inventory replica triggered synchronized checkout retries and elevated payment authorization latency.",
    service: "checkout-api", severity: "critical", status: "identified", owner: "Maya Chen",
    startedAt: "2026-09-20T05:41:12.000Z", resolvedAt: null, createdAt: "2026-09-20T05:44:00.000Z", updatedAt: "2026-09-20T06:06:00.000Z",
    events: [
      { id: "evt-1842-1", incidentId: "inc-1842", timestamp: "2026-09-20T05:41:12.000Z", service: "inventory-api", kind: "metric", title: "Connection pool saturation begins", detail: "Pool utilization crossed 92% while median query time remained within baseline.", impactScore: 42 },
      { id: "evt-1842-2", incidentId: "inc-1842", timestamp: "2026-09-20T05:43:28.000Z", service: "inventory-api", kind: "dependency", title: "Replica lag exceeds checkout budget", detail: "Read replica lag reached 8.4 seconds while availability checks continued to pass.", impactScore: 68 },
      { id: "evt-1842-3", incidentId: "inc-1842", timestamp: "2026-09-20T05:45:03.000Z", service: "checkout-api", kind: "alert", title: "Retry amplification detected", detail: "Checkout retries increased 7.2× and propagated load to payment authorization.", impactScore: 91 },
      { id: "evt-1842-4", incidentId: "inc-1842", timestamp: "2026-09-20T05:47:19.000Z", service: "payments-api", kind: "alert", title: "Payment latency breaches SLO", detail: "P95 authorization latency reached 3.8 seconds; customer timeouts began.", impactScore: 96 },
      { id: "evt-1842-5", incidentId: "inc-1842", timestamp: "2026-09-20T05:54:44.000Z", service: "checkout-api", kind: "action", title: "Retry ceiling reduced", detail: "On-call changed retry attempts from four to one and drained the oldest queue partition.", impactScore: 58 },
      { id: "evt-1842-6", incidentId: "inc-1842", timestamp: "2026-09-20T06:02:11.000Z", service: "payments-api", kind: "recovery", title: "Authorization latency recovers", detail: "P95 returned below 620ms. Duplicate-order reconciliation remains in progress.", impactScore: 24 }
    ]
  },
  {
    id: "inc-1838", code: "ROP-1838", title: "Search indexing backlog after catalog import",
    summary: "A bulk catalog import exceeded the indexing consumer's safe concurrency and delayed search freshness.",
    service: "search-indexer", severity: "high", status: "monitoring", owner: "Noah Williams",
    startedAt: "2026-09-19T21:18:00.000Z", resolvedAt: null, createdAt: "2026-09-19T21:22:00.000Z", updatedAt: "2026-09-20T04:10:00.000Z",
    events: [
      { id: "evt-1838-1", incidentId: "inc-1838", timestamp: "2026-09-19T21:18:00.000Z", service: "search-indexer", kind: "alert", title: "Index freshness exceeds ten minutes", detail: "Consumer lag rose after a 2.1 million item catalog import.", impactScore: 72 },
      { id: "evt-1838-2", incidentId: "inc-1838", timestamp: "2026-09-19T21:31:00.000Z", service: "search-indexer", kind: "action", title: "Consumer concurrency capped", detail: "Concurrency was reduced to prevent database connection exhaustion.", impactScore: 43 }
    ]
  },
  {
    id: "inc-1829", code: "ROP-1829", title: "Session cache eviction storm",
    summary: "A cache node replacement shifted hot keys to one shard and increased authentication misses.",
    service: "identity-edge", severity: "medium", status: "resolved", owner: "Ishan Rao",
    startedAt: "2026-09-18T09:10:00.000Z", resolvedAt: "2026-09-18T10:02:00.000Z", createdAt: "2026-09-18T09:13:00.000Z", updatedAt: "2026-09-18T11:20:00.000Z",
    events: [{ id: "evt-1829-1", incidentId: "inc-1829", timestamp: "2026-09-18T09:10:00.000Z", service: "identity-edge", kind: "deploy", title: "Cache node replacement completed", detail: "Consistent-hash ring converged with one shard carrying 46% of hot keys.", impactScore: 61 }]
  }
];

export const seedActivities: Activity[] = [
  { id: "activity-1", incidentId: "inc-1842", actor: "Maya Chen", action: "isolated initiating dependency", detail: "Marked inventory replica lag as the likely trigger.", timestamp: "2026-09-20T06:06:00.000Z" },
  { id: "activity-2", incidentId: "inc-1838", actor: "Replay worker", action: "completed candidate replay", detail: "Concurrency cap prevented connection saturation in 18 of 18 runs.", timestamp: "2026-09-20T05:58:00.000Z" },
  { id: "activity-3", actor: "System", action: "ingested synthetic telemetry", detail: "1,248 normalized events added to the demonstration workspace.", timestamp: "2026-09-20T05:36:00.000Z" }
];

export const seedReplayRuns: ReplayRun[] = [
  { id: "replay-1", incidentId: "inc-1842", name: "Retry ceiling: 4 → 1", status: "running", progress: 68, createdAt: "2026-09-20T06:03:00.000Z" },
  { id: "replay-2", incidentId: "inc-1838", name: "Indexer concurrency cap", status: "passed", progress: 100, createdAt: "2026-09-20T05:35:00.000Z" }
];

export const seedDashboardSeries: Pick<DashboardData, "serviceHealth" | "eventVolume"> = {
  serviceHealth: [
    { service: "checkout-api", availability: 98.72, latencyMs: 842, errorRate: 3.8, state: "critical" },
    { service: "inventory-api", availability: 99.31, latencyMs: 486, errorRate: 1.7, state: "degraded" },
    { service: "payments-api", availability: 99.86, latencyMs: 612, errorRate: 0.8, state: "degraded" },
    { service: "identity-edge", availability: 99.99, latencyMs: 84, errorRate: 0.03, state: "nominal" }
  ],
  eventVolume: [
    { time: "05:35", requests: 48, errors: 2 }, { time: "05:40", requests: 52, errors: 3 },
    { time: "05:45", requests: 74, errors: 18 }, { time: "05:50", requests: 91, errors: 31 },
    { time: "05:55", requests: 82, errors: 22 }, { time: "06:00", requests: 68, errors: 10 },
    { time: "06:05", requests: 58, errors: 4 }
  ]
};
