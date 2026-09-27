# ReplayOps final flow specification — 2026-09-27

This is the durable source of truth for the post-review product. It supersedes the universal scenario estimator and the earlier three-screen proposal. ReplayOps is an investigation record and proof loop, not an observability replacement and not a universal distributed-system simulator.

## Product contract

ReplayOps helps a responder do four things:

1. Understand the actual failure using service-, environment-, identity-, and time-scoped evidence.
2. Run a useful check and retain its question, method, conditions, result, evidence links, owner, and conclusion.
3. Validate an exact, immutable proposed change with an exact CI run, clearly labeled operator evidence, or genuine isolated HTTP execution.
4. Establish recovery, enter Monitoring, resolve with a reason, and preserve an auditable handoff.

The primary work areas are **Investigate**, **Fix & verify**, and **Activity & handoff**. Evidence and the timeline remain directly accessible. Advanced replay is available but is not a mandatory step.

## Trust boundaries

- Observed facts, inferred explanations, operator-reported evidence, CI outcomes, isolated executions, and recovery measurements are distinct record types.
- CI success proves the specified delivery workflow only. It does not prove runtime health.
- A GitHub-only case may resolve against an exact successful rerun, but its handoff must state that production health was not measured.
- A runtime case requires typed measurements with unit, comparison direction, source, query or link, interval, observed time, and freshness.
- Missing, malformed, stale, or newer failing data cannot pass recovery.
- Resolution is a server-owned transition. The server locks the incident, compares the expected evidence revision, re-evaluates recovery, writes status and the audit record in one transaction, and requires a reason.
- If the latest proposal exists, it must have a passing validation artifact and independent approval from another administrator before resolution.
- AI is optional contextual assistance. It is not required for ingestion, diagnosis, validation, approval, recovery, or resolution. Sensitive values are redacted before external generation or embedding.

## Flow 1 — Understand the failure

The investigation header exposes customer symptom/impact, service, environment, owner, evidence freshness, current explanation, unknowns, and one useful next action. The evidence timeline is synchronized with its inspector and remains URL-addressable.

Ingestion requirements:

- GitHub workflow, deployment, and push records retain repository, workflow/deployment identity, SHA/ref, run/attempt, state, and source. Success and inactivity are not runtime failures.
- Grafana alert lifecycle events retain per-alert status, start/end time, fingerprint/rule identity, environment, values, reason, and source. Firing, resolved, and refiring records are unique.
- OTLP spans retain trace/span/parent identity and scope. Metrics retain numeric value validity, metric type, unit, temporality, monotonicity, interval, resource dimensions, and attributes. A zero gauge is a measurement, not an alert.
- Unknown timestamps fail closed to an explicit unknown-time sentinel; they are never silently replaced with ingestion time.
- Incident grouping is scoped by tenant, environment, service identity, correlation identity, and policy window. Corrections preserve provenance.

Comparisons must match route, method, region, release where available, and comparable windows. Customer-impact rates require numerator and denominator from the same measurement series and interval; otherwise the denominator is unknown.

## Flow 2 — Run and preserve a useful check

ReplayOps provides five check templates: matched cohort comparison, recent-change inspection, end-to-end trace inspection, scoped runtime query, and bounded HTTP reproduction. A check records prerequisites, expected signal, conditions, owner, result, linked evidence IDs, and evidence revision.

“Already checked” is a first-class view. A per-user review cursor records the evidence revision last reviewed. Historical conclusions remain visible. When evidence changes, any conclusion bound to an older revision becomes `needs_recheck`; it is never silently rewritten.

## Flow 3 — Validate an exact proposed change

Every proposal edit creates an immutable version containing target service, environment, code/config identity, change, rollback plan, evidence revision, author, and predecessor.

Validation artifacts are version-bound:

- **CI**: ReplayOps verifies an ingested event with exact repository, workflow, SHA, run ID, and attempt. Status is derived from the source event.
- **Operator-reported**: always visibly labeled and never represented as automated execution.
- **Isolated HTTP**: immutable redacted request, application version, controlled dependency declaration, explicit assertions, loopback-only target, redirects disabled, timeout and response bound, preserved output, and an honest unsupported result when prerequisites are absent.

Approval is separate from validation and execution. Only another workspace administrator can approve the exact version; the requester cannot self-approve. Evidence changes invalidate the request.

## Flow 4 — Establish recovery and resolve

Recovery criteria are immutable versions. Runtime criteria define metric, source, query, unit, comparison, target, required consecutive windows, observation duration, and freshness. Delivery criteria define the exact workflow identity.

Typed runtime measurements preserve value or explicit missing state, unit, source, query/link, window start/end, observed time, and note. Server evaluation uses the latest applicable windows. A newer failure overrides older passes.

The lifecycle is:

`Investigating / Identified → Monitoring → Resolved`

The user starts Monitoring to begin the bounded observation period. Resolve becomes available only after current recovery evaluates `verified`, a reason is entered, the evidence revision is unchanged, and any latest proposal has independent approval. Reopening clears `resolved_at` and returns the case to Investigating.

## Required journeys

- Delivery-only: exact workflow failure → check → proposal → exact rerun validation → independent approval → delivery criterion → Monitoring → Resolved, with runtime health explicitly unknown.
- Runtime regression: scoped telemetry → check → proposal → validation → criterion → passing windows → Monitoring; a newer failure blocks resolution until new consecutive passing windows exist.
- Uncertain root cause: preserve inconclusive/disproved checks and unknowns, mitigate safely if needed, verify measured recovery, resolve with unresolved-cause reason, and retain follow-ups.

All journeys must survive reload when PostgreSQL is configured. Demo mode is synthetic and process-memory backed by design.
