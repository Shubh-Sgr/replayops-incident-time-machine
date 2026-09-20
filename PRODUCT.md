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

ReplayOps is an incident time machine, not another monitoring dashboard: it transforms telemetry into an ordered causal graph and lets operators evaluate candidate remediation against it.

## Operating Context

- Incident intake from manually created records and future telemetry connectors.
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
- Initial telemetry: normalized CRUD and seed events rather than a live collector.
- Replay: deterministic simulation over stored events, not execution against customer infrastructure.
- Surface mode: Operate.
