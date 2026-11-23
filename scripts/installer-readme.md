# Memory Atlas MCP

Install the release tarball or npm package with Node.js 24 or newer.

```text
npm install --global @beanvincentcat/memory-atlas
brain-mcp --check
brain-mcp --config --harness-id=antigravity --model-cache=~/.brainded/models
brain-mcp --config --harness-id=codex --format=toml --model-cache=~/.brainded/models
brain-mcp --doctor
```

Add the generated `ai-brain` entry to your local MCP client (or run `brain-mcp --setup`)
and reconnect. The command in the entry launches Memory Atlas over stdio and pins
`command` via `realpathSync(process.execPath)` so `nvm-windows` symlinks cannot diverge
from the installed `better-sqlite3` native ABI. In the client, call `brain_status` to
verify the connection. The default database lives at `~/.brainded/brain.db`. Pass an
absolute database path after `--check` or `--config` to select an existing database.

npm installs the dependencies for your platform. The local embedding model is
downloaded on first semantic use and cached in `~/.brainded/models`. SQLite
storage and keyword lookup are available when embeddings are unavailable.
Pass `--model-cache=PATH` to `--config` / `--setup` (or set `BRAIN_MODEL_CACHE_DIR`)
to share a specific cache directory across harnesses, or set
`BRAIN_LOCAL_FILES_ONLY=1` to restrict model loading to the local cache.

## Visualizer and global skills

The npm package includes the read-only Memory Atlas web UI and launcher:

```text
brain-visualize --foreground
brain-mcp --visualize --status
brain-mcp --install-skills --database=/absolute/path/brain.db
```

`--install-skills` writes global `/brain-visualize` and `/brain-merge` commands into
Antigravity (`~/.gemini/config/skills/`), Claude Code (`~/.claude/commands/`), and
Codex (`~/.codex/skills/`) with absolute paths to the installed runtime and database.

## Auditing and updating

Run `brain-mcp --doctor` to inspect Antigravity, Claude Code, and Codex configs,
verify they target a single shared database and matching Node runtime, flag missing
`--harness-id` arguments, and detect split legacy databases or missing global skills.

Install a newer project-produced tarball over this installation, then reconnect
your MCP clients. The configured database stays outside the package. Existing
databases are backed up before pending migrations run automatically on launch.
Use `brain-mcp --upgrade /absolute/database/path` for an explicit offline upgrade.
Older releases refuse a newer migration ledger rather than silently downgrading.
There is no background updater or postinstall database mutation.

Use `npm update --global @beanvincentcat/memory-atlas` for registry updates.
The unscoped `memory-atlas` package belongs to another publisher. The former
`brainded-mcp` package is retired; uninstall it before switching to this package,
then regenerate MCP configuration using your existing absolute database path.

## Combining separate Brain databases

`brain-mcp --merge-db SOURCE --into TARGET` previews a read-only snapshot merge.
After reviewing it and stopping destination MCP writers, repeat with
`--apply --digest=PREVIEW_DIGEST`. A backup is created before import. Scopes,
provenance and conflicting versions are preserved; native chat memory is not
automatically imported. Shared database paths need no merge. Imported records
are keyword-searchable; `brain-mcp --reindex-db TARGET` rebuilds semantic indexes
using the local embedding model and may download weights unless restricted.

## Opt-in native harness memory mirroring

`brain-mcp --sync-native [DATABASE] [--dry-run] [--watch]` mirrors native
harness memories (Claude Code, Codex, Antigravity, or `--source=NAME:PATH`)
strictly read-only into dedicated `native-mirror:*` entries without modifying
native files or existing Brain-authored memories. Native files remain
authoritative: edits update or supersede their mirrored entries, deletions
soft-archive only the mirror, and a backup snapshot is taken before any write.
