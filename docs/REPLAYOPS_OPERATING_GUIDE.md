# ReplayOps operating guide and code map

This guide describes the current product after the 40-item production-debugging redesign. It deliberately separates what ReplayOps observes, infers, estimates, executes, and verifies.

## The responder workflow

1. **Open or receive an investigation.** A signed source delivery can create or enrich one automatically. Quick intake also accepts an alert or trace URL and records it as source evidence.
2. **Orient in one screen.** Confirm customer symptom/impact, service, environment, owner, evidence freshness, current explanation, unknowns, and the one useful next action.
3. **Inspect evidence.** The elapsed-time timeline and evidence inspector share the same selected event. Correct or exclude evidence without destroying provenance; grouping corrections can be undone.
4. **Compare and question.** Healthy/failing cohorts, recent changes, measured impact, historical investigations, and missing-evidence guidance state both findings and limitations.
5. **Run a falsification test.** Assign a test, record its query/trace/metric result, and mark it supported, disproved, or inconclusive. Diagnosis and next action recalculate immediately; contradictory outcomes become contested.
6. **Validate a candidate.** Use an explicitly labeled scenario estimate for transparent arithmetic, or capture a bounded HTTP request and execute it against an isolated loopback candidate build.
7. **Review the actual change.** The approval snapshot includes current/proposed values, blast radius, owner, rollback, observation time, evidence revision, and team policy. New evidence makes it stale.
8. **Verify recovery.** Record a real metric with unit, healthy direction, baseline, target, observed value, source, query, interval, and observed time. The server derives pass/fail/freshness. Resolution uses the newest result.
9. **Hand off and prevent recurrence.** Produce a source-linked handoff, evidence-linked comments, structured learning record, and a portable HTTP replay manifest for CI.

## Feature-to-code map

| Product capability | Frontend | Backend / data |
|---|---|---|
| Investigation inbox and quick intake | `apps/web/src/pages/DashboardPage.tsx`, `IncidentEditor.tsx` | `apps/api/src/routes.ts`, `repository.ts` |
| Views, filters, ownership, lifecycle | `apps/web/src/pages/IncidentsPage.tsx`, `IncidentWorkbenchPage.tsx` | incident routes and repository membership scoping |
| Time-zone-safe timeline and evidence inspector | `apps/web/src/components/CausalTrace.tsx`, `TimeZoneProvider.tsx` | versioned event schema in `types.ts` / `repository.ts` |
| Explanations and hypothesis tests | `apps/web/src/components/ResponseConsole.tsx` | `apps/api/src/diagnosis.ts`, `workspace.ts` |
| Cohorts, changes, impact, historical comparison, queries | `apps/web/src/components/DebuggingInsights.tsx` | `apps/api/src/intelligence.ts`, `ingestion.ts` |
| Contextual AI, citations, redaction | `ResponseConsole.tsx`, workspace privacy controls | `apps/api/src/ai.ts`, assistant/search routes |
| Scenario estimates and approval review | `ResponseConsole.tsx` | repository replay plus workspace mitigation policy |
| Executable HTTP replay and CI manifest | `ResponseConsole.tsx` | `apps/api/src/httpReplay.ts`, `scripts/replay-http.mjs` |
| Server-derived recovery | `ResponseConsole.tsx` | recovery schema/routes in `routes.ts` and `workspace.ts` |
| Handoff, learning record, comments, issue draft | `ResponseConsole.tsx` | postmortem/comment routes in `workspace.ts` |
| Source setup, staged diagnostics, budgets | `apps/web/src/pages/IntegrationsPage.tsx` | `ingestion.ts`, `repository.ts`, queue in `workspace.ts` |
| Catalog, grouping policy, privacy, roles, audit | `apps/web/src/pages/WorkspacePage.tsx` | policy/member/audit/privacy services in `workspace.ts` |
| Durable schema | — | `apps/api/db/schema.sql` |

## Truth labels

- **Observed fact:** retained source or human observation with provenance.
- **Inferred explanation:** a ranked, testable claim—not root cause.
- **Scenario estimate:** arithmetic over declared controls and assumptions; it does not execute traffic.
- **Replay execution:** a real bounded HTTP request against the configured isolated loopback target.
- **Recovery verification:** a server-derived result from a sourced, fresh observation window.

## AI behavior

ReplayOps works without an AI key. Deterministic analysis still provides evidence summaries, exact search, explanation ordering, gaps, and next tests. When Google AI Studio or an OpenAI-compatible provider is enabled, external assistance remains incident-scoped. Secrets, credentials, emails, IPs, request bodies (unless explicitly enabled), and sensitive metadata are redacted before chat and embedding calls. Responses cite exact incident events and cannot approve, resolve, or execute changes.

## Failure behavior

- Missing telemetry is shown as a gap, never filled with fabricated values.
- Stale telemetry remains visible with freshness warnings.
- A disproved explanation is demoted; contradictory outcomes are preserved.
- Drafts survive tab changes and refresh; consequential mutations retain form input on failure.
- Failed source jobs retry with backoff, enter dead-letter review, and retain the original delivery ID.
- New evidence invalidates stale replay/approval snapshots.
- A fresh recovery failure prevents resolution even if an older observation passed.
- Unsupported replay input produces an `unsupported` result with a reason.

## Free local trial

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`, choose the synthetic workspace, open `ROP-1842`, assign the suggested test, record a result, then use **Validate & recover** and **Handoff**. The demo is synthetic and does not count as a real connector receipt.

For production-like setup, configure Supabase and a signed source from the README. Add `GOOGLE_AI_API_KEY` only if external AI is desired. For replay CI, follow `docs/HTTP_REPLAY.md`.
