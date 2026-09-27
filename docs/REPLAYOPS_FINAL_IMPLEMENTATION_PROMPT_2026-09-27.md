# ReplayOps final implementation brief — 2026-09-27

Implement the product contract in `REPLAYOPS_FINAL_FLOW_SPEC_2026-09-27.md` as working frontend, backend, persistence, tests, and documentation. The final flow specification supersedes the universal scenario calculator and disconnected form proposals.

Required implementation slices:

1. Correct provider identity, timestamp, metric semantics, environment scoping, and comparison arithmetic before deriving new conclusions.
2. Add persisted investigation checks, review cursors, historical conclusions, and evidence-change recheck state.
3. Add immutable change proposal versions and version-bound validation artifacts with explicit provenance.
4. Add independent, role-enforced review of the exact proposal version; approval is not execution.
5. Add versioned recovery criteria and typed measurements for runtime and delivery-only cases.
6. Make lifecycle transitions server-owned. Require Monitoring before Resolved, re-evaluate recovery at resolution time, reject stale evidence revisions, and transact resolution plus audit.
7. Keep genuine bounded HTTP execution advanced, narrow, and honest. Provide a CI path without claiming universal replay.
8. Preserve handoff, evidence links, source provenance, role rules, drafts, responsive behavior, and free-tier compatibility.
9. Keep AI optional and redacted; deterministic product paths must work with no model key.
10. Validate missing/stale telemetry, contradictory checks, evidence changes, wrong environment correlation, failed CI, newer recovery regression, unsupported replay, permissions, persistence, and large evidence windows.

Deliver migrations, decision ledger, actual test results, browser-validation evidence or an exact blocker, remaining limitations, and local trial instructions. Do not treat synthetic fixtures as production telemetry.
