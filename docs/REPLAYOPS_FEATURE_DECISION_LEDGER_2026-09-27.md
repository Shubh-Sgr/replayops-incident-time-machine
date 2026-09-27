# ReplayOps feature decision ledger — 2026-09-27

| Decision | Chosen behavior | Reason | Deliberately not claimed |
|---|---|---|---|
| Primary workflow | Investigate → Fix & verify → Activity & handoff | Mirrors responder intent without forcing a wizard | A linear incident process |
| Scenario calculator | Removed from the primary workflow; legacy records remain readable | Heuristic slider outputs were not execution or recovery proof | Predictive mitigation scoring |
| Evidence changes | Per-user review cursor plus `needs_recheck` on older conclusions | Preserves history while making staleness visible | Automatic rewriting of conclusions |
| Checks | Five structured templates with method, conditions, expected signal, result, and evidence links | Converts advice into an auditable investigation action | AI-generated truth |
| Proposals | Immutable versions tied to evidence revision and target identity | Prevents validation/approval from drifting to edited settings | Mutable “current settings” approval |
| CI validation | Exact repository/workflow/SHA/run/attempt match; status derived from ingested source | Makes GitHub-only delivery cases useful and defensible | Runtime recovery from green CI |
| Manual validation | Stored and visibly labeled operator-reported | Useful when automation is unavailable, without misrepresentation | Automated execution |
| Approval | Different administrator, exact version, current evidence, passing validation | Enforces separation of duties | Self-approval or approval of an estimate |
| Runtime recovery | Typed values, units, direction, source, interval, freshness, consecutive windows | Makes pass/fail reproducible | Old pass overriding new failure |
| Delivery recovery | Exact successful workflow rerun | Supports delivery-only incidents | Production health |
| Resolution | Server lock, evidence revision check, fresh recovery evaluation, reason, transactional audit | Makes status trustworthy | UI-only status selection |
| HTTP replay | Loopback-only, immutable capture, explicit assertions, redaction, no production credentials | Provides narrow real execution safely | Universal distributed-system replay |
| AI | Optional contextual explanation with citations and pre-request redaction | Adds help without becoming a control-plane dependency | Approval, execution, or incident lifecycle authority |
| Impact | Measured only when numerator/denominator share series, scope, and interval | Prevents invalid rates | Combining unrelated telemetry |
| Healthy cohorts | Same service/route/method/region and comparable window where available | Prevents misleading comparisons | Arbitrary “healthy” samples |
| Cost | Existing React/Express/PostgreSQL stack; no new required service | Keeps the product deployable on existing free tiers | Unlimited free retention or compute |
