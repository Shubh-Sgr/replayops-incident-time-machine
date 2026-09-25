# ReplayOps Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React with Vite and TypeScript; Tailwind CSS, Lucide icons, and Framer Motion; Express and Node.js; PostgreSQL with pgvector; Supabase Auth; deployable to Vercel and Render. This stack is explicitly specified by the brief.

## Users

- Primary: on-call software engineers and site reliability engineers investigating active or recent production incidents.
- Secondary: engineering managers and incident commanders reviewing system health and remediation confidence.
- Inferred situation: users arrive under time pressure and must correlate disconnected logs, traces, deploys, and alerts.

## Product Purpose

ReplayOps turns operational telemetry into a reviewable investigation. It helps teams measure who is affected, compare healthy and failing requests, test competing explanations, validate a bounded candidate fix, prove actual recovery, and preserve the learning as a reusable regression.

Success means moving from alert to a defensible next test and measured recovery with less manual correlation while retaining provenance, explicit unknowns, and human control.

## Positioning

ReplayOps is an incident time machine, not another monitoring dashboard or incident chat room. It transforms imported evidence into a time-ordered investigation, ranks competing explanations, tells the responder what observation could disprove each one, and can execute a deliberately bounded HTTP regression against an isolated candidate build.

### Why a team uses ReplayOps alongside existing tools

- Datadog, Grafana, Honeycomb, and similar observability products remain the systems of record for querying raw metrics, logs, and traces. ReplayOps consumes their evidence and turns it into a testable debugging argument.
- Rootly, incident.io, FireHydrant, and similar response products remain the systems of engagement for paging, roles, chat, runbooks, and status communication. ReplayOps focuses on the unresolved technical question: what should the engineer test next, and what evidence would change the diagnosis?
- ReplayOps wins when responders need a reviewable chain from symptom → evidence → explanation → falsification test → bounded validation → measured recovery → regression test. It does not compete by duplicating alert routing, chat capture, status pages, or generic dashboards.

### Differentiated proof loop

1. State the customer symptom, denominator, environment, owner, evidence freshness, and unknowns.
2. Compare matched healthy and failing cohorts while disclosing sampling limits.
3. Maintain multiple explanations with supporting, conflicting, and completed-test evidence.
4. Assign a concrete falsification test; its outcome changes diagnosis and the next action.
5. Use contextual, redacted AI as an evidence reviewer that cites sources and cannot approve actions.
6. Keep arithmetic scenario estimates separate from isolated HTTP replay execution.
7. Require fresh, sourced, server-derived recovery measurements before resolution.
8. Export the proven failure/fix pair as a versioned CI regression manifest.

## Operating Context

- Continuous incident intake through signed GitHub, OpenTelemetry HTTP/JSON, Grafana, and generic webhook connectors, with manual evidence reserved for human observations.
- Investigation inbox for active work, ownership, next actions, source freshness, and intake failures.
- Workbench with synchronized event timeline/evidence inspector, cohorts, changes, explanations, tests, validation, recovery, and handoff.
- Exact-ID and semantic search plus contextual assistance grounded in selected and historical evidence.
- Acknowledge, assign, transition, replay, and resolve workflows.

## Capabilities and Constraints

- Email/password and social authentication with persistent sessions.
- Protected routes and multi-tenant-ready data schema.
- Incident and event CRUD with optimistic updates and rollback.
- pgvector semantic search with deterministic text fallback.
- Provider-optional AI; core workflows function without an AI key.
- Deterministic diagnosis ranking with explicit confidence blockers and no invented conclusion when evidence is absent.
- Signed, provider-specific ingestion with delivery deduplication, normalized evidence buffering, trace/release correlation, and threshold-based incident creation.
- Automatic precursor backfill: ordinary deploys and metrics stay buffered, then attach when a related high-impact signal opens an incident.
- Adversarial AI review for disconfirming evidence and falsification tests; model output remains subordinate to recorded evidence.
- Transparent scenario estimates that never claim execution or predict recovery.
- Immutable, bounded HTTP replay history with explicit assertions, application version, dependency fixtures, evidence revision, loopback-only execution, and nondeterminism detection.
- Assignable hypothesis tests with explicit supported, disproved, and inconclusive outcomes.
- Qualitative evidence completeness and explanation state; no uncalibrated causal-confidence percentage.
- Live workbench refresh, exact-event drill-down, source telemetry links, and reversible grouping correction.
- Measured recovery verification required before resolution, plus persistent handoff and postmortem records.
- Free in-app action notifications for approvals, assigned tests, and dead-letter ingestion.
- Supabase-backed durable intake jobs with retry backoff, dead-letter review, and operator replay.
- Service ownership/dependency context plus configurable grouping, threshold, suppression, and maintenance policies.
- Team roles, email-delivered expiring invitations with manual fallback, immutable workspace audit entries, and independent mitigation approval.
- Evidence-level AI citations, secret/PII redaction before chat and embeddings, and an explicit provider-disabled mode.
- Healthy/failing cohort comparison, recent-change candidates, provider-specific next-test queries, historical comparison, measured impact, and redacted evidence bundles.
- Privacy-aware product instrumentation for completed tests, grouping correction, replay execution, and verified recovery—not prompt volume.
- Responsive light and dark modes.
- Free-tier Vercel, Render, and Supabase deployment configuration.
- Synthetic demonstrations are labeled.
- AI results are hypotheses, never guaranteed root-cause claims.

## Brand Commitments

- Product name: ReplayOps.
- Voice: calm, precise, operational, evidence-led, never alarmist.
- No generic AI visual tropes, Inter or Roboto, purple-blue gradients, side-stripe cards, pure black, or pure-white cards nested on gray.

## Evidence on Hand

No customer logos, testimonials, production benchmarks, or real incident data were supplied. Synthetic operational data may be authored when clearly labeled.

## Product Principles

1. Evidence before explanation.
2. Time pressure changes hierarchy.
3. AI advises; operators decide.
4. Replay inputs and outcomes are reproducible.
5. Core workflows degrade gracefully.

## Accessibility & Inclusion

Target WCAG 2.2 AA with keyboard operation, visible focus, reduced motion, semantic landmarks, non-color status indicators, accessible chart summaries, and responsive behavior from 390px upward.

## Explicitly Inferred Decisions

- Initial tenant: one synthetic organization, schema ready for multiple tenants.
- Initial telemetry: native GitHub and OTLP HTTP/JSON receivers plus a normalized generic/Grafana webhook; binary OTLP and vendor OAuth apps remain future extensions.
- Replay: a narrow HTTP workload executed only against a loopback candidate service in an isolated local/CI environment. Distributed-system replay and production execution are explicitly unsupported.
- Integrations: receivers are intentionally push-based so they run on the existing free API service without polling workers or paid queues.
- Surface mode: Operate.
