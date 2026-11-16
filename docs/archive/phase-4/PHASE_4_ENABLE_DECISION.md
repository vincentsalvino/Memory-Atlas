# Production enablement decision — 2026-11-16

The user explicitly requested enabling learning and redundancy and authorized
implementation. Production now enables the existing policies, independently
overridable through `BRAIN_LEARNING_ENABLED` and `BRAIN_REDUNDANCY_ENABLED`.

Phase 4.3's historical verdict remains `NOT_ENOUGH_EVIDENCE`. This change does not
claim that its organic comparison gate has subsequently passed; no new corpus
count or measured benefit is asserted. Enabling supports genuine dogfooding at
the user's direction. It is reversible and leaves raw event evidence intact.

Retained learning policy: k=5, outcomeWeight=0, maxBoost=0.15. Existing redundancy
thresholds are unchanged. Contract-level defaults remain disabled so isolated
library consumers must opt in; the production resolver enables both.

Rollback: set the relevant launcher environment value to `false`, restart MCP,
and inspect fresh per-instance runtime status. Keep database migrations and raw
counts. Neither feature authorizes changing confidence, archiving memories, or
deleting near-duplicates.

Evaluate paired full requests against an isolated copy/fixture, plus genuine
organic tasks: compare delivered sets, harmful omission of distinct constraints,
useful/irrelevant feedback with honest denominators, and full handler latency.
The ±15% multiplier bounds scores, not the size of a rank or token-budget change.
A zero-usefulness baseline cannot establish safety. Temporal replay and the
existing learning/redundancy regression suites remain necessary evidence.
