# Memory Atlas

**Give your coding agents shared memory that lasts beyond a single conversation.**

Memory Atlas is a local memory and
context server for AI coding agents. It uses the Model Context Protocol (MCP) to
help agents save useful project knowledge, retrieve it in later sessions, and
share it across compatible clients through one SQLite database.

The purpose is simple: spend less time explaining the same project decisions
and give each new session a better starting point.

[Why it exists](#why-it-exists) · [What it does](#what-it-does) ·
[Getting started](#getting-started) · [Feedback](#try-it-and-share-feedback) ·
[Documentation](docs/README.md)

## Public release

Memory Atlas is available on npm as
[`@beanvincentcat/memory-atlas`](https://www.npmjs.com/package/@beanvincentcat/memory-atlas):

```sh
npm install --global @beanvincentcat/memory-atlas@0.2.0
npm update --global @beanvincentcat/memory-atlas
```

Reconnect MCP clients after updating. Keep their existing absolute database paths
so both harnesses continue to share the same stored memories.

Download the installer, checksum and dependency-audit snapshot from
[Memory Atlas v0.2.0](https://github.com/vincentsalvino/Memory-Atlas/releases/tag/v0.2.0).
Verify the tarball with the accompanying `MEMORY-ATLAS-SHA256SUMS.txt`, then install:

```sh
npm install --global ./beanvincentcat-memory-atlas-0.2.0.tgz
brain-mcp --version
brain-mcp --config
```

On Linux, use `sha256sum --check MEMORY-ATLAS-SHA256SUMS.txt`. In PowerShell, use
`Get-FileHash .\beanvincentcat-memory-atlas-0.2.0.tgz -Algorithm SHA256` and compare
the value with `MEMORY-ATLAS-SHA256SUMS.txt`. Download both from the official release page.
Use the scoped npm name above: the unscoped `memory-atlas` belongs to another
publisher. The earlier `brainded-mcp` package is retired. To switch, uninstall it
with `npm uninstall --global brainded-mcp`, install Memory Atlas, and regenerate
MCP configuration with `brain-mcp --config` and your existing database path.

## Security and data safety

Release packages contain the server, database migrations, README and a locked
production dependency graph; they exclude local databases, credentials, host
configuration and private planning notes. Packaging audits the runtime dependency
graph and blocks known high/critical advisories. The release includes SHA-256
checksums and an audit snapshot. These checks reduce risk; they do not establish
that software is free of vulnerabilities or independently signed.

Your database remains outside the installed package. Upgrades snapshot existing
data before pending migrations, and memory merging requires a reviewed preview.
Neither operation automatically imports native Codex/Claude memory. Harness
isolation is enforced at the Brain API; local users/processes with filesystem
access and the read-only visualizer can inspect all records. Database/backups
are not encrypted by Memory Atlas: protect their location and access permissions.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities privately, release
verification and the trust model, and the
[update/merge guide](docs/agent-integration/UPDATES_AND_MERGING.md) for backups,
rollback and safe consolidation.

## Why it exists

A project's useful context grows over time: architecture decisions, conventions,
constraints, and lessons from difficult bugs. That knowledge can get scattered
across conversations, especially when you switch sessions or coding agents.

Memory Atlas gives agents a shared place to keep that knowledge and retrieve
the parts relevant to the next task. For example, an agent can save why a service
uses a particular storage boundary; a later session can retrieve that decision
before making a change that touches the same service.

It complements an agent's native memory. Agents explicitly choose what to save;
the server does not automatically import conversation histories. Retrieved
memories are supporting evidence: current code and your instructions take
precedence.

## What it does

| Capability | Purpose |
| --- | --- |
| Persistent project knowledge | Store decisions, constraints, facts, and reusable patterns across sessions. |
| Shared MCP access | Let compatible clients use the same tools and database contract. |
| Scoped memories | Organize knowledge by project, session, or genuinely global relevance. |
| Relevant retrieval | Combine keyword and semantic search to find useful memories. |
| Bounded context | Compile ranked context within a requested token budget, including code and dependency context when the project has indexed code. |
| Feedback and outcomes | Record which delivered memories helped and how the task ended. |
| Opt-in native mirroring | Mirror native harness memories (Claude Code, Codex, Antigravity) read-only into dedicated, authoritative entries via `--sync-native` or `/brain-merge`. |
| Read-only visualizer | Inspect memories, context deliveries, and workflow activity in a local web UI (`npm run visualize` or `/brain-visualize`). |

The default server uses SQLite and local embeddings. The first semantic operation
can download model weights. Feedback and outcome recording are available today;
production learning and near-duplicate handling are enabled with independent rollback controls.
See [harness setup and usage tracking](docs/agent-integration/HARNESS_SETUP.md) for
private project scopes, automatic JSON configuration setup, skill/plugin reporting,
and honest runtime status.

## How agents use it

1. **Retrieve context** before substantive work, using the task description,
   project scope, and a token budget.
2. **Work against the current repository**, checking retrieved knowledge against
   the code and your instructions.
3. **Report useful context and the outcome**, linked to the original delivery.
4. **Save durable findings** when there is something new worth remembering.

Trivial edits do not need this workflow. The shared
[agent protocol](docs/agent-integration/AGENT_BRAIN_PROTOCOL.md) explains the
contract in full.

## Getting started

Use **Node.js 24 or newer** and npm. For a fresh checkout:

```sh
git clone https://github.com/vincentsalvino/Memory-Atlas.git
cd Memory-Atlas
npm ci
npm run check
```

`check` builds the workspaces in dependency order, checks server and UI types,
and runs the default tests. These tests use fixtures and temporary databases;
they do not need the local `data/brain.db` or optional reference repositories.
Installing dependencies requires network access. Model integration tests are
separate because they can download embedding weights.

## Run the MCP server

After building, run:

```sh
npm run mcp
```

This opens or creates `data/brain.db` and applies the database migrations. The
server uses stdio, so it normally runs as a subprocess of your MCP client. Use
absolute paths when configuring a client that may start outside this directory:

```json
{
  "mcpServers": {
    "ai-brain": {
      "command": "node",
      "args": [
        "/absolute/path/to/ai-brain/packages/mcp/dist/server.js",
        "/absolute/path/to/ai-brain/data/brain.db"
      ]
    }
  }
}
```

Point clients at the same database to share memories. Use project scopes to
isolate project-specific knowledge. Read the
[agent protocol](docs/agent-integration/AGENT_BRAIN_PROTOCOL.md) and
[workflow policy](docs/agent-integration/BRAIN_WORKFLOW_POLICY.md) before using
the `brain_*` tools.
The [client setup guide](docs/agent-integration/CLIENT_SETUP.md) covers Codex,
ChatGPT, Claude Code, and other MCP hosts.

After connecting, ask your agent to call `brain_status` to verify the connection.
Then try a real task with a stable project scope, such as
`{ "kind": "project", "id": "my-project" }`. Clients sharing knowledge about
that project should use the same project ID and database path. The server ships
as a local stdio process; hosted clients need a suitable connection to reach it.

### Available tools

| Tool | What it does |
| --- | --- |
| `brain_context` | Build a ranked context pack within a token budget. |
| `brain_search` | Search for ranked memory candidates. |
| `brain_recall` | Look up memories directly by ID or filter. |
| `brain_remember` | Save a new memory. |
| `brain_update` | Revise or archive an existing memory. |
| `brain_forget` | Archive a memory through a soft delete. |
| `brain_feedback` | Report whether a delivered memory was useful. |
| `brain_record_outcome` | Record a task's result against its context delivery. |
| `brain_status` | Check server health and capabilities. |
| `brain_project` | Confirm a project scope and its memory count. |
| `brain_usage` | Report an observed skill/plugin lifecycle event, labeled as self-reported. |
| `brain_tool_rankings` | Rank observed Brain calls and reported skills/plugins for the configured harness. |

## Open the Memory Atlas visualizer

Once the MCP server has initialized the database:

```sh
npm run dev
```

Vite prints the development URL. The visualizer opens the repository's
`data/brain.db` read-only. Set `BRAIN_DB_PATH` to inspect another database.
For a production build, run `npm run build`, then start it from the root:

```sh
node packages/visualizer/dist/server/server.js data/brain.db
```

The production server defaults to port 4173; `PORT` overrides it.

To launch (or reuse) the production read-only visualizer in the background and
open it from any workspace or agent chat (via `/brain-visualize`):

```sh
npm run visualize
node scripts/launch-visualizer.mjs --status
node scripts/launch-visualizer.mjs --stop
```

## Mirror native harness memories (`/brain-merge`)

Harnesses configured with the same database path already share `brain_*`
memories directly. To also make native harness memories (Claude Code
`~/.claude/projects/*/memory/*.md`, Codex `~/.codex/memories*`, Antigravity
`~/.gemini/antigravity/knowledge/`) searchable across harnesses without editing
native files or mixing them with Brain-authored entries:

```sh
npm run sync:native -- --dry-run
npm run sync:native
npm run sync:native -- --watch
```

Native files remain strictly read-only and authoritative: mirrored rows carry
dedicated `native-mirror:<harness>:*` provenance and `native-authoritative`
tags, update or supersede when their native source changes, soft-archive if
deleted at the source, and never overwrite existing Brain memories. An automatic
backup is written before any mutation. See
[updates and memory merging](docs/agent-integration/UPDATES_AND_MERGING.md) for
full details.

## Repository layout

```text
packages/
  core/             Contracts, memory, retrieval, ranking, context, token
                    budgeting, compression, learning, and test fixtures
  storage/          SQLite repositories, embeddings, migrations, DB merge, and native sync
  codebase/         File discovery, indexing, and dependency graph
  gateway/          Client-independent orchestration
  knowledge/        Seed validation, import, and query helpers
  evaluation/       Datasets, evaluation gates, and pilot harnesses
  mcp/              MCP stdio adapter, CLI, and composition root
  visualizer/       Read-only HTTP API, shared types, and React UI
.agents/skills/     Portable agent slash-command skills (/brain-visualize, /brain-merge)
scripts/            Visualizer launcher, npm release packager, and smoke tests
docs/
  architecture/     Architecture, plans, and package-boundary references
  agent-integration/ Shared agent protocol, setup, merging, and workflow policy
  archive/          Historical audits, phase plans, and reports
data/               Local runtime databases (ignored by Git)
.github/workflows/  Continuous integration
```

Production code and its unit tests stay together under each package's `src/`.
Generated `dist/`, `dist-test/`, model caches, local configuration, and databases
are excluded from Git.

See the [documentation index](docs/README.md) for design references and
[CONTRIBUTING.md](CONTRIBUTING.md) for package rules, checks, and optional tests.

For a reproducible local storage/retrieval/workflow audit, run
`npm run validate:brain -- --db <absolute-db-path> --out <new-results-directory>`.
See the [validation runner](packages/evaluation/validation/README.md) and
[ranked direction and test plan](docs/architecture/BRAIN_EVIDENCE_PLAN.md).

## Install Brain on another device

See [updates and memory merging](docs/agent-integration/UPDATES_AND_MERGING.md)
for npm-based release replacement, automatic backup/migration on reconnect,
and previewed consolidation of separate Codex/Claude Brain databases.

Build an npm tarball with `npm run package:mcp`. Copy the resulting
`.release/beanvincentcat-memory-atlas-0.2.0.tgz` to a device with Node.js 24 or newer.
To keep an existing artifact, pass a different output directory with
`npm run package:mcp -- <output-directory>`.

```sh
npm install --global ./beanvincentcat-memory-atlas-0.2.0.tgz
brain-mcp --check
brain-mcp --config
```

Add the generated entry to your MCP client and reconnect. The CLI uses
`~/.brainded/brain.db` by default. Pass an absolute database path after
`--config` to use a different database. The tarball includes the server and
database migrations. npm resolves runtime dependencies for the device. The
first semantic operation can download the model to `~/.brainded/models`.

## Try it and share feedback

**Consider trying Memory Atlas on a real project and sharing your feedback.**
Connect your coding agent, save a useful project decision, and see whether a
later session retrieves it when it matters.

What was helpful? What felt confusing? Did the retrieved context miss something
important or include something irrelevant? Reports about setup, retrieval
quality, and the visualizer help guide the project's direction.

[Open an issue](https://github.com/vincentsalvino/Memory-Atlas/issues) with your
feedback, a bug report, or an idea. Include your MCP client, relevant setup
details, and what you expected versus what happened. Use a minimal example
without private project data.
