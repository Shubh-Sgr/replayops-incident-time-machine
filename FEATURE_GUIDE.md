# ReplayOps Feature Guide

This guide explains ReplayOps from a user and product perspective. It describes what every major feature does, why an incident responder needs it, how it behaves in practice, and what remains before the feature is ready for dependable use by real engineering teams.

## 1. What problem ReplayOps solves

During a production incident, evidence is usually scattered across monitoring dashboards, deployment histories, traces, logs, chat messages, and engineers' memory. Teams often know that something is broken before they know:

- what changed first;
- which symptom is the cause and which is only an effect;
- which evidence supports the current theory;
- what evidence could disprove it; or
- whether a proposed mitigation would interrupt the failure sequence.

ReplayOps turns those disconnected signals into a replayable investigation. Its job is not to replace Datadog, Grafana, GitHub, OpenTelemetry, or an incident-management product. Those systems continue to collect telemetry and coordinate responders. ReplayOps consumes their evidence and helps the engineer build and test a defensible causal explanation.

The core workflow is:

```text
collect evidence -> reconstruct time -> rank hypotheses -> try to disprove them
                 -> test a reversible mitigation -> preserve the decision trail
```

## 2. Who uses it

### On-call engineer

Uses ReplayOps to understand what changed, where the failure started, and what safe test should be run next.

### Site reliability engineer

Connects telemetry, tunes grouping rules, reviews repeated incidents, and improves the team's diagnostic process.

### Incident commander

Tracks the active hypothesis, confidence gaps, decisions, owners, and mitigation state without reading every raw log.

### Engineering manager

Uses the evidence and decision history after an incident to identify recurring system risks and improve runbooks.

## 3. Feature status definitions

- **Live:** implemented and available in the deployed application.
- **Live with limitation:** usable now, but missing a production control or external configuration.
- **Planned:** valuable for real users but not implemented yet.
- **Safety-gated:** intentionally limited until stronger approvals and auditing exist.

---

## 4. Features available today

### 4.1 Account authentication and private workspaces

**Status:** Live

**Problem it solves:** Incident data can contain internal service names, failure details, and operational decisions. It must not be mixed between unrelated users.

**How it works:** A user signs up or signs in through Supabase Authentication. The database provisions a private workspace and the API scopes reads and writes to an organization membership. Protected pages require a valid session.

**Example:** Priya signs in and sees only her organization's incidents and connectors. Another user cannot retrieve Priya's incident by guessing its identifier.

**Why it matters:** Authentication is not merely a login screen; it is the boundary that protects operational evidence.

**Current limitation:** Invitation email requires a configured Resend key and verified sender domain. Without those settings, ReplayOps clearly falls back to a copyable link. The newest joined workspace is selected automatically because a workspace switcher is not yet included.

### 4.2 Operations dashboard

**Status:** Live

**Problem it solves:** Responders need a quick operational summary before opening individual investigations.

**How it works:** The dashboard summarizes incident activity, recent events, service signals, and the latest operational changes.

**Example:** An engineer starting an on-call shift can immediately see that checkout has an active high-severity incident and that recent event volume is elevated.

**Why it matters:** It provides orientation, but it is deliberately not intended to become another raw monitoring dashboard.

### 4.3 Incident ledger

**Status:** Live

**Problem it solves:** Incident investigations become difficult to find and compare when they exist only in chat channels or monitoring links.

**How it works:** The ledger lists incidents with a stable record number, severity, status, owner, service, and update time. Users can filter, open, edit, create, or remove records.

**Example:** A responder filters for investigating incidents owned by the payments team and opens the newest checkout failure.

**Why it matters:** A stable incident record becomes the container for evidence, hypotheses, decisions, and replay results.

### 4.4 Automatic evidence ingestion

**Status:** Live with limitation

**Problem it solves:** Manually copying every deployment, trace, alert, and log into an incident wastes time and produces incomplete investigations.

**How it works:** ReplayOps exposes receivers for:

- GitHub deployment, workflow, and push webhooks;
- OpenTelemetry HTTP/JSON traces, logs, and metrics;
- Grafana alert webhooks; and
- normalized JSON from another monitoring system.

Incoming deliveries are authenticated, normalized into one evidence model, and deduplicated using provider delivery identifiers.

**Example:** GitHub reports a failed production deployment. Minutes later, Grafana reports a checkout error-rate breach. ReplayOps converts both payloads into comparable evidence records.

**Why it matters:** The incident becomes evidence-led without requiring an engineer to perform data entry during an outage.

**Current limitation:** The production receiver is working, but a real GitHub repository, Grafana contact point, or OpenTelemetry collector still needs to be configured to send continuous data.

### 4.5 Signed connector security

**Status:** Live

**Problem it solves:** A public webhook endpoint could otherwise be used to create fake incidents or flood a workspace.

**How it works:** GitHub requests are checked using their SHA-256 webhook signature. Generic and OpenTelemetry sources use a generated connector token. Connector credentials are derived on the server and are not committed to the repository.

**Example:** A request sent to the correct receiver URL without the corresponding connector token is rejected rather than becoming evidence.

**Why it matters:** An incident tool must distinguish trusted telemetry from untrusted internet traffic.

### 4.6 Evidence buffer and precursor backfill

**Status:** Live

**Problem it solves:** A deployment may look harmless when it happens, but become highly relevant when an alert fires ten minutes later.

**How it works:** Ordinary changes and low-impact signals remain in a short evidence buffer. When a related high-impact signal opens an incident, ReplayOps attaches matching earlier evidence using service, trace, release, and correlation identifiers.

**Example:** A catalog release is stored without opening an incident. Twelve minutes later, failed traces with the same release identifier cross the threshold. The release is backfilled as a possible precursor.

**Why it matters:** The system preserves causally useful context without creating an incident for every normal deployment.

### 4.7 Threshold-based automatic incident creation

**Status:** Live

**Problem it solves:** A useful incident tool should begin an investigation when serious telemetry arrives, rather than waiting for someone to create a blank record manually.

**How it works:** Normalized signals carry an impact score. Incident-shaped signals at or above the threshold create an `AUTO-...` incident. Later correlated evidence enriches the same investigation.

**Example:** A high-impact checkout alert creates an incident owned by Automation and attaches the alert as the first evidence event.

**Why it matters:** The responder opens an investigation that already contains context instead of beginning with an empty form.

**Current limitation:** Threshold, grouping window, low-severity suppression, and maintenance mode are workspace-wide. Per-service schedules and rules remain future work.

### 4.8 Causal incident reconstruction

**Status:** Live

**Problem it solves:** Conventional timelines show chronological order but do not help the responder reason about propagation.

**How it works:** ReplayOps orders events, highlights the selected point in time, and shows service, event type, impact, and recorded detail. Responders can move through the sequence one event at a time.

**Example:** The engineer moves from deployment to latency increase to retry storm to customer-facing error and can see how the failure developed.

**Why it matters:** Time ordering is the foundation for causal reasoning, while still avoiding the claim that sequence alone proves causation.

### 4.9 Diagnostic proof loop

**Status:** Live

**Problem it solves:** Teams often settle on the first plausible explanation and then search only for confirming evidence.

**How it works:** ReplayOps produces a structured investigation containing:

- a likely propagation origin;
- competing hypotheses;
- evidence supporting each hypothesis;
- observations that could disprove it;
- confidence blockers; and
- the next reversible falsification test.

**Example:** A failed deployment is the leading candidate, but ReplayOps points out that no trace connects it to affected requests and recommends comparing failing and healthy release cohorts.

**Why it matters:** The feature reduces confirmation bias and turns “we think this caused it” into a testable engineering statement.

### 4.10 Competing hypothesis ranking

**Status:** Live

**Problem it solves:** Multiple changes may occur near the start of an incident, and the loudest alert is not necessarily the cause.

**How it works:** Candidates are ranked using event order, signal change, impact, and propagation context. Confidence is intentionally capped when evidence is incomplete.

**Example:** A database configuration change may rank above an application error because it occurred first and affected several dependent services.

**Why it matters:** Responders can compare theories instead of allowing one unverified theory to dominate the incident.

### 4.11 Confidence blockers

**Status:** Live

**Problem it solves:** A confidence score is misleading if the user cannot see why confidence is low.

**How it works:** ReplayOps explicitly lists missing evidence, such as absent trace IDs, no healthy baseline, no deployment record, too few events, or no recovery signal.

**Example:** The system reports 43% evidence coverage and explains that cross-service causality cannot be verified because no request or trace identifier is present.

**Why it matters:** The user learns what data to collect next instead of treating a score as unexplained AI certainty.

### 4.12 Failure-window comparison

**Status:** Live

**Problem it solves:** Engineers need to know what became unusually common after the first major symptom.

**How it works:** ReplayOps compares pre-symptom and failure windows and highlights overrepresented services and evidence types.

**Example:** Checkout errors and inventory timeouts rise sharply after a release while authentication traffic remains normal.

**Why it matters:** Differences between healthy and failing periods are generally more useful than isolated absolute values.

### 4.13 Reversible falsification test

**Status:** Live

**Problem it solves:** An investigation stalls when a hypothesis has no concrete next action.

**How it works:** For the selected hypothesis, ReplayOps proposes a bounded test designed to produce different outcomes depending on whether the hypothesis is correct.

**Example:** Route a small percentage of traffic to the previous release and compare error rates for the same endpoint and region.

**Why it matters:** The goal is not to produce a persuasive explanation. It is to help the engineer safely determine whether that explanation survives testing.

### 4.14 Counterfactual mitigation replay

**Status:** Safety-gated

**Problem it solves:** A mitigation can remove one symptom while leaving the recorded propagation path intact.

**How it works:** The current engine deterministically projects a selected mitigation over stored incident evidence and records the replay inputs and output. It does not execute commands against production.

**Example:** ReplayOps estimates whether limiting checkout concurrency would have interrupted the retry amplification seen in the recorded timeline.

**Why it matters:** Responders can reason about a mitigation before touching live infrastructure.

**Current limitation:** The approval workflow, separation of duties, and audit record are live, but this remains a simulation rather than a production executor. Real execution still requires isolated workers, scoped credentials, policy checks, and automatic health-based rollback.

### 4.15 Decision and handoff record

**Status:** Live

**Problem it solves:** Shift changes and multi-team incidents lose context when decisions are kept only in ephemeral chat.

**How it works:** Decisions stay attached to the incident so responders can review what was considered, what changed, and why.

**Example:** The incoming responder can see why rollback was deferred and which observation would cause the team to reconsider it.

**Why it matters:** A concise decision history prevents repeated investigation and unsafe contradictory actions.

### 4.16 Evidence search and assistant

**Status:** Live with limitation

**Problem it solves:** Engineers need to find similar incidents and relevant evidence without remembering exact record numbers or phrases.

**How it works:** Search uses PostgreSQL text matching by default and can use embeddings when an AI provider is configured. The assistant answers from incident evidence and retains a deterministic fallback when no AI key is available.

**Example:** A user searches for “retry storm after inventory release” and retrieves incidents containing related services, changes, and failure patterns.

**Why it matters:** Historical incidents become operational memory rather than archived documents.

**Current limitation:** Citations, evidence boundaries, and redaction are live. Provider mode still requires a user-supplied compatible API key, and a broader evaluation suite is needed before treating generated answers as production-grade.

### 4.17 Responsive interface, themes, and operational states

**Status:** Live

**Problem it solves:** Incident responders may use a laptop, tablet, or phone and often work in low-light conditions.

**How it works:** The interface adapts across screen sizes, supports light and dark themes, and includes loading, empty, success, and failure states.

**Example:** An incident commander can review the active hypothesis and handoff from a phone without navigating a desktop-only table.

---

## 5. Features required for real-user adoption

### 5.1 Guided connector setup

**Status:** Live

**User problem:** The receiver may be technically correct, but a new user can still fail to configure GitHub, Grafana, or OpenTelemetry.

**What is live:**

1. Choose the source product.
2. Follow source-specific steps with copy-ready values.
3. Send or detect a sample delivery.
4. Validate authentication and payload shape.
5. Show the first normalized evidence record.
6. Mark the connector healthy only after successful verification.

**Example:** A GitHub user selects a repository, copies the generated secret, installs the webhook, and sees “verified five seconds ago” after GitHub sends its ping event.

**Value:** This creates the shortest path from signup to genuine product value.

**Can it be free?** Yes. The implemented wizard uses existing provider webhook APIs and the current free services.

### 5.2 Durable queue, retries, and dead-letter handling

**Status:** Live

**User problem:** A transient processing failure must not permanently lose the only copy of an operational event.

**What is live:** ReplayOps persists the normalized delivery before processing, uses a short worker lease, retries temporary failures with exponential backoff, moves five-time failures into a visible dead-letter state, and lets a responder retry them.

**Example:** The database is briefly unavailable when a Grafana alert arrives. The delivery remains queued and is successfully processed after the database recovers.

**Value:** This changes ingestion from “best effort” into an auditable, recoverable pipeline.

**Can it be free?** Yes for a low-volume beta using the existing Supabase PostgreSQL database and a polling worker in the Render API. High-volume or strict-SLA workloads eventually require dedicated always-on workers.

### 5.3 Connector health center

**Status:** Live with limitation

**User problem:** Users cannot trust automation if they do not know whether a source has silently stopped sending data.

**What is live:** Each connector shows setup progress, last delivery time, latest outcome, signal count, a synthetic end-to-end test, and one of four health states: awaiting verification, healthy, stale, or needs attention.

**Example:** The OpenTelemetry connector changes from healthy to stale after receiving no spans for 20 minutes and tells the user which collector configuration to check.

**Value:** Users can distinguish “the system is healthy” from “we have stopped observing the system.”

**Can it be free?** Yes at beta volume using existing delivery records and scheduled health checks.

### 5.4 Slack, Teams, and email notifications

**Status:** Excluded from the current implementation by product decision

**User problem:** Engineers will not continuously watch the ReplayOps dashboard.

**Potential future scope:** Route incident notifications by severity and service. Include the leading hypothesis, strongest evidence, confidence blockers, recommended next test, and a direct incident link.

**Example:** The payments channel receives a message stating that a release is the leading precursor, but the claim lacks trace linkage and should be tested by comparing release cohorts.

**Value:** ReplayOps enters the team's existing response workflow instead of becoming another destination users must remember to check.

**Can it be free?** Slack and Teams webhook delivery can be implemented without paid middleware. Email volume and advanced routing may eventually require a paid provider.

### 5.5 Incident grouping, merge, and split

**Status:** Live with limitation

**User problem:** One outage may generate dozens of alerts, while two simultaneous outages may initially look related.

**What is live:** Group by trace/release correlation keys first, then by the configurable time window and direct relationships in the service catalog. Manual merge/split and feedback learning remain future work.

**Example:** API latency, queue depth, and checkout errors caused by the same release become one investigation. An unrelated search outage remains separate.

**Value:** It reduces alert fatigue and gives each incident a coherent evidence boundary.

**Can it be free?** Yes. Deterministic grouping and database operations do not require a paid AI model.

### 5.6 Service catalog and dependency graph

**Status:** Live

**User problem:** ReplayOps cannot reason deeply about propagation if it does not know which services call one another or which team owns them.

**What is live:** Store service owners, criticality, repositories, dependencies, and runbooks with manual corrections. Automatic graph discovery from OpenTelemetry spans, SLOs, and escalation channels remain future work.

**Example:** ReplayOps knows that checkout calls inventory and payments, so an inventory precursor is more plausible than an unrelated search-indexing alert.

**Value:** Correlation becomes architecture-aware rather than based only on timestamps and matching strings.

**Can it be free?** Yes for small graphs stored in PostgreSQL. Very large telemetry-derived graphs may eventually need additional compute.

### 5.7 Thresholds, suppression, and maintenance windows

**Status:** Live

**User problem:** Global thresholds create false positives because normal behavior differs by service and environment.

**What is live:** Configure a workspace incident threshold, grouping window, low-severity suppression, and immediate maintenance mode. Service-specific rules and scheduled windows remain future work.

**Example:** A batch processor can tolerate high queue depth overnight, while checkout opens an incident immediately after a smaller error-rate breach.

**Value:** Users receive fewer low-quality incidents and trust automation more.

**Can it be free?** Yes.

### 5.8 Organization invitations and role-based access

**Status:** Live with limitation

**User problem:** Real teams need shared workspaces without giving every person permission to change connectors or delete evidence.

**What is live:** Send email-bound links that expire after seven days, report provider acceptance or failure, retain a copyable fallback, accept invitations only from the matching authenticated account, assign admin/responder/viewer roles, and enforce mutation permissions in the API.

**Example:** A viewer can inspect a postmortem but cannot rotate connector credentials; a responder can add evidence but cannot delete the organization.

**Value:** It makes the product safe for team use and supports separation of duties.

**Can it be free?** Yes within Supabase's free authentication quota for a small beta.

### 5.9 Immutable audit trail and retention controls

**Status:** Live with limitation

**User problem:** Teams need to know who changed evidence, altered an incident, rotated a secret, or approved a mitigation.

**What is live:** Append successful mutations and governed actions with actor, action, target, detail, and timestamp. Export, configurable retention, and administrative deletion workflows remain future work.

**Example:** A post-incident review shows who changed the incident severity, why a rollback was approved, and which connector supplied each event.

**Value:** This supports trust, compliance, and reliable postmortems.

**Can it be free?** Yes for a small data volume, but long retention and large raw payload archives eventually require paid storage.

### 5.10 Grounded AI with evidence citations

**Status:** Live with limitation

**User problem:** A fluent AI answer is dangerous when users cannot verify which recorded observations support it.

**What is live:** Retrieve relevant evidence, redact credential-shaped values before provider calls, constrain answers to the retrieved boundary, and return incident/event citations with excerpts, confidence, model mode, and redaction count. Broader answer evaluation remains future work.

**Example:** The assistant states that release `2026.09.21` is a candidate and links directly to the deployment and failed traces, while noting that an earlier latency increase weakens the theory.

**Value:** AI accelerates evidence review without becoming an unaccountable source of truth.

**Can it be free?** Limited usage can use a free model tier or a user-provided key. The deterministic proof loop should remain available with no model. Sensitive production data may require a paid provider with stronger privacy terms.

### 5.11 Postmortem generation and learning loop

**Status:** Planned

**User problem:** Teams repeat manual postmortem work and rarely feed conclusions back into future incident detection.

**Experience to build:** Generate a draft from verified evidence, decisions, hypothesis tests, mitigation results, and recovery signals. Require human review before publication. Convert accepted findings into correlation or runbook improvements.

**Example:** ReplayOps produces a draft timeline and clearly labels “verified cause,” “contributing condition,” and “unresolved question.”

**Value:** Incident evidence becomes organizational learning instead of a one-time response artifact.

**Can it be free?** Deterministic templates can be free. AI-polished narratives depend on model quota or a user-provided key.

### 5.12 Production mitigation execution

**Status:** Safety-gated — approval workflow live; execution intentionally disabled

**User problem:** Once a mitigation is validated, teams may want a controlled way to apply it.

**Experience to build:** Dry run, signed action manifest, explicit approver, scoped temporary credential, isolated worker, policy check, execution receipt, health verification, and rollback.

**Example:** A responder proposes reducing checkout concurrency. ReplayOps shows the exact target and duration, requires approval, applies only the allowed change, observes the result, and automatically reverts if health worsens.

**Value:** It can reduce time to mitigation while preserving human control.

**Can it be free?** The interface and policy engine can be developed for free. A trustworthy always-on execution worker, secret manager, monitoring, and production SLA should not depend on hobby free tiers.

---

## 6. Delivery status and recommended next order

### Completed foundation: Make first value effortless

1. Guided GitHub, Grafana, and OpenTelemetry setup.
2. Connector validation and health.
3. One real source producing real incidents.

**Exit condition:** A new user can sign up, connect one system, receive evidence, and open a useful investigation without developer assistance.

### Completed foundation: Make ingestion trustworthy

1. Durable Supabase queue.
2. Retry and dead-letter workflows.
3. Payload size and schema controls.
4. Worker lease recovery.

**Next hardening:** Per-tenant rate limits, connector secret rotation, and processing-latency metrics.

**Exit condition:** A temporary processing failure does not lose evidence, and the user can see and recover every failed delivery.

### Completed foundation: Improve diagnostic quality

1. Incident grouping by correlation and service dependencies.
2. Service catalog and dependency graph.
3. Per-service thresholds and suppression.
4. Evidence-cited AI.

**Next hardening:** Manual merge/split, per-service policy, and correlation feedback.

**Exit condition:** ReplayOps consistently creates fewer, richer investigations and explains why evidence was grouped.

### Completed foundation: Support teams and governance

1. Invitations and role-based access.
2. Immutable audit trail.
3. Governed mitigation requests and approval.

**Next hardening:** Workspace switching, audit export, retention/deletion controls, and postmortem generation.

**Exit condition:** A small engineering organization can operate ReplayOps with clear ownership, access boundaries, and review history.

### Safety-gated future phase: Controlled action

1. Approval policies.
2. Signed mitigation manifests.
3. Isolated executor.
4. Health validation and automatic rollback.

**Exit condition:** The product can perform a narrowly scoped production action without bypassing human authorization or auditability.

---

## 7. What can run for free

The current Vercel, Render, and Supabase deployment is appropriate for a portfolio, evaluation, or low-volume invitation-only beta.

| Capability | Free-beta approach | Limitation |
| --- | --- | --- |
| Frontend | Vercel Hobby | Intended for personal, non-commercial use |
| API | Render Free | Sleeps after inactivity and may have a cold start |
| Database and authentication | Supabase Free | Storage, egress, compute, and inactivity limits |
| Durable queue | Existing Supabase PostgreSQL tables | Shares database capacity; polling worker is designed for low volume |
| Search | PostgreSQL full-text search | Less semantic than embedding search |
| AI | Deterministic analysis plus optional free-tier or user-provided model | Rate limits and privacy constraints |
| CI/CD | GitHub Actions included allowance | Private repositories have limited included minutes |

### Honest boundary

“Free” can support development and a real small-team beta. It cannot provide a defensible production SLA for a business-critical incident system. An always-on receiver, backups, higher retention, protected secrets, operational monitoring, and support eventually require paid infrastructure.

## 8. Example: complete future user journey

1. A user creates a ReplayOps workspace and invites the on-call team.
2. The setup wizard connects GitHub, Grafana, and an OpenTelemetry collector.
3. ReplayOps verifies each source and begins showing connector health.
4. A deployment event enters the durable queue and remains buffered as an ordinary change.
5. Failed checkout traces and a Grafana SLO alert arrive with the same release context.
6. ReplayOps groups the signals, opens one incident, and backfills the deployment.
7. The engineer opens the incident and reviews the ordered propagation path.
8. ReplayOps recommends comparing the new and previous release cohorts.
9. The test weakens the deployment hypothesis and strengthens a database-pool hypothesis.
10. The responder records a bounded mitigation and runs a deterministic replay.
11. A different administrator approves it; the team applies the action through its existing operational tooling.
12. Recovery evidence is attached and the incident is resolved.
13. The audit trail and generated handoff preserve the evidence and decision path.

The value is not that ReplayOps produces an answer automatically. The value is that it helps a team reach a better-supported answer faster, shows what could make that answer wrong, and preserves how the decision was made.
