---
version: 1
slug: "src-pages-incidentworkbenchpage-tsx"
primary_target: "src/pages/IncidentWorkbenchPage.tsx"
related_targets: ["src/components/ResponseConsole.tsx"]
---

## Direction contract

THESIS: The incident workbench turns recorded evidence into a falsifiable diagnosis, a reviewable decision, and a counterfactual outcome. It refuses the passive detail-page pattern where teams inspect telemetry but cannot determine what to test next or prove why they acted.

OWN-WORLD: Extend the Industrial Chronograph Bench with one compact response console: blue-charcoal instrument neutrals, incident-orange intent controls, calibrated rules, mono measurements, and status marks that combine words with icons. No new visual identity or decorative metrics.

STORY: An on-call engineer reads the causal trace, compares ranked hypotheses, inspects both supporting and conflicting evidence, runs the next safe falsification test, records a decision, replays a mitigation, and copies a concise handoff. Evidence gaps and uncertainty remain visible at every step.

FIRST VIEWPORT: Keep the incident record and causal trace dominant. Directly below the trace, add a full-width diagnostic proof loop with Diagnose as the default mode, followed by Decisions, Replay Lab, and Handoff. The leading hypothesis, service propagation path, confidence blockers, and next falsification test must be visible without opening a modal.

FORM: Local extension inside the established Operate surface; no concept seed was required. Signature interaction: responders select among competing hypotheses, ask AI to challenge—not approve—the claim, then replay controls update a before/after impact rail and commit one reproducible run to the activity record.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
