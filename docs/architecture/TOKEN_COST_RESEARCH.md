# Token and cost research for portable Brain sessions

Research date: 2026-11-16. Planning evidence only; no production or host configuration changes. Sources are official OpenAI, Anthropic and MCP documentation. **Verified** denotes documented behavior; **inference** and **proposal** denote this project's reasoning and design choices. Prices, model support and host behavior must be rechecked when implementation starts.

## 1. Separate three different measurements

**Verified:** Anthropic distinguishes reducing loaded tool definitions, reducing intermediate tool-result history, and discounting repeated prompt content. Prompt caching reduces the price of reused context; it does not reduce the number of tokens occupying the context window. [Manage tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context).

**Proposal:** Track three separate quantities: Brain's estimated delivered tokens, host/provider total model usage, and actual monetary cost where available. A smaller Brain response is evidence of a smaller payload, not proof of an equal percentage reduction in the complete conversation or bill. A subscription allowance is not interchangeable with API token pricing.

**Verified local implementation:** `packages/core/token/src/estimator.ts` computes `ceil(text.length / 3)`. `optimize.ts` applies the estimator to selected context items. This is an application estimate, not a provider tokenizer or a measurement of the entire host prompt. The comment describing the estimate as never undercounting is not a demonstrated guarantee across languages and code.

**Proposal:** Record estimator identity and measure the final serialized response, including wrappers, identifiers, provenance and truncation metadata. Preserve existing item-budget meaning until an explicit contract change; expose any whole-response estimate separately. Never label estimated payload reduction as measured provider savings.

## 2. Caching needs an unchanged prefix and host cooperation

**Verified:** OpenAI cache reuse requires the entire rendered prefix to match, including relevant settings and tool definitions. A change before a breakpoint prevents reuse after the change. Caching is enabled by default for supported models, but eligibility and rates vary by model; current documentation includes distinct uncached-input, cached-input and cache-write pricing. Maintaining a session does not guarantee a cache hit. Compaction or truncation can change the prefix. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

**Verified:** Anthropic requires identical prompt segments through the cache-control block. Its documented default lifetime is five minutes; a one-hour option is available. The general pricing multipliers are 1.25× base input for a five-minute write, 2× for a one-hour write, and 0.1× for reads, with per-model exceptions. Cache-control placement, minimum lengths and platform support matter. [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

**Inference:** Keep tool descriptions, schema ordering and stable instructions deterministic; avoid embedding current timestamps or changing task state in otherwise stable instructions. Append changing checkpoint contents as task data. This helps preserve reusable prefixes when the host serializes them that way, but the server cannot guarantee placement or cache reuse.

**Integration limit:** These API request controls are not automatically controls exposed to an MCP server inside Codex, Claude Code or Claude Desktop. Brain can control its own schemas and responses. It must not claim it can set the host's cache breakpoints, retention policy, rendered prompt layout or pricing. Verify the installed host/version and observable usage before assigning a monetary benefit. Never add padding merely to cross a cache threshold.

## 3. Progressive discovery is useful, but the host owns model exposure

**Verified:** OpenAI's Responses API supports tool search by adding `tool_search` and marking functions or MCP server definitions with `defer_loading: true`. Its Agents API has different MCP discovery behavior. These are separate API integrations. Deferred discovery adds a step and depends on finding the relevant tool. [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search).

**Verified:** Claude Code documents native MCP tool search, including host configuration, platform limitations and upfront-loading exceptions. In threshold mode, definitions below 10% of the context window load upfront; tool search activates at the threshold. This is a documented host feature, not an instruction Brain can impose across clients. The documentation advises concise server instructions and searchable descriptions, with important content near the beginning. [Claude Code MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search).

**Verified:** MCP supports paginated tool discovery. Revision 2026-07-28 recommends deterministic ordering and forbids changing the available tool set per connection or as a side effect of other requests. It permits authorization-dependent variation. The protocol leaves the presentation interface to implementations. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

**Inference:** Paginating `tools/list` can reduce a single transport response, but a host may fetch every page and expose all schemas. Do not equate wire pagination with deferred model loading. Do not introduce session-state-driven tool visibility as a portable optimization. Check the negotiated protocol revision before relying on newer features.

**Proposal:** Keep a small, stable, well-described set of session operations. Reuse existing retrieval tools where possible. Avoid a generic operation dispatcher with many mutually exclusive argument shapes unless measurements show a clear benefit and tool selection remains reliable. Prefer host-native discovery when available; maintain ordinary MCP compatibility when it is absent. Do not write Codex-only or Claude-only Brain behavior.

## 4. Bound results before they enter conversation history

**Verified:** MCP tool results can include structured data, text and resource links; a linked resource can be fetched separately. The specification recommends also returning serialized text for backwards compatibility when using structured results. [MCP result formats](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-result).

**Verified:** Anthropic recommends lightweight references and loading relevant data on demand. It also warns that exploration adds latency and can waste context through poor tool use. [Context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents).

**Proposal:** Session lists should return IDs, labels, scope, state, freshness and a short next action. Fetch the selected checkpoint separately. Full transcripts, command output, diffs and detailed reasoning should stay out of default list and heartbeat responses. Use bounded snippets, explicit filters, stable cursors, `hasMore`/next-cursor signals and a separate details lookup. MCP's tool-list pagination does not automatically paginate application query results; define that response contract explicitly.

**Proposal:** Return compact mutation receipts and make diagnostics opt-in. Put large evidence behind references that the destination client can actually resolve; retain a text lookup fallback. Do not delete compatibility text merely to avoid duplication. Inspect what each target host puts into model context before claiming that structured data, annotations or resource links save tokens.

## 5. Handoff summaries must preserve recoverable evidence

**Verified:** Anthropic warns that aggressive compaction can lose subtle, critical context and recommends optimizing recall before pruning. It describes external notes as persistent state for long tasks. [Context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents).

**Verified:** OpenAI API compaction returns opaque encrypted state intended for subsequent API context; the returned compacted window should be passed onward intact. This is not a documented, readable cross-provider handoff format. [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction).

**Inference:** Portable Codex ↔ Claude continuation should use explicit public task state and resolvable evidence. Neither an API compaction object nor a model-written synopsis proves that the destination has inherited the original conversation, permissions or hidden reasoning.

**Proposal:** A checkpoint should preserve the objective, exact user constraints, decisions and reasons, verified changes, validation evidence, remaining work, blockers, ownership and resource references. Record revision, author/session, source freshness and omissions. Keep evidence addressable so a new agent can verify it. Refresh a summary from canonical state and evidence rather than repeatedly summarizing an earlier summary. Treat recommendations and unverified claims distinctly from completed work. On resume, compare workspace state and lease ownership before continuing.

## 6. Initial budgets and validation plan

The following are **proposed application-estimate targets**, not provider limits, benchmark results or savings promises:

| Response | Initial target | Expansion behavior |
| --- | ---: | --- |
| Search/session discovery | Up to 8 rows; 512 estimated tokens total | Filter or request the next page |
| Selected resume bootstrap | 2,048 estimated tokens including fresh context | Reallocate within the limit or explicitly expand when essential evidence requires it |
| Actionable ownership notice | 128 estimated tokens | Fetch conflict details only when needed |
| Routine heartbeat | Zero model calls / no model-facing receipt | Local runtime operation; diagnostics only on request |

The adopted planning targets are in [SESSION_CONTINUITY_PLAN.md, section 10](SESSION_CONTINUITY_PLAN.md#10-lean-architecture-and-token-cost-acceptance-contract): ordinary task context starts at 1,024 estimated tokens, with justified expansion to 2,048 and a proposed 4,096 ceiling. These numbers are proposed defaults to evaluate, not vendor limits or measured improvements.

Apply a whole-response target alongside row limits; long labels and identifiers can defeat a row-only limit. Prioritize current user constraints and immediate next steps. Return omitted-section indicators and references when bounded content does not fit; do not silently truncate a critical constraint. Avoid requiring a new heartbeat model call every turn: prefer existing operation piggybacking or a runtime mechanism whose conversation visibility is measured.

Evaluate these proposals on representative same-host and cross-host tasks: clean resume, stale workspace, conflicting edits, expired ownership, missing evidence and a critical constraint introduced early in the source chat. Compare total delivered bytes/estimated tokens, retrieval calls, latency, lost constraints, duplicate work and successful continuation. Where a host exposes provider usage, compare total input, cached reads/writes, output and actual cost across matched tasks. Include costs of discovery, checkpoint creation and failed lookups. Report payload improvements independently when full host billing data is unavailable; make no numerical savings claim without that evidence.
