# ReplayOps system walkthrough

This guide explains what the product actually does today, where each behavior lives in code, and where the boundaries are. Synthetic demo data is not real telemetry.

## End-to-end flow

```text
OTLP / GitHub / Grafana / generic webhook
                    │
                    ▼
       authenticated ingestion receiver
                    │
                    ▼
 provider payload → NormalizedSignal[]
                    │
                    ▼
 PostgreSQL ingestion_queue → retry / dead letter
                    │
                    ▼
 deduplicate → suppress → group → create or update incident
                    │
                    ▼
 evidence revision → hypotheses/tests → bounded validation
                    │
                    ▼
 measured recovery → user resolves → handoff/postmortem
```

## 1. How OpenTelemetry is connected

An administrator or responder creates an OpenTelemetry source in **Sources**. The API returns two values for that source:

- Endpoint: `<PUBLIC_API_URL>/ingest/<integration-id>`
- Header: `x-replayops-token=<connector-token>`

The token is derived per connector from `INGESTION_SIGNING_SECRET`; ReplayOps compares it in constant time. The free receiver accepts **OTLP HTTP/JSON**, not OTLP/gRPC or protobuf. An OpenTelemetry exporter sends to:

- `.../v1/traces`
- `.../v1/logs`
- `.../v1/metrics`

All three paths are handled by `ingestionRouter.post("/:integrationId/v1/:signal", receive)` in `apps/api/src/ingestion.ts`.

The receiver intentionally reduces volume:

- Traces: retain failed spans, spans slower than 2 seconds, and a deterministic 5% healthy sample.
- Logs: retain warning-or-higher records; errors become alert evidence.
- Metrics: retain operational metric names such as error, latency, timeout, retry, or saturation.

Important code:

- Connector endpoint and header: `apps/api/src/routes.ts` → `integrationView`
- Authentication, JSON validation, queue hand-off: `apps/api/src/ingestion.ts` → `receive`
- OTLP transformation: `normalizeOtelTraces`, `normalizeOtelLogs`, `normalizeOtelMetrics`

## 2. How source data becomes a common incident format

Each source has a provider-specific adapter, but every adapter returns the same `NormalizedSignal` shape:

```ts
{
  externalId, timestamp, service, environment,
  kind, title, detail, impactScore, severity,
  correlationKey, traceId, sourceUrl, metadata
}
```

GitHub events become deployment/change signals. OTLP spans, logs, and metrics become trace-backed evidence. Grafana firing alerts become `alert`; resolved alerts become `recovery`. Generic webhooks map supplied fields to the same contract.

The normalized signal is not automatically treated as a new incident. The repository first:

1. Deduplicates by connector plus external event ID.
2. Applies the workspace suppression and threshold policy.
3. Looks for an unresolved incident in the same organization and environment.
4. Prefers an exact correlation key; otherwise uses the service catalog and grouping time window.
5. Appends evidence to a match, or creates an `AUTO-*` incident when the threshold is crossed.
6. Backfills related precursor signals from the preceding 30 minutes.
7. Increments the evidence revision so stale analyses and approvals can be detected.

Important code: `apps/api/src/ingestion.ts` → `normalizePayload`; `apps/api/src/repository.ts` → `ingest` and `signalToEvent`.

## 3. Who can create or update an incident

Workspace roles are `admin`, `responder`, and `viewer`.

| Action | Admin | Responder | Viewer | Automation |
| --- | --- | --- | --- | --- |
| Read incidents/evidence | Yes | Yes | Yes | — |
| Create or edit incident | Yes | Yes | No | Creates from qualifying source signals |
| Add/correct/exclude evidence | Yes | Yes | No | Appends normalized source evidence |
| Request mitigation review | Yes | Yes | No | No |
| Approve another person's mitigation | Yes | No | No | No |
| Withdraw own pending request | Yes | Yes | No | No |
| Resolve an incident | Yes | Yes | No | Never automatically |

The API middleware in `apps/api/src/routes.ts` blocks non-GET mutations for viewers. Sensitive actions add a narrower rule: `WorkspaceService.reviewMitigation` requires an independent administrator for approval. The UI reads `/workspace` and only presents actions allowed for the current role; the server remains the authority.

## 4. How queuing works

ReplayOps uses a small durable **PostgreSQL-backed queue**, not Redis, Kafka, BullMQ, or a paid queue service. The table is `ingestion_queue` in `apps/api/src/queue.ts`.

Lifecycle:

```text
queued → processing → completed
              └────→ retrying → ... → dead_letter
```

- `(integration_id, external_id)` is unique, making webhook retries idempotent.
- The receiver tries the job immediately for low latency.
- A worker checks ready work every 30 seconds.
- Failed jobs retry with exponential delay: roughly 10s, 20s, 40s, and 80s, capped at 5 minutes.
- After five failed attempts the job becomes `dead_letter`.
- A processing lease older than five minutes is reclaimed, protecting against worker crashes.
- An admin or responder can retry a failed job from **Settings → Delivery queue**.

When PostgreSQL is not configured, local demo mode uses an in-memory queue. That version is useful for demonstrations but is lost on API restart and is not production-durable.

## 5. Who changes incident status, and when

- **Automation** creates a qualifying incident as `investigating`.
- **Automation** moves it to `monitoring` when a correlated recovery signal arrives. This does not mean recovered; it means ReplayOps has seen a recovery-shaped signal and expects verification.
- **Admin/responder** can update ownership and lifecycle through the incident header.
- **Admin/responder** can mark it `resolved` only after the newest recovery verification passes the server checks.
- **Admin/responder** can reopen a resolved incident if the issue returns.
- **Viewer** cannot change status.

Every successful user mutation produces a semantic audit event such as “updated incident status” or “approved mitigation”; the audit trail intentionally does not expose HTTP method/path noise.

## 6. How an incident is closed

Closing is deliberately a human action:

1. Open **Validate & recover**.
2. Record the real recovery metric, unit, healthy comparison direction, baseline, target, observed value, source/query, observation window, and observation time.
3. The server derives `verified`, `failed`, or `stale`; the browser cannot choose the result.
4. Move the incident to `monitoring` if it is not there already.
5. Click **Resolve with latest recovery**.

`PATCH /incidents/:id` calls `assertRecoveryVerified` before accepting `resolved`. The newest record wins: a newer failed observation prevents an older pass from closing the incident. ReplayOps never closes an incident solely because an alert resolved.

Important code: `apps/api/src/workspace.ts` → `saveRecovery`, `assertRecoveryVerified`; `apps/api/src/routes.ts` → incident PATCH; `apps/web/src/pages/IncidentWorkbenchPage.tsx` → lifecycle controls.

## 7. How hypotheses are generated

Core hypotheses are deterministic and evidence-driven; they are not invented by an LLM. `diagnoseIncident` in `apps/api/src/diagnosis.ts`:

1. Sorts active evidence by observed time.
2. Finds the first high-impact symptom.
3. Ranks preceding non-alert observations as origin/change candidates.
4. Builds the observed service path.
5. Separates evidence completeness from causal confidence.
6. Produces supporting evidence, contradictions/unknowns, a falsification test, and a safe bounded action.

Test outcomes change the state:

- A supported result raises the hypothesis.
- A disproved result moves it down and makes another explanation lead.
- Conflicting completed results mark it `contested` and change the next action to resolving the contradiction.
- Inconclusive results remain in history without pretending the claim was verified.

The optional Gemini/OpenAI assistant is contextual help for explaining or challenging this evidence. Questions and evidence are redacted before any external provider call. It is not the source of truth for incident status, approval, or recovery.

## 8. How similar past evidence is shown

`buildInvestigationIntelligence` in `apps/api/src/intelligence.ts` compares the current investigation with retained, same-service investigations. It currently looks for:

- Overlapping evidence kinds such as alert, deploy, dependency, and recovery.
- Differences in evidence kinds.
- Environment differences.
- Applicability warnings so an old fix is treated as a lead, not an answer.

It returns up to five comparisons and shows both **Similar** and **Different**. This comparison is structural and deterministic today; it is not yet a full vector similarity model. Semantic search exists elsewhere, but past-incident comparison deliberately remains explainable.

## 9. What bounded HTTP replay is for

The scenario estimate above it is only arithmetic. **Bounded HTTP replay** executes a captured HTTP request against a controlled target to answer a narrower and more useful question: “Does this exact request satisfy the expected behavior on this application version?”

The user records:

- Request method, path, redacted headers/body.
- Application version or image/Git SHA.
- Explicit expected status and optional body assertion.
- Dependency fixture descriptions.
- The exact incident evidence revision.

Execution in `apps/api/src/httpReplay.ts`:

1. Rejects authorization, cookie, token, password, and secret headers; redacts stored text.
2. Requires `REPLAY_TARGET_BASE_URL` to be loopback (`localhost`, `127.0.0.1`, or `::1`).
3. Blocks path/origin escape and redirects; applies a 5-second timeout.
4. Sends the identical request twice.
5. Evaluates explicit assertions and compares response digests to flag nondeterminism.
6. Preserves the spec, result, application version, and evidence revision.
7. Refuses to execute a stale spec after evidence changes.
8. Exports a versioned JSON manifest for CI/regression use.

Current limitation: dependency fixtures are captured as part of the immutable specification, but ReplayOps does not yet launch/inject those mocks itself. The target service must use the fixtures in its local/CI harness. ReplayOps restricts its own target URL to loopback; it does not sandbox the target process's outbound network. The UI reports these limits instead of claiming universal distributed-system replay.

## 10. How the timeline and evidence ledger scale

The timeline does not render one full-width label for every observation. `apps/web/src/lib/timeline.ts` first creates one real time domain for the incident and then derives:

1. Adaptive ticks suitable for seconds, minutes, hours, days, or months.
2. A density overview of the complete incident.
3. A bounded visible window for panning and zooming.
4. Per-service collision clusters, capped by horizontal resolution rather than event count.
5. At most eight visible lanes, with lower-volume services grouped transparently instead of discarded.

`CausalTrace.tsx` renders those derived values. It observes the actual plot width, scales tick and collision density to the available space, and reserves inset space so first/last markers are never clipped. Counted markers expose every overlapping event in an inline chooser. Point selection updates the URL and timeline detail in place; it never scrolls the responder away from the graph. The visible window is sent to `EvidenceLedger.tsx`, so the ledger initially shows only evidence that could appear in the chart. Responders can switch to the complete incident at any time.

The ledger uses server-compatible progressive pagination controls (25, 50, or 100 rows), semantic table markup on desktop, and compact touch rows on mobile. Search covers the human title, detail, service, type, provenance, and exact event ID, but UUIDs are not used as the primary label. Selecting any row opens one persistent inspector containing provenance, source links, correction history, grouping correction, audited edit, and exclusion/restore actions.

Large-range behavior is covered by `apps/web/src/lib/timeline.test.ts`, including a 90-day incident and 2,000 dense observations.

## Independent review demo

Use these local demo personas:

| Purpose | Email | Password |
| --- | --- | --- |
| Requester/operator | `operator@replayops.dev` | `ReplayOps!2026` |
| Independent admin reviewer | `reviewer@replayops.dev` | `ReplayOps!2026` |

Request a review as the operator, sign out, and sign in as the reviewer. The requester sees **Withdraw request**, not self-approval. The reviewer sees **Approve exact change** and **Reject**. Production must set `ENABLE_DEMO_MODE=false`; these demo identities are intentionally available only in demo mode.
