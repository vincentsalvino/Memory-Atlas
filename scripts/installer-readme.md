# Memory Atlas MCP

Install the release tarball with Node.js 24 or newer.

```text
npm install --global ./brainded-mcp-0.1.1.tgz
brain-mcp --check
brain-mcp --config
```

Add the generated `ai-brain` entry to your local MCP client and reconnect.
The command in the entry launches Brainded over stdio. In the client, call
`brain_status` to verify the connection. The default database lives at
`~/.brainded/brain.db`. Pass an absolute database path after `--check` or
`--config` to select an existing database.

npm installs the dependencies for your platform. The local embedding model is
downloaded on first semantic use and cached in `~/.brainded/models`. SQLite
storage and keyword lookup are available when embeddings are unavailable.
Set `BRAIN_MODEL_CACHE_DIR` to use a different cache, or set
`BRAIN_LOCAL_FILES_ONLY=1` to restrict model loading to the local cache.

## Updating

Install a newer project-produced tarball over this installation, then reconnect
your MCP clients. The configured database stays outside the package. Existing
databases are backed up before pending migrations run automatically on launch.
Use `brain-mcp --upgrade /absolute/database/path` for an explicit offline upgrade.
Older releases refuse a newer migration ledger rather than silently downgrading.
There is no background updater or postinstall database mutation.

For a verified published registry release, use `npm update --global brainded-mcp`.
This tarball does not itself establish or publish that registry release channel.

## Combining separate Brain databases

`brain-mcp --merge-db SOURCE --into TARGET` previews a read-only snapshot merge.
After reviewing it and stopping destination MCP writers, repeat with
`--apply --digest=PREVIEW_DIGEST`. A backup is created before import. Scopes,
provenance and conflicting versions are preserved; native chat memory is not
automatically imported. Shared database paths need no merge. Imported records
are keyword-searchable; `brain-mcp --reindex-db TARGET` rebuilds semantic indexes
using the local embedding model and may download weights unless restricted.
