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

ReplayOps turns operational telemetry into a replayable incident narrative. It helps teams identify a likely initiating event, inspect propagation, search prior incidents semantically, and compare a proposed fix against the recorded sequence.

Success means moving from alert to defensible causal hypothesis and replay plan with less manual correlation while retaining evidence links and human control.

## Positioning

ReplayOps is an incident time machine, not another monitoring dashboard or incident chat room. It transforms imported evidence into an ordered causal graph, ranks competing explanations, tells the responder what observation could disprove each one, and estimates whether a candidate mitigation would interrupt the recorded propagation.

### Why a team uses ReplayOps alongside existing tools

- Datadog, Grafana, Honeycomb, and similar observability products remain the systems of record for querying raw metrics, logs, and traces. ReplayOps consumes their evidence and turns it into a testable debugging argument.
- Rootly, incident.io, FireHydrant, and similar response products remain the systems of engagement for paging, roles, chat, runbooks, and status communication. ReplayOps focuses on the unresolved technical question: what should the engineer test next, and what evidence would change the diagnosis?
- ReplayOps wins when responders need a reviewable chain from precursor → symptom → propagation → falsification test → mitigation replay. It does not compete by duplicating alert routing, chat capture, status pages, or generic dashboards.

### Differentiated proof loop

1. Rank precursor and change candidates by causal order and propagation, not alert loudness.
2. Compare the pre-symptom and failure windows to expose overrepresented services and signal types.
3. Maintain multiple hypotheses with supporting and conflicting evidence.
4. Produce a concrete, reversible falsification test for the selected hypothesis.
5. Use AI as an adversarial reviewer that challenges claims; it cannot approve them.
6. Replay mitigation controls against the recorded sequence and retain a reproducible result.
7. Expose missing trace context, healthy baselines, changes, and recovery signals that limit confidence.

## Operating Context

- Continuous incident intake through signed GitHub, OpenTelemetry HTTP/JSON, Grafana, and generic webhook connectors, with manual evidence reserved for human observations.
- Protected dashboard for service health, active incidents, activity, and replay state.
- Workbench with timeline events, causal relationships, evidence, notes, and hypotheses.
- Semantic search and an assistant grounded in selected and historical incident evidence.
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
- Counterfactual mitigation replay with repeatable inputs and clearly labeled synthetic projections.
- Supabase-backed durable intake jobs with retry backoff, dead-letter review, and operator replay.
- Service ownership/dependency context plus configurable grouping, threshold, suppression, and maintenance policies.
- Team roles, expiring invite links, immutable workspace audit entries, and independent mitigation approval.
- Evidence-level AI citations and secret/PII redaction before provider-assisted analysis.
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
- Replay: deterministic simulation over stored events, not execution against customer infrastructure.
- Integrations: receivers are intentionally push-based so they run on the existing free API service without polling workers or paid queues.
- Surface mode: Operate.
