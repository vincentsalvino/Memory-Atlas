# Requests 5–8: inspector resizing, session coordination, knowledge reuse and handoff

Status: planning only. No implementation, memory promotion, session interruption,
host configuration change, commit or publication is authorized by this document.
User priorities confirmed: Codex ↔ Claude on the same PC first; share general
SketchUp techniques across projects while keeping project details separate.

**Lean/token-cost requirement:** Section 10 is part of the acceptance contract,
not a later optimization. See [primary-source research](TOKEN_COST_RESEARCH.md).
Keep routine coordination outside model turns, bound the complete delivered
payload, and validate cost per successful task alongside correctness. Numeric
budgets below are proposed starting limits, not measured savings guarantees.

## 1. Verified starting point

| Area | What exists | What is missing |
| --- | --- | --- |
| Inspector | `InspectorDock.tsx` implements collapsed/compact/wide stops, pointer capture and keyboard resize. CSS explicitly reveals three decorative snap markers while dragging. | A reproduced drag/visual regression for the reported symptom; unobtrusive resize feedback. |
| Harness identity | Launcher-configured `codex` / `claude-code`, private project scopes, event attribution and process heartbeats. | A distinct identity for each chat/task, active-work ownership and a trustworthy mapping from a host conversation to a Brain session. |
| Shared database | Both harnesses point at the same SQLite database. | Same database does not mean every project is included in every retrieval, or that each new session actually calls Brain. |
| Project retrieval | Global + exact requested project + caller's harness-private project memories; one context budget. | Explicit reuse of selected techniques from another project; canonical project aliases; evidence explaining missing context. |
| Continuation | Context/outcome event chains and some caller-provided session references. | Persistent session registry, handoff checkpoints, resource leases and a portable resume packet. |

Read-only corpus inspection for this plan found 29 active records mentioning
SketchUp: 25 under `Midterm` (23 project-state, one fact, one decision), three
project-state records under a separate handoff project, and one project-state
record under another project ID. Tags vary; some are empty. These are counts of
mentions, not proof of reusable technique quality. No records were copied or
changed. This snapshot will change as the corpus evolves.

Existing events include SketchUp queries in several scopes. That establishes
some Brain usage, not whether the particular final-project chat retrieved and
used the right memories. That requires its task → query → candidate → delivery
trace. Related chat titles were discoverable through the connected app, but
their transcripts were not imported or used as proof of task outcomes.

No session/claim/handoff registry tables were present in the inspected database.
The current `runtime_instances.id` identifies an MCP process, not a chat.

## 2. Product decisions

1. Keep four distinct identities: harness, host conversation, Brain session and
   task. A human-readable label is descriptive; the server-generated ID owns work.
2. Keep durable knowledge, live coordination and resumable checkpoints as separate
   records with separate retention. Do not fill the memory table with heartbeats.
3. Coordinate cooperating agents in the same tree with transactional leases and
   visible ownership. Do not claim this prevents a user or unintegrated tool from
   editing files directly.
4. Share reusable techniques through an explicitly subscribed library. Do not
   broaden global scope, infer access from a topic tag, or expose every Midterm
   record to final-project sessions.
5. Cross-harness resume means a new destination conversation grounded by a
   verified handoff packet. Same-host native resume remains a separate operation.
6. Keep the visualizer a privileged read-only inspector. Mutations happen through
   MCP/CLI operations, or a later separately designed authenticated management UI.
7. No cloud service, device sync or transcript-database conversion in the initial
   release. No automatic transfer of model internals, approvals or hidden reasoning.

## 3. Request 5 — remove the apparent resize nodes

### Diagnosis and reproduction gate

The supplied images show three small blue dots along the panel's lower edge.
Source facts: `InspectorDock` renders exactly three `.inspector-snap-points`
spans; `global.css` makes their 6px circular pseudo-elements visible when
`data-dragging="true"`. They are decorations outside the graph's SVG, not memory
records. This source inspection is not yet an end-to-end reproduction of the
user's drag sequence or proof that no pointer-capture problem also exists.

Implementation begins with a fixture-backed browser reproduction: open a memory,
drag the inspector edge through all stops and release it; record visible snap
markers, SVG node count, selection, pan/zoom and `data-dragging`. Repeat pointer
cancel, lost capture and releasing outside the dock. No production DB fixture.

### Intended behavior

- Keep the width measurements needed for snapping, but remove circular marker
  paint. Hiding/removing measurement elements without replacing geometry would
  break snapping; measure stops from the dock and CSS constraints or retain
  non-painted measurement anchors.
- Show the active vertical edge and resize cursor as feedback. Preserve the three
  stops initially; continuous resizing is a separate UX decision.
- Pointer-up/cancel/lost-capture always clear transient dragging state and width.
- Preserve graph simulation identity, selected memory, inspector section and
  scroll position. Resizing must not create nodes, reset zoom or refetch memories.
- Keep ArrowLeft/ArrowRight/Home/End controls and visible keyboard focus. Test
  narrow layouts, browser zoom and reduced-motion preferences.

Acceptance: zero decorative blue circles before/during/after resize; unchanged
SVG memory-node count and IDs; working snap widths; no stuck drag state after
any termination path. Use pointer-interaction tests plus a browser visual test;
the existing keyboard-only test cannot establish these properties.

## 4. Request 6 — know who owns work in a shared tree

### Identity and workspace model

`HarnessIdentity` is launcher metadata. `HostConversationRef` is an optional
verified host ID. `BrainSession` is a server-generated UUID with a label such as
`Codex / auth cleanup / 8c12`; `taskId` identifies a unit of work inside it.
Two Codex chats get different Brain sessions even when they share a server.

Resolve a canonical workspace using real paths, repository/common Git directory,
worktree root and project ID. Keep these separate: the same repo can have several
worktrees; two unrelated repos can have the same folder name. Handle Windows
case/path aliases and symlinks; non-Git SketchUp folders must also work.

Bind identity through a supported host adapter or an explicit bootstrap command.
A fresh server process may create an instance ID, but must not pretend that ID
is a durable native chat ID. A pooled/multiplexed MCP server needs an explicit
session-bound handle, validated per request; never a mutable global “current
session.” Unknown sessions are displayed as unidentified and cannot impersonate
an existing owner. Client-provided labels/PIDs are not authentication.

Session-bound handles must be unguessable capabilities, stored as hashes where
possible, scoped to the registered identity/workspace and excluded from logs,
checkpoint exports and the visualizer. A session UUID alone is not a credential.
This remains a trusted-local-adapter design, not a sandbox against processes
that can read the shared database or rewrite launcher configuration.

### Live coordination

Proposed session states: registered, active, idle, stopped, expired. Activity and
heartbeat are different: an open idle session is not necessarily editing.
Register task intent and a small set of write resources before work begins:

- a normalized file/subtree;
- a shared worktree Git index/branch operation;
- a model/document, or a live application's exclusive UI-control resource.

Acquiring overlapping write claims is atomic in SQLite (`BEGIN IMMEDIATE` plus
conflict checks). Readers can coexist; disjoint writers can coexist. Use server
time, an owner-bound lease ID and generation/fencing token. Heartbeats renew only
the owning generation; expired/released generations cannot renew or complete.
Default proposal: 30s heartbeat and 120s lease, configurable after measuring host
latency. Do not reap a process merely because it is idle.

On conflict, return owner, task, resource and freshness. Offer wait, choose a
different resource/worktree, or an explicit takeover/handoff. Never auto-kill a
process, reset Git, stash another agent's edits, or blame a session for every
dirty file. Record expected hashes/revisions for owned writes; detect later
external edits as unknown changes. Long commands require renewal independent of
model turns. Claims without an enforcing host hook are visibly advisory.

For the user's example, the next agent should receive a concise message such as:
“Claude / roof cleanup owns model.skp; Codex / tagging owns tagging.rb.” If both
need to manipulate the same live SketchUp window, UI control is exclusive even
if their logical geometry tasks differ. For conflicting source edits, worktrees
are an option rather than a mandatory workflow change.

### Interfaces and UI

Provisional tools: `brain_session` (register/status/heartbeat/end) and `brain_work`
(claim/renew/release/list). Keep small schemas; inject validated request identity
into Gateway services. A generic local CLI gives unsupported hosts an honest
fallback. Do not turn every shell command into another Brain model round trip.

Read-only UI: Active work panel grouped by workspace, owner/task/resource,
lease freshness and integration coverage. Labels distinguish observed commands
from declared intent. An activity label alone is not proof a command is running.

Acceptance includes two harnesses and two same-harness sessions, concurrent
conflicting claims, directory/file overlap, shared Git resources, crash expiry,
late heartbeats, stolen/unknown handles, path aliases, idle sessions and external
file edits. An integration test must show an unintegrated tool is not falsely
reported as blocked.

## 5. Request 7 — reuse SketchUp experience without leaking project details

### First explain a missed delivery

Build a bounded diagnostic for a selected task: connected server/schema version,
resolved project alias, Brain invocation, subscriptions, lexical/semantic
availability, candidate IDs, ranked/included/omitted IDs, source provenance and
token cost. Identify scope exclusion, no saved technique, search mismatch,
budget omission and missing invocation separately. Scope explanations must not
reveal another private scope's content. Do not tune ranking weights as a first
response to a scope or capture problem.

### Canonical projects and explicit libraries

Introduce project aliases mapped to stable project IDs. Preserve existing IDs
such as `Midterm`; never rename an entire corpus based on a folder guess. Alias
collisions fail with a resolution request rather than silently merging projects.

Create a `SketchUp techniques` library. Projects subscribe explicitly; the
subscription authorizes reading approved entries only. Existing domain/tags
remain taxonomy, never an access-control rule. Keep `scopeIncludes()` exact and
do not use global scope as a shortcut.

Recommended minimum storage: `knowledge_libraries`, `project_library_grants`,
and `library_entries` referencing approved, version-pinned canonical memories.
This avoids changing `ScopeRef` and rebuilding every existing scope CHECK just
to share selected lessons. Library reads use a dedicated grant-aware repository
path returning only approved IDs; callers cannot supply an arbitrary allowlist
or use library access to read other records from the source project.

Promotion creates a new distilled memory with `source.origin=derived`, source
memory references, scope/author provenance, applicability and validation evidence.
Its original project retains ownership; a library entry grants read access to
that selected revision, not edit authority or access to its source project.
Pin a content hash/version. Editing, archiving or revoking an approved record
invalidates reuse until reapproval; do not share future revisions silently.
Harness-private source content must never be published by automatic promotion.

Examples of possible techniques to review: geometry validation, units handling,
group/component organization, tags, preserving manual edits, safe Ruby operations,
and version-specific tool pitfalls. These are candidates, not claims that the
current corpus contains verified procedures. Exclude building dimensions, model
paths, personal instructions, reference images and project-specific design choices.

### Capture and retrieval

Review the existing Midterm records into a proposal list: reusable technique,
project state, obsolete or uncertain. Show provenance and the proposed distilled
text; batch approval creates entries. Preserve originals and rollback by removing
library grants/entries. Do not bulk-copy all 25 records or rewrite their scopes.

At the start of real substantive work, resolve the project and report its
subscriptions. `brain_context` blends local/global/own-private candidates with
approved subscribed-library candidates before the single hard token budget.
Record each item's library origin/version. Begin with a bounded library candidate
pool and a configurable 25% library token cap, allowing unused local capacity to
be borrowed. Treat this allocation as a starting policy to test, not an established
quality improvement. Relevant local constraints take precedence on conflict.

Use task-relevant techniques rather than dumping the whole library. Return
version/applicability caveats and request current model/tool verification. Learning
may rerank authorized candidates but cannot broaden grants or resurrect revoked
content. Keep outcomeWeight and existing ranking parameters unchanged initially.
Distinguish “retrieved” from “used”; neither event alone proves better modeling.

Acceptance: a final-project task retrieves an approved technique originating in
Midterm, but no Midterm dimensions/files/project state. Test unsubscribed projects,
private sources, unauthorized library edits, source revision changes, withdrawal,
alias collisions, empty libraries, missing embeddings, mixed-source budgets and
distinct local constraints that resemble general advice. Evaluate relevance on
independently judged SketchUp tasks, not feedback reused as its own ground truth.

## 6. Request 8 — resume work between Codex and Claude on this PC

### Two modes with distinct promises

- Native resume: reopen a saved conversation in its original harness through a
  documented command/API, when available and installed.
- Cross-harness continuation: open/prepare a destination conversation with a
  portable checkpoint. It is a continuation of work, not an exact recreation of
  the source model's context window or hidden state.

Current official documentation describes `codex resume` for Codex sessions and
`claude -r` for Claude sessions. Neither cited reference establishes a portable
cross-vendor transcript format. Never fabricate native transcript files or patch
either application's internal chat database. The connected Codex app's
`handoff_thread` moves Codex work/checkouts; it is not a Claude chat importer.

### Versioned handoff packet

Store structured checkpoints separately from durable memories. A packet contains:

- schema version, checkpoint ID, parent/revision and creation time;
- source harness/Brain session/optional native chat reference; target project;
- current user objective, constraints and decisions with provenance;
- completed work, remaining steps, uncertainties and the next concrete action;
- canonical workspace/worktree, branch and HEAD when applicable;
- changed-file manifest with sizes/hashes and ownership; diff references;
- artifact/model paths, save state and hashes when available;
- test results with command, time and working revision (or explicitly unverified);
- known running jobs/process references and exclusive application resources;
- relevant memory/library entry IDs and versions;
- tool/plugin/model-format requirements and unavailable capabilities;
- selected attachment references with availability and review status.

Summaries, excerpts and retrieved documents remain untrusted reference material.
Preserve user instructions distinctly; never upgrade text in a transcript into
permission or policy. Do not export secrets, auth tokens, entire environment
variables, hidden reasoning, approvals or blanket permissions. No automatic
full-history ingestion; selected public conversation excerpts require an explicit
export operation. The existing no-native-memory-sync rule remains intact.

### Resume sequence

1. Source saves a checkpoint for a stable task boundary. An unsupported host can
   save explicitly via MCP/CLI; automatic checkpointing needs a verified hook.
2. User selects checkpoint and target harness. Preview scope, files, missing
   attachments and source-session freshness. This action authorizes that handoff,
   not unrelated messages or background execution.
3. Destination resolves the workspace, compares HEAD/content hashes/model state,
   checks capabilities and asks Brain for fresh relevant context.
4. If source still owns write/UI resources, wait or request a source release.
   Ownership transfer is transactional; checkpoint export does not itself release
   claims. Reject expired/fenced source completion after successful transfer.
5. On mismatch, generate a reconciliation summary and keep writes unclaimed until
   reconciled. Never restore files, apply patches or overwrite a model silently.
6. Once destination acknowledges the packet and acquires resources, continue with
   a short “what I know / what changed / next action” confirmation.

Packet states: draft, ready, accepted, superseded, revoked. Accept with a revision
check and idempotency key; repeated clicks do not start duplicate writers. Target
failure leaves the checkpoint ready and the source ownership intact. Multiple
read-only continuations are allowed; write ownership is exclusive where needed.

Initial delivery: structured JSON + readable Markdown + a bounded pasteable
destination prompt, available through a provisional `brain_handoff` tool and CLI.
CLI native-resume/launch helpers are adapter-specific and feature-detected; execute
argument arrays without interpolating checkpoint text into a shell. GUI surfaces
without a supported launch API receive the packet for an explicit new chat rather
than a false one-click claim. No messages or chats are created during planning.

Acceptance: Codex → Claude and Claude → Codex continuation on one PC; same-host
native resume; dirty tree/changed HEAD, renamed/missing file, unsaved SketchUp model,
missing image/plugin, source still active, target launch failure, duplicate accept,
revoked checkpoint, hostile transcript instruction and secret exclusion. The
destination must identify the next task without inheriting stale tool results or
unapproved authority. Exact word-for-word chat recreation is not an acceptance test.

## 7. Implementation boundaries and sequence

| Stage | Deliverable | Exit gate |
| --- | --- | --- |
| A | Inspector reproduction and smallest resize correction | Visual/pointer regression reproduces the report before the fix and passes after it. |
| L0 | Serialized payload measurement and compact-response contract | Baseline full response/schema size, label estimator limits, preserve client compatibility; complete before E/F rollout. |
| B | Session binding, workspace identity and active-session listing | Distinct same-harness chats and reconnect lifecycle verified without confusing process and chat IDs. |
| C | Atomic resource leases and read-only Active Work UI | Concurrent writers, expiry, fencing and unsupported-client honesty pass. |
| D | Retrieval trace diagnostics and project aliases | Explain one real SketchUp delivery/miss with evidence; preserve existing project visibility. |
| E | Approved techniques library, subscriptions and scoped retrieval | Final-project fixture gets a technique and no Midterm project details; token/security tests pass. |
| F | Versioned handoff export/accept and CLI/paste fallback | Two-way Codex/Claude handoff passes stale-state and ownership tests. |
| G | Verified native hooks/GUI integrations | Installed versions, supported contracts and local lifecycle behavior validated before enabling automation. |

A can ship independently. B/C establish safe ownership before F transfers it.
D precedes E so retrieval failures are measurable before broadening retrieval.
F reuses B/C identity and E knowledge references. Do not block portable manual
handoff on optional host hooks or remote-device infrastructure.

Contracts live in `packages/core/contracts`; SQLite implementations and numbered
migrations in `packages/storage`; orchestration in `packages/gateway`. Extend
existing retrieval/context/token/evaluation packages for library blending and
traces. Keep MCP handlers thin. Native host commands/hooks are adapters; no
Codex-only or Claude-only policy branches in the core. Visualizer read models
extend the existing server and shared types; they do not mutate data.

Proposed storage groups: `brain_sessions` and workspace bindings, `work_claims`
with generation/expiry and append-only ownership transitions, project aliases,
the three library tables, and `handoff_checkpoints`/acceptance records. Freeze
schemas only after B's identity binding is exercised against actual host
lifecycles. Do not allocate migration numbers until checking the current ledger.

Add event attribution for session/task/library/handoff IDs as needed without
exposing server identity or capability handles as caller-minted provenance.
Bounded per-request identity replaces any temptation to use global session state.

## 8. Validation, rollout and recovery

- Fixtures and temporary databases only for automated tests. Preserve the live
  corpus; use SQLite backup API before any authorized migration/promotion rollout.
- Test upgrades from the current schema and older nullable-attribution schemas,
  row counts, foreign keys, interrupted transactions and old-client compatibility.
- Test service/store seams, then real MCP wire calls, then real host lifecycle
  adapters. A mocked hook alone cannot prove startup/stop integration.
- Browser QA: inspector drag/cancel/zoom, keyboard navigation, narrow viewport,
  empty/long-content states, Active Work freshness and source provenance labels.
- Run focused tests for each stage, then `npm run check` before integration.
  Measure full request latency and packet/token size; no invented savings target.
- Ship identity observation before optional enforcement. Show integration coverage.
  Enable claims only for enrolled clients; fall back to explicit warnings where
  enforcement is unavailable. Unknown activity is not “nobody is working.”
- Library rollback revokes grants/entries, preserving original memories. Session
  service rollback stops renewal/enforcement with a visible degraded state;
  never delete another agent's files or silently release its live work.
- Resume rollback revokes an unused packet or returns to the source workflow;
  accepted work requires normal reconciliation, not pretending it never happened.
- Retain additive schema on application rollback. Define separate retention for
  short-lived heartbeats, coordination audit, checkpoints and durable knowledge;
  no automatic purge of user checkpoints in V1.

## 9. Open verification items, with defaults

No user answer is needed to start A/D. For later implementation:

- Verify whether each installed Codex surface provides stable session lifecycle
  metadata/hooks; otherwise use explicit binding, visibly marked. Do not infer
  chat identity from an MCP process. Claude's documented hook contract has
  session metadata, but installation-specific behavior still needs a smoke test.
- Verify native GUI session open/creation APIs separately from CLI commands.
- Decide which existing SketchUp lessons are genuinely general during the
  promotion review. Default is zero cross-project sharing until entries are approved.
- Check live SketchUp unsaved-state observability. If unknown, require a save or
  report “unsaved state unknown”; a disk hash cannot establish current canvas state.
- Native knowledge and private memory sharing across vendors remain separate
  from the portable handoff packet. Destination context and permissions are fresh.

## References

Repository sources inspected: `InspectorDock.tsx`, `MemoryInspector.tsx`,
`global.css`, `scope.ts`, `harness.ts`, event contracts, Gateway candidate/access
paths, CLI/server launchers, runtime store and the previous enhancement plan.

Official host references checked during planning:

- [Codex CLI resume](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-resume)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code hooks: session metadata and lifecycle](https://code.claude.com/docs/en/hooks)

Planning validation: source inspection, narrow read-only corpus metadata queries,
and host capability/documentation inspection. The inspector report has not yet
been reproduced in a browser in this planning task; the implementation exit
gate explicitly requires it. No model-performance improvement is asserted.

## 10. Lean architecture and token-cost acceptance contract

### 10.1 What the earlier plan covered, and what it did not

The initial design already avoided full-history imports, bounded retrieval, used
local coordination and proposed bounded handoff prompts. It did not specify a
complete serialized-response budget, separate provider-cache savings from token
reduction, or define a cost/quality comparison. This section fills those gaps.

This plan and its research note are developer documentation, not material to
automatically inject into every session. Runtime instructions use concise stable
guidance; detailed plans, skill bodies and history are loaded only when relevant.

Current code reuses local SQLite, local embeddings, one `fillBudget()` algorithm,
two-pass fit/compression and deterministic prefix truncation. Extend those seams;
do not build a second retrieval engine or introduce an LLM for every memory read,
heartbeat, ownership check, alias lookup or checkpoint update.

Local fixture observation during this research: ten one-character memory items
produced `tokenCount=10`, while the returned JSON text was 3,643 characters and
estimated as 1,215 tokens by the same estimator. This is a synthetic metadata-heavy
case, not a typical user workload, provider token count or measured cost saving.
It demonstrates that the current content-only counter is not an end-to-end cap.

The current estimator is `ceil(text.length / 3)`. Despite its code comment, it
cannot guarantee overestimation across model encodings, code, Unicode, paths or
languages. Plain-text counts also omit other request components. Label estimates
honestly and use target-model counting when available; do not call an estimate a
provider-enforced hard limit. [OpenAI token-counting guidance](https://help.openai.com/en/articles/4936856-understanding-and-counting-tokens)

### 10.2 Default execution: deterministic and event-driven

- Session registration, 30s heartbeats, resource lease renewal, hashes, path
  normalization, subscriptions and checkpoints' metadata run in local adapters,
  SQLite or the process timer. **Zero new model invocations for these operations.**
- Do not issue a model-mediated `brain_session` or `brain_work` call on every
  heartbeat. MCP/CLI operations remain available for explicit use and debugging;
  enrolled adapters perform ordinary renewals without adding chat messages.
- Send agent-visible coordination updates only for a new conflict, ownership
  transfer, actionable stale state or a requested status. Unchanged polling does
  not add another prompt/tool result. Debounce repeated events by revision.
- Reuse validated scope/identity/project resolution within a request. Share the
  existing process/database, services and query methods rather than adding a
  microservice, vector database, scheduler framework or hosted memory dependency.
- Batch release/renewal/read operations locally where transactional semantics
  allow it. Do not combine unrelated privileged actions into a generic executor
  merely to reduce the visible tool count.

### 10.3 Progressive retrieval and compact model-facing views

Default to one useful bounded context call per substantive task, not an extra
search/list/recall chain by habit. Only switch to metadata-first search + selective
detail when the index can materially narrow a large result; count those extra
round trips in the comparison. Trivial work retains the existing skip rule.

The default context response includes relevant content, short provenance/version
references, scope, omission indicators and a context ID. Scores, full event chains,
embedding vectors, entire library inventories and repeated raw records stay in
local storage/read-only diagnostics unless requested. Retain enough provenance
and identifiers for authorization, feedback and verification. A compact view
must be versioned/opt-in until current client compatibility is demonstrated.

Search/list endpoints use a small page with IDs, kind, a short preview and a
cursor. Detail reads are explicit and bounded. Filter records and aggregate counts
before data crosses the model boundary. The full UI may show rich records without
injecting that same data into every chat. This follows just-in-time context
retrieval guidance. [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)

Budget the **complete rendered model-facing result** after serialization, including
keys, IDs, provenance, truncation markers and envelope allowances. Use the existing
budget service with a final serialized-size check; omit complete lower-value items
and return bounded cursors if needed. Preserve necessary local constraints.

`server.ts` currently returns pretty-printed JSON text and `structuredContent`.
Measure what each host actually includes in the model input. Do not assume these
are counted once or twice. Minification and compact views are candidates; blindly
removing one representation could break clients because MCP recommends the text
representation for backwards compatibility. Wire size, rendered tokens and billed
usage must be reported separately. [MCP tool results](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

### 10.4 Proposed starting budgets

These are local model-facing delivery targets, not claims about the whole host's
system prompt, tool inventory, reasoning or total billing. Where the tokenizer is
unknown, mark `estimated`, use conservative payload-size guards and calibrate on
fixtures; only describe a token cap as exact for the counted representation/model.

| Delivery | Default target | Expansion rule |
| --- | --- | --- |
| Session bootstrap / identity + actionable ownership | 256 tokens once | Further details on explicit status/conflict; no repeated unchanged bootstrap. |
| Ordinary task context, including provenance and response overhead | 1,024 tokens | Escalate to 2,048, then up to a proposed 4,096 ceiling only for a concrete missing evidence need. |
| Library share within ordinary context | Initial 25% soft allocation | Shares the same total cap; never an extra full library dump. Unused capacity may be borrowed. |
| Search/list preview page | Up to 8 results and 512 tokens | Cursor/detail fetch; long identifiers can reduce the result count. |
| Routine conflict/ownership notice | 128 tokens | Include owner, resource, action and revision; full history on demand. |
| Cross-harness resume bootstrap, checkpoint + fresh context together | 2,048 tokens total | Prefer 1,024 essential checkpoint + up to 1,024 relevant context; reallocate within total, expand explicitly when required. |

Protected content wins over an arbitrary number. If essential constraints,
uncertainties or ownership checks do not fit, return a bounded “more required”
state and require expansion/selection before proceeding; never silently drop a
safety requirement to satisfy a token target. Larger caller budgets stay supported
for justified tasks; compact defaults must not turn complex modeling into guessing.

### 10.5 Summaries once, details by reference, changes incrementally

- Keep small structured checkpoint fields updated at meaningful task boundaries,
  using information the working agent already has. Do not repeatedly run another
  model over the full transcript just to generate essentially the same summary.
- Store a complete checkpoint locally, but send one essential destination view.
  JSON, Markdown and pasteable prompt are alternate renderings, not three copies
  injected together. Large manifests/diffs/test logs remain versioned references.
- Keep requirements, exceptions, failed attempts, verification status and the next
  action explicit. Existing prefix truncation is not semantic summarization and
  can remove a qualifier at the end of a memory. Prefer complete short entries
  and explicit omission over a fragment whose meaning may have changed.
- Checkpoints carry a parent revision and changed-field/file manifest. Within a
  destination session that acknowledged the baseline, send only changed material.
  A new Codex/Claude conversation gets a self-contained bootstrap: an unknown
  session must never receive a delta without its baseline.
- Use memory/library entry ID + content hash/version to avoid repeated unchanged
  content only when that recipient's acknowledged delivery ledger proves it still
  has the baseline. A host compaction/restart invalidates that assumption unless
  the adapter can verify retained context. Database presence alone proves nothing.
- Stable local retrieval caches may reuse computation, but recheck grants,
  revocation, content/alias revisions, archive state and identity. Cache keys must
  include project, authorized library/private scope set, query, budget, view and
  tokenizer/version. A cached payload still consumes input tokens if resent;
  a cache hit is not a token saving by itself.

Add a local cache only when measured repeated work justifies it; do not introduce
cache infrastructure by default. Review/distill a reusable technique once, store
its approved version and retrieve it many times instead of repeatedly asking a
model to re-extract the same lesson from the Midterm history.

### 10.6 Prompt caching and tool loading: conditional optimizations

Keep stable instructions/tool definitions in a stable order and volatile task
state later, where the host permits. Provider prefix caching is an additional
price/latency optimization, not a way to reduce the context window or transfer a
cache from Codex to Claude. Cache eligibility, writes, expiry and billing depend
on model/provider. An MCP server does not control the host's full prompt layout
or API cache options. Measure provider-reported cached input when available;
otherwise display unknown. See [research sources and limits](TOKEN_COST_RESEARCH.md).

Inventory the full input-schema/description cost before adding session, work,
library and handoff tools. Reuse narrow operations and concise descriptions. A
mega-tool with a huge action schema may cost more and be harder to use than a few
small tools; compare actual schema bytes/tokens and task success rather than
minimizing the number of tool names.

Use native deferred tool discovery only on hosts/versions where it is supported
and measured. MCP listing pagination alone does not mean a host defers schema
injection. Hiding tool names in instructions does not unload their schemas.
Keep a compatible static surface when dynamic discovery is unavailable. Do not
silently disable rarely used plugins based solely on invocation counts.

Avoid unnecessary independent model agents for routine heartbeat, retrieval,
formatting or handoff work. Optional expensive summarization/reranking needs a
demonstrated quality benefit and all added tokens/latency counted. Smaller models
are not automatically cheaper per successful task if retries or missing
constraints offset their unit price.

### 10.7 Measurement and release gates

Maintain separate measures for: retrieved content estimate, complete delivered
response/schema tokens, number of model-mediated calls, output/reasoning usage
where visible, provider cache reads/writes, local CPU/latency, and end-task success.
Use host/provider usage when exposed. Otherwise label billing unknown; do not
convert a local character estimate or subscription allowance into an exact bill.

For an API harness exposing billing, calculate uncached input + cached reads +
cache writes where separately billed + output/reasoning using that model's current
rates and accounting rules. Avoid double-counting inclusive fields. Subscription
clients may show usage/limits rather than marginal dollar costs. Compare **total
usage/cost per successfully completed task**, including follow-up calls and retries.

Use a fixed, independently judged workload with same host/model/settings and
revision: known-scope retrieval, cold and warm starts, SketchUp techniques with
project-detail exclusions, crowded same-tree ownership, two-way handoff, stale
files and long/multilingual identifiers. Compare current behavior with compact
delivery, progressive detail and cache-friendly ordering separately. Evaluate
cold/warm cache arms rather than crediting every gain to retrieval.

Release gates:

1. Zero model turns caused solely by routine heartbeat/renewal/hash maintenance.
2. Complete counted delivery meets its declared budget or explicitly reports that
   essential evidence needs expansion; cover metadata-heavy, Unicode, Tagalog,
   code, paths and large schema fixtures. Unknown tokenizers stay labeled estimates.
3. No lost safety/ownership constraint, unauthorized cross-project item, silently
   stale delta, unusable handoff or destructive default in regression fixtures.
4. Compare aggregate task success and required expansions with a predefined
   non-regression criterion; assess critical constraints separately with zero
   tolerated regression. No “fewer tokens = better” verdict on failed tasks.
5. Report p50/p95 delivered input, call count, completion latency and cost when
   measurable, plus measurement coverage. Do not declare a savings percentage
   before collecting those results.

Add cost-accounting/compact-view contracts in L0, implement deterministic session
coordination in B/C, progressive library retrieval in E and bounded baseline/delta
handoffs in F. Native prompt-cache/deferred-tool work belongs in G only after
verifying host support. This is a lean staged extension of the existing modules,
not permission to introduce another agent framework or parallel memory system.
