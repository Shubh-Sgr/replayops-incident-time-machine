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

Normal deployments and low-impact metrics remain in a 30-minute evidence buffer. An alert or signal at the incident threshold automatically creates an incident, backfills matching precursor evidence, and updates diagnosis as later evidence arrives. Provider retries are idempotent.

No paid queue or connector platform is required. The receiver runs inside the existing Render API, and connector metadata is stored in the existing Supabase PostgreSQL database.

Every authenticated delivery is now persisted to a Supabase-backed `ingestion_queue` before normalization. Temporary failures use exponential backoff, five failed attempts enter dead-letter review, and operators can retry jobs from **Workspace → Delivery queue**. Connector setup is a three-stage source/configure/verify flow with delivery freshness and latest-outcome health.

## Real-user controls

- **Service map:** records owner, criticality, repository, runbook, and dependencies for architecture-aware grouping.
- **Intake policy:** configures incident threshold, grouping window, low-severity suppression, and maintenance mode.
- **Team access:** admin, responder, and viewer roles are enforced at the API; admins can email expiring, email-bound invitation links with a copy-link fallback.
- **Audit trail:** successful mutations and governed actions retain actor, target, detail, and timestamp.
- **Grounded AI:** chat and embedding input are redacted before provider calls; responses expose incident/event citations, evidence boundary, model mode, and unknowns.
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
