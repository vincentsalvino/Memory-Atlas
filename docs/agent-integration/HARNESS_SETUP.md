# Connect harnesses to shared project knowledge

Build with `npm ci` and `npm run build` (Node 24+). Each harness launches its own
stdio process against the **same absolute database path**. Use the same project
ID across harnesses. Configure identity on the command line:

```sh
brain-mcp /absolute/path/brain.db --harness-id=antigravity
brain-mcp --config /absolute/path/brain.db --harness-id=codex
```

For a source checkout replace `brain-mcp` with
`node /absolute/path/ai-brain/packages/mcp/dist/cli.js`.

## Repeatable JSON and Codex TOML configuration setup

For hosts accepting an `mcpServers` JSON object or Codex's `[mcp_servers.ai-brain]` TOML table:

```sh
brain-mcp --setup /absolute/path/mcp.json --harness-id=antigravity --database=/absolute/path/brain.db --model-cache=/absolute/path/models
brain-mcp --setup ~/.codex/config.toml --harness-id=codex --database=/absolute/path/brain.db --model-cache=/absolute/path/models --format=toml --replace
brain-mcp --undo-setup /absolute/path/mcp.json
```

The containing directory must exist. Setup preserves other settings, writes a
sibling `.brain-setup.json` undo record, and is a no-op when repeated with the
same entry. `--format=json|toml` overrides format auto-detection (`.toml` files
default to TOML). `--model-cache=PATH` emits `env.BRAIN_MODEL_CACHE_DIR`, and
`command` resolves through `realpathSync(process.execPath)` so `nvm-windows`
symlinks stay locked to the installed `better-sqlite3` native ABI.

An existing different `ai-brain` entry is refused unless `--replace` is supplied.
On `--replace`, harness-specific fields (`type: "stdio"`, `disabled: false`,
timeouts, etc.) and existing `env` keys are preserved and merged; undo restores
that prior entry. Undo refuses to overwrite a Brain entry changed after setup,
and preserves unrelated concurrent configuration edits. Keep the backup until you
no longer need undo. Protect it like the configuration.

For unsupported config formats, use the host's registration mechanism with the
command/args printed by `--config [--format=json|toml] [--model-cache=PATH]`.
Run `brain-mcp --doctor` to audit all known harness configs, Node runtime/ABI
alignment, global skills, and split databases. Reconnect the host and call
`brain_status`. Then call `brain_context` and verify the event's harness label in
the visualizer. Setup does not prove the host has reconnected; that requires the
verification call.

## Shared and private memory

Shared: `{ "kind": "project", "id": "my-project" }`.

Private to a configured harness in that project:
`{ "kind": "project", "id": "harness:codex:my-project" }`.
Encode each component with `encodeURIComponent` when it contains punctuation
such as `:`. `privateProjectScope()` in `@brain/contracts` constructs the ID.
The `harness:` prefix is reserved; malformed IDs are rejected.

Use explicit scopes on writes. Context and search for a shared project blend
shared knowledge, global knowledge, and the caller's private project memories
before ranking and budgeting. Direct recall uses its explicit scope. A different
or unidentified harness cannot query or mutate a private scope, even by supplying
its exact ID. Identified feedback must reference its own delivery and a memory
actually included in that delivery. Unlinked legacy feedback is limited to
global memories. Session scopes retain their existing caller-supplied semantics.

Launcher configuration is trusted local infrastructure. No repository identity
file is read. A process able to edit the launcher configuration or directly open
the SQLite file is privileged and can bypass this API boundary. The read-only
visualizer is an administrator inspector across all harnesses, not a private
harness endpoint. Native harness memory is never imported or synchronized.

## Skill and plugin identifiers

The MCP server automatically records **handled Brain calls**, success/failure,
and full handler duration. SDK validation failures occurring before a handler are
not counted. Other tools' activity is unknown until a cooperating agent or hook
reports it through `brain_usage`:

```json
{
  "kind": "skill",
  "identifier": "code-review@1",
  "stage": "loaded",
  "projectId": "my-project",
  "success": null,
  "durationMs": null
}
```

Use `kind: "plugin"` for plugins. Stages are `installed`, `exposed`, `loaded`,
and `invoked`; report an actual lifecycle event once, not every time inventory
is polled. Include version/provider in the identifier to distinguish packages.
Use `success: null` when a result is unknown. Calls are labeled `reported`,
distinct from automatically `observed` Brain invocations.

Call `brain_tool_rankings` for your launcher's rankings, or filter the visualizer
by kind, harness and stage. All stored history is retained; results show up to
200 groups. Counts indicate frequency, not independent quality or token cost.
The server cannot inspect another MCP server's calls or a host's hidden prompt.
No external harness hook or Marketplace API is assumed to exist. Add a supported
hook only after verifying its contract. Without cooperation, external skills and
plugins remain unobserved. No tool is disabled automatically, and no reduction
in prompt loading or cost is claimed. Use the rankings to investigate unused
capabilities in the host's own settings, retaining on-demand discovery.

## Learning, redundancy and rollback

Production defaults enable both existing policies. Set either environment value
to `false` or `0` in the MCP launcher's environment and restart to disable it:

```text
BRAIN_LEARNING_ENABLED=false
BRAIN_REDUNDANCY_ENABLED=false
```

Only `true`, `false`, `1`, and `0` are accepted. The shared contract baseline
remains disabled for isolated consumers/tests; the production composition root
resolves these overrides. Learning retains k=5, outcomeWeight=0, maxBoost=0.15.
Redundancy thresholds remain unchanged. This is retrieval-time reranking, not
model training, memory deletion, or automatic lifecycle changes.

The MCP server records per-instance settings and heartbeats every 30 seconds.
After 90 seconds without a heartbeat, an instance is excluded. The visualizer
reports unknown/mixed when no fresh instance exists or settings disagree, and
never reads its own environment as proof of MCP state. Reload to refresh.

Keep additive migration columns/tables on application rollback. Do not drop
columns from the live database. Remove a generated setup entry with `--undo-setup`
only after confirming it is the intended host configuration.

## Chat slash commands (`/brain-visualize` and `/brain-merge`)

Portable skills live in `.agents/skills/brain-visualize/SKILL.md` and
`.agents/skills/brain-merge/SKILL.md`:

- `/brain-visualize` launches (or reuses) the read-only production visualizer via
  `brain-visualize` / `brain-mcp --visualize` (or `scripts/launch-visualizer.mjs`
  in a checkout) and opens `http://localhost:4173` (supports `--db`, `--port`,
  `--no-open`, `--status`, and `--stop`).
- `/brain-merge` runs `brain-mcp --sync-native` to mirror native harness memories
  (Claude Code, Codex, Antigravity) read-only into dedicated, non-conflicting
  `native-mirror:*` entries in the shared database (supports `--dry-run`,
  `--watch`, `--harness=<name>`, `--source=<name>:<path>`, and `--no-embed`).

To install both commands globally with absolute paths for any project chat, run:

```sh
brain-mcp --install-skills [--harness=antigravity,claude-code,codex] [--database=/absolute/path/brain.db]
```

This writes the global skill/command files into `~/.gemini/config/skills/`,
`~/.claude/commands/`, and `~/.codex/skills/`.
