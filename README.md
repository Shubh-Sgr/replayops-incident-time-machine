# ReplayOps

ReplayOps is a production-incident time machine. It turns operational evidence into a reviewable investigation: measure impact, inspect provenance, compare healthy and failing requests, falsify competing explanations, validate a bounded candidate fix, verify actual recovery, and preserve the failure as a CI regression.

It can populate that workbench automatically: signed GitHub webhooks, OTLP HTTP/JSON traces, logs and metrics, Grafana alerts, and normalized generic webhooks are verified, deduplicated, buffered, correlated, and attached to incidents without manual copying.

Its differentiated workflow is: symptom → evidence → explanation → falsification test → bounded validation → measured recovery → regression test. AI is contextual, redacted, cited, and never allowed to silently declare root cause or approve a change.

The included workspace is production-configurable and also runs without cloud credentials using a synthetic in-memory organization.

For the current product contract, start with [`docs/REPLAYOPS_FINAL_FLOW_SPEC_2026-09-27.md`](docs/REPLAYOPS_FINAL_FLOW_SPEC_2026-09-27.md), the [`final implementation report`](docs/REPLAYOPS_FINAL_IMPLEMENTATION_REPORT_2026-09-27.md), and the [`feature decision ledger`](docs/REPLAYOPS_FEATURE_DECISION_LEDGER_2026-09-27.md). For an end-to-end explanation of the architecture, feature flows, engineering decisions, API routes, database model, and user guide, see [`CODE_WALKTHROUGH.md`](CODE_WALKTHROUGH.md). A focused answer to how OTLP, normalization, incident lifecycle, queueing, hypotheses, historical comparisons, approvals, and bounded HTTP replay work is in [`docs/REPLAYOPS_SYSTEM_WALKTHROUGH.md`](docs/REPLAYOPS_SYSTEM_WALKTHROUGH.md). The bounded replay/CI contract is in [`docs/HTTP_REPLAY.md`](docs/HTTP_REPLAY.md); and the earlier auditable 40-item delivery ledger remains in [`docs/REPLAYOPS_IMPLEMENTATION_CHECKLIST.md`](docs/REPLAYOPS_IMPLEMENTATION_CHECKLIST.md).

## Architecture

- `apps/web`: React, Vite, TypeScript, Tailwind CSS, Framer Motion, TanStack Query, Supabase Auth.
- `apps/api`: Express 5, TypeScript, PostgreSQL/pgvector, optional Google Gemini or OpenAI-compatible embeddings and chat.
- `apps/api/db`: Supabase-compatible schema, vector index, row-level security, and seed SQL.
- `.github/workflows/deploy.yml`: verification plus optional Vercel and Render deployments.

## Automated evidence ingestion

Open **Connectors** in the application and create one of three free receivers:

- **GitHub:** verifies `X-Hub-Signature-256` and normalizes deployments, deployment statuses, workflow runs, and pushes.
- **OpenTelemetry:** accepts OTLP HTTP/JSON at `/v1/traces`, `/v1/logs`, and `/v1/metrics`, retaining incident-shaped signals and trace context.
- **Generic/Grafana:** accepts a small normalized JSON contract or Grafana's standard alert webhook payload.

### Change events from any tool

Most incidents follow a change. Besides GitHub, any CI/CD step, flag tool, or script can record one through a **Generic** connector, and it becomes a ranked suspect when an incident opens nearby:

```bash
curl -X POST "$REPLAYOPS_ENDPOINT" -H "Authorization: Bearer $REPLAYOPS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"change","changeType":"deploy","service":"checkout-api","environment":"production","version":"v1.4.2","previousVersion":"v1.4.1","sha":"abc1234"}'
```

`changeType` is one of `deploy`, `feature_flag` (with `flag`, `from`, `to`), `config` (with `key`, `previousValue`, `newValue`), `migration`, `infra`, or `rollback`. The diagnosis tailors its advice: flip the flag back, restore the setting, or roll back to `previousVersion`.

The public receiver is rate limited per connector (`INGEST_RATE_LIMIT_PER_MINUTE`, default 300) and per client address (`INGEST_RATE_LIMIT_PER_IP_PER_MINUTE`, default 600), and answers `429` with `Retry-After`.

Normal deployments and low-impact metrics remain in a 30-minute evidence buffer. An alert or signal at the incident threshold automatically creates an incident, backfills matching precursor evidence, and updates diagnosis as later evidence arrives. Provider retries are idempotent.

No paid queue or connector platform is required. The receiver runs inside the existing Render API, and connector metadata is stored in the existing Supabase PostgreSQL database.

Every authenticated delivery is now persisted to a Supabase-backed `ingestion_queue` before normalization. Temporary failures use exponential backoff, five failed attempts enter dead-letter review, and operators can retry jobs from **Workspace → Delivery queue**. Connector setup is a three-stage source/configure/verify flow with delivery freshness and latest-outcome health.

## Real-user controls

- **Alerts:** Settings → Alerts notifies you when an incident opens, moves to monitoring, resolves, or reopens. Destinations: **email** (through the API's Resend account; free tier 100/day, needs `RESEND_API_KEY` and `INVITE_FROM_EMAIL`), **phone push** via the free [ntfy](https://ntfy.sh) app (critical incidents arrive as urgent), Discord, Slack, or any HTTPS webhook. Each destination has event and minimum-severity filters and a send-test button. Webhook bodies are signed (`x-replayops-signature: sha256=HMAC(secret, body)`). Webhook-style destinations must be public HTTPS hosts, and DNS is re-checked at send time.
- **Errors:** exceptions from OpenTelemetry (`exception.*` span events and log attributes) or generic JSON (`"error": {"type", "message", "stack"}`) are fingerprinted by type and first application stack frame, ignoring line numbers and per-request values. Each incident lists its error groups with counts, and flags errors that **never happened before a recent change**. That change then ranks higher as a suspect.
- **Workspaces:** one account can belong to several workspaces (for example, by accepting an invitation) and switch between them from the sidebar, or create a new empty one. Every request is scoped to the active workspace only.
- **API tokens and CLI:** admins create workspace tokens in Settings → API tokens (viewer or responder; never admin, optional expiry; only a hash is stored). Tokens can read everything and update incidents, evidence, checks, comments, and lifecycle, but not connectors, team, alerts, or settings. The `replayops` CLI uses them:

  ```bash
  export REPLAYOPS_API=https://replayops-incident-api.onrender.com REPLAYOPS_TOKEN=rpo_…
  npm run replayops -- incidents              # open incidents with their next step
  npm run replayops -- show AUTO-1234         # facts, leading explanation, errors, latest evidence
  npm run replayops -- note AUTO-1234 "Rolled back canary"
  npm run replayops -- status AUTO-1234 monitoring --reason "Rolled back to v1.4.1"
  npm run replayops -- change --service checkout-api --version v1.4.2 --previous v1.4.1   # needs a Generic connector URL/token
  ```
- **Destructive actions:** only admins can delete an incident or a connector; the audit entry keeps the code, title, and evidence count of what was removed.
- **Request bodies:** unless an admin enables *Capture request bodies*, body/payload fields are stripped from incoming telemetry, replays cannot include a body, and replay response bodies are not stored.
- **Service map:** records owner, criticality, repository, runbook, and dependencies for architecture-aware grouping.
- **Intake policy:** configures incident threshold, grouping window, low-severity suppression, and maintenance mode.
- **Team access:** admin, responder, and viewer roles are enforced at the API; admins can email expiring, email-bound invitation links with a copy-link fallback.
- **Audit trail:** successful mutations and governed actions retain actor, target, detail, and timestamp.
- **Grounded AI:** chat and embedding input are redacted before provider calls; automatically opened incidents are embedded too, so similar-incident search finds them; responses expose incident/event citations, evidence boundary, model mode, and unknowns.
- **Hypothesis tests:** responders assign a falsification test, record the observation, and mark it supported, disproved, or inconclusive.
- **Scenario estimates:** transparent arithmetic is saved against an evidence revision and never labeled as execution or predicted recovery.
- **Bounded HTTP replay:** immutable request/version/assertions/fixtures execute only against a loopback candidate target, run twice for nondeterminism, and can be downloaded as a CI manifest.
- **Mitigation approval:** responders submit an exact replay-bound action plus rollback plan; a separate administrator approves or rejects it, and new evidence makes the request stale. ReplayOps does not execute infrastructure commands.
- **Recovery gate:** the API derives recovery from metric direction, unit, source, query, interval, and freshness; the newest failure overrides an older pass.
- **Learning loop:** generated handoffs and editable postmortems preserve evidence, tests, replay, recovery, and follow-up ownership.

## Run locally

Requirements: Node.js 20 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173` and choose **Explore the synthetic workspace**. The frontend uses `http://localhost:8787/api` by default.

In demo mode, sign in with either local persona (password `ReplayOps!2026`): `operator@replayops.dev` requests changes and `reviewer@replayops.dev` independently approves them.

## Debugging ReplayOps itself

- **Request IDs:** every API response carries an `x-request-id` header (a safe caller-supplied value is reused). Error bodies include `requestId`, and UI error messages end with `(HTTP <status> · request <id>)`, so a message on screen maps directly to an API log line.
- **Request log:** the API logs one line per request: `METHOD /path STATUS 1.2ms req=<id>`. Stack traces are printed only for genuine 5xx faults, prefixed with the same request ID.
- **Accurate status codes:** malformed JSON returns 400, missing records 404, permission failures 403, and stale-evidence or workflow conflicts 409. Validation failures list each invalid field instead of a generic error.
- **Smoke test:** with `npm run dev` running, `npm run smoke` walks ingestion, incident CRUD, search, the full check → proposal → validation → independent review → recovery → monitoring → resolve journey, and error handling against the demo API, then cleans up. Set `API=http://host:port` to target another demo-mode instance.
- **Port conflicts:** the API reads `PORT` (default 8787). If your shell or tooling exports `PORT` for the web server, start with `PORT=8787 npm run dev` so the API does not bind the Vite port.

## How an investigation works

Each incident page has three tabs that follow the order you'd work in:

1. **Investigate.** ReplayOps proposes the most likely explanation from the evidence and a *recommended next check*: one concrete thing to look at, such as a log, a commit diff, or a trace. Click **Start this check**, write what you saw, and mark it **Confirms it**, **Rules it out**, or **Unclear**. The explanation and next step update from your answers, and every result is kept under **Already checked**.
2. **Fix & verify.** Guided steps with a "What to do now" line at the top:
   - *Record the fix* (optional): the exact change, how to undo it, and how it was tested. A recorded fix needs a teammate's approval before resolving.
   - *Confirm it's fixed*: for GitHub incidents this happens automatically when a later deploy or run succeeds. For runtime incidents, pick one number (for example error rate ≤ 1%) and record readings after the fix is live.
   - *Resolve*: start monitoring, then resolve once recovery is confirmed.
3. **Activity & handoff.** A generated summary of what was known, checked, ruled out, changed, and confirmed, plus the learning record.

## Debugging an incident in ReplayOps

- **Healthy vs failing requests:** slow OTLP spans (≥ 2 s) count toward the failing cohort alongside errors, so latency incidents get a real comparison against sampled healthy spans from the same service, route, method, and region. The healthy sample rate set on each source (**Sources → Retention, sampling, and quota**) is applied during ingestion.
- **Ready-to-run queries:** each investigation generates copyable trace, error-log, exemplar-trace, and recent-change queries covering every affected service. An unknown environment is left out of the query instead of being matched literally.
- **Next action that advances:** after a test supports the leading explanation, the next action moves to validating a bounded fix; an inconclusive result proposes a different test instead of repeating the same one.
- **Incident-scoped assistant:** the workbench assistant only sees the selected incident, answers each button (explain, challenge, next test, what changed) differently, and cites events by name. Without an AI key, answers are built from the same diagnosis the workbench shows.

## Configure Supabase

1. Create a free Supabase project.
2. Run [`apps/api/db/schema.sql`](apps/api/db/schema.sql) in the SQL editor before enabling sign-ups. It installs pgvector, row-level security, and the trigger that provisions one private workspace for every new user.
3. Optionally run [`apps/api/db/seed.sql`](apps/api/db/seed.sql).
4. Enable email/password and GitHub providers in Supabase Authentication.
5. Add the frontend URL to Supabase redirect URLs.
6. Copy the project URL and keys into the environment variables shown in `.env.example`.

For the backend, use a direct or pooled PostgreSQL connection string that supports pgvector. Set `ENABLE_DEMO_MODE=false` in public production environments.

### Invitation email delivery

ReplayOps uses Resend's HTTP API for transactional invitation email. The core invitation flow remains usable without an email provider: the administrator receives a secure copyable link and the interface explicitly labels it as link-only delivery.

To enable outbound email on Render:

- Create a Resend account and verify a sending domain.
- Set `RESEND_API_KEY` to a send-enabled API key.
- Set `INVITE_FROM_EMAIL` to a sender on the verified domain, such as `ReplayOps <invites@example.com>`.
- Set `PUBLIC_WEB_URL` to the production Vercel URL so emailed links point to the correct application.

Each provider request uses the invitation ID as an idempotency key. ReplayOps records whether the provider accepted the email, failed, or was not configured; failed delivery never destroys the valid manual invitation link.

## AI and semantic search

Set `GOOGLE_AI_API_KEY` to enable Gemini embeddings and provider-assisted answers through Google AI Studio. The server defaults are `gemini-3.8-flash` for chat and `gemini-embedding-2` for embeddings. `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and compatible model settings remain available as an alternative provider path.

Without an AI key:

- Search falls back to PostgreSQL full-text search or deterministic in-memory matching.
- The assistant and adversarial hypothesis review return explicitly labeled deterministic evidence analysis.
- Incident, timeline, replay, and dashboard workflows continue functioning.

## Free deployment

### Frontend — Vercel

Import the repository into Vercel. The root `vercel.json` builds `apps/web`. Configure:

- `VITE_API_URL=https://<your-render-service>/api`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ENABLE_DEMO_MODE=false`

### Backend — Render

Create a Render **Web Service** from the repository using the root `Dockerfile`, then provide the environment variables from `.env.example`. Set `WEB_ORIGIN` to the Vercel URL. The Docker health check is `/health`. `render.yaml` remains available as an optional reference, but it is not required.

The current free tiers are suitable for a portfolio, evaluation, or hobby deployment—not an always-on production SLA. Render free web services sleep after 15 minutes without inbound traffic and can take about a minute to wake. Supabase free projects have usage limits and can pause after a week of inactivity. Vercel Hobby is intended for personal, non-commercial projects. Review provider terms before commercial use.

### Automated deployment

Add these GitHub repository secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `RENDER_DEPLOY_HOOK`

Pushes to `main` verify, build, and deploy services for which secrets are present. Pull requests only run verification.

## Schema migrations

New schema changes live in `apps/api/db/migrations/NNN_name.sql`. On startup the API applies any file it has not run yet, in name order, in one transaction under an advisory lock, and records each in `replayops_schema_migrations` with a checksum. Files that existed before the runner (002–006 and `20260925_*`) are recorded as a baseline on first run instead of being executed again. Never edit a migration after it has run; add a new one.

## Production controls

- Supabase JWT validation on API routes
- Row-level security policies in the database
- Automatic per-user workspace provisioning
- Organization-membership scoping on every PostgreSQL read, write, delete, and vector search
- No service-role key in the application runtime
- Input validation with Zod
- Optimistic UI rollback
- Provider-optional AI degradation
- Human-confirmation language for consequential actions
- Health endpoint and Docker non-root user
- Responsive, keyboard-accessible interface with reduced-motion support

## Important limitation

ReplayOps now separates scenario estimates from executable validation. The bounded HTTP replay records a request, application version, explicit assertions, declared dependency fixtures, evidence revision, output, and execution history. Execution is loopback-only and intended for an isolated local or CI environment without production credentials. See `docs/HTTP_REPLAY.md` for the safety boundary and CI command.
