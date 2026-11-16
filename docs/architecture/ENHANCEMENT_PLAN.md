# Shared harness memory and usage observability

Implementation plan, replacing the external Antigravity draft. Authorized 2026-11-16.

1. Reserve `harness:<encoded harness>:<encoded project>` project scopes. Enforce access at the Gateway using immutable launcher identity, including deliberate scope impersonation and feedback/outcome access. Unknown identities cannot access private scopes. Shared project context/search blends the caller's private project memories before ranking and token budgeting. Existing global/project/session behavior remains compatible. The local database and visualizer are privileged: this is an API boundary, not protection against a process with direct filesystem access.
2. Stamp retrieval/context/feedback/outcome events server-side. Public tool inputs omit attribution fields. Mutation source attribution uses launcher identity. Keep nullable additive migrations on rollback.
3. Provide repeatable setup for explicit JSON MCP configuration paths, preserving unrelated entries, refusing replacements without an explicit switch, and restoring from a backup on undo. No implicit edits to installed harnesses. Provide generated configuration for other formats.
4. Enable existing learning and redundancy policies in the production composition root, retaining k=5, outcomeWeight=0, maxBoost=0.15 and redundancy thresholds. Independent strict environment overrides support rollback. Record live per-process configuration with heartbeat/expiry, so the read-only UI can report unknown/mixed rather than infer running state from its own environment.
5. Automatically observe Brain calls and separately accept explicit skill/plugin lifecycle reports. Rank by kind, harness, identifier, stage and source; unknown external activity stays unknown. Reports are not independent proof of loading or savings. Do not automatically disable rarely used tools. Harness hooks can use the reporting tool; automatic external collection requires a supported adapter and is not claimed.
6. Extend the read-only UI with effective runtime state, usage/source labels, harness attribution and filtering, outcomes and narrow-screen layout. Preserve skeletons and explicit map search.

Validation: compile all workspaces; focused authorization tests (including exact foreign scopes and unknown identities); migration and stamping tests; setup round-trip tests; config parsing, expiry/mixed state, usage failures and ranking tests; full repository check; browser verification where available. No live database is used as a test fixture.

Learning is enabled at the user's request before the historical evidence gate is met. This is not a claim of improved retrieval. Compare full request duration and context usefulness on genuine work; do not use a zero-usefulness baseline to declare success.

## Implementation verification

Completed 2026-11-16. `npm run check` passed (build, all workspace typechecks,
default Node and UI tests). Added exact-foreign-scope/unknown-identity tests,
feedback isolation, mutation attribution, blended context budgeting, setup/undo
and replacement preservation, runtime expiry/mixed settings, usage source
separation, and best-effort telemetry failure tests. Two independent review
passes found defects that were fixed and verified before completion.

Browser verification used a disposable database: usage filters and zero-match
state worked; Tab moved focus between controls; the 400px viewport reported
body and document width of 400px. Preview process stopped and fixture removed.

Reconnect MCP harnesses after building to activate the new tools and settings.
No installed host configuration was modified. External skill/plugin lifecycle
requires explicit reports from a cooperating agent/hook; automatic external
collection, dynamic plugin unloading and measured cost savings are not claimed.
