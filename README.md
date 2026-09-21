# ReplayOps

ReplayOps is a production-incident time machine. It reconstructs operational evidence into a causal timeline, ranks competing root-cause hypotheses, exposes what evidence is missing, proposes the next safe falsification test, and replays a candidate mitigation against the recorded sequence.

It can populate that workbench automatically: signed GitHub webhooks, OTLP HTTP/JSON traces, logs and metrics, Grafana alerts, and normalized generic webhooks are verified, deduplicated, buffered, correlated, and attached to incidents without manual copying.

Its differentiated workflow is the diagnostic proof loop: precursor → symptom → propagation → falsification test → mitigation replay. AI is used to challenge a hypothesis with disconfirming evidence, never to silently declare root cause.

The included workspace is production-configurable and also runs without cloud credentials using a synthetic in-memory organization.

For an end-to-end explanation of the architecture, feature flows, engineering decisions, API routes, database model, and user guide, see [`CODE_WALKTHROUGH.md`](CODE_WALKTHROUGH.md). For a plain-language explanation of every current and planned product capability, see [`FEATURE_GUIDE.md`](FEATURE_GUIDE.md).

## Architecture

- `apps/web`: React, Vite, TypeScript, Tailwind CSS, Framer Motion, TanStack Query, Supabase Auth.
- `apps/api`: Express 5, TypeScript, PostgreSQL/pgvector, optional OpenAI-compatible embeddings and chat.
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
- **Team access:** admin, responder, and viewer roles are enforced at the API; admins can create expiring email-bound invite links.
- **Audit trail:** successful mutations and governed actions retain actor, target, detail, and timestamp.
- **Grounded AI:** assistant context is redacted before provider calls and responses expose incident/event citations, evidence boundary, model mode, and confidence.
- **Mitigation approval:** responders submit an exact action plus rollback plan; a separate administrator approves or rejects it. ReplayOps does not execute infrastructure commands.

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

## AI and semantic search

Set `OPENAI_API_KEY` to enable embeddings and provider-assisted answers. `OPENAI_BASE_URL`, model names, and embedding model are configurable, so an OpenAI-compatible provider can be substituted.

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

The included replay engine is a safe deterministic demonstration over stored incident events. It does not execute commands against production infrastructure. Connecting an external executor should require an isolated worker, signed replay manifests, scoped credentials, approval policies, and a complete audit trail.
