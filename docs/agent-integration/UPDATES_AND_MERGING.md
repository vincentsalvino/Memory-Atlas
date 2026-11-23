# Updating Memory Atlas and consolidating Brain databases

Memory Atlas uses npm to replace application files, and the existing migration
runner to upgrade user data. There is no update daemon, background model call,
or install script that searches for databases and changes them without context.

## Install/update the packaged server

Build the portable release from this checkout:

```sh
npm run package:mcp
npm install --global ./.release/beanvincentcat-memory-atlas-0.2.1.tgz
brain-mcp --version
```

The distributable is **@beanvincentcat/memory-atlas**. The repository's private
workspace `@brain/mcp` is not the distributable. The unscoped `memory-atlas`
package belongs to another publisher. To replace the retired `brainded-mcp`
package, uninstall it, install Memory Atlas, and regenerate MCP configuration
using your existing absolute database path. Existing memories remain outside
the npm installation.

The verified registry release is
[`@beanvincentcat/memory-atlas`](https://www.npmjs.com/package/@beanvincentcat/memory-atlas). Install it with
`npm install --global @beanvincentcat/memory-atlas@0.2.1`; subsequent registry updates use
`npm update --global @beanvincentcat/memory-atlas`. Tarball installation remains available.
Do not install an unrelated similarly named package. npm updates
local dependencies within their semver ranges; a global update targets the
registry's wanted version. [npm update documentation](https://docs.npmjs.com/cli/v11/commands/npm-update/)

Configure harnesses once using the installed CLI's `--config`/`--setup` (including
`--format=toml` for Codex, `--model-cache=PATH` for `BRAIN_MODEL_CACHE_DIR`, and
`--replace` to preserve existing harness-specific fields and `env` keys), with the
**same absolute database path** and different `--harness-id` values. Generated
launch paths resolve `command` via `realpathSync(process.execPath)` so
`nvm-windows` symlinks stay locked to the installed `better-sqlite3` native ABI,
and point inside the installation rather than a version-numbered release folder.
Subsequent npm replacement of that same installation does not require choosing a
new database. Configurations pointing at a source checkout continue to run that
checkout; installing/updating a global package does not silently redirect them.

After global install or update, run:

```sh
brain-mcp --doctor
brain-mcp --install-skills --database=/absolute/path/brain.db
brain-visualize --status
```

`--doctor` audits Antigravity, Claude Code, and Codex configurations for split
databases, legacy `server.js` entrypoints, missing `--harness-id` flags, Node
runtime/ABI mismatches, and missing global skills. `--install-skills` installs
`/brain-visualize` and `/brain-merge` into each harness's global directory, and
`brain-visualize` (or `brain-mcp --visualize`) launches the packaged read-only
web UI directly without requiring a separate built git clone.

Reconnect Codex/Claude after replacing application files. A running process does
not hot-reload code. Persistent data remains outside the npm package at the
configured database path (`~/.brainded/brain.db` by default). `BRAIN_DB_PATH`
provides a CLI default; an explicit command-line path takes precedence.

## Automatic database upgrade

On the next MCP launch, pending numbered migrations are applied. For an existing
on-disk database, the runner first creates a consistent SQLite snapshot under
`.brain-backups` beside the database and prints its path on stderr. Backup failure
prevents migration. No backup is made on every ordinary startup or fresh database.
SQLite's `VACUUM INTO` includes committed WAL state; copying only a live `.db` file
is not equivalent. [SQLite backup snapshot behavior](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)

To apply migrations explicitly without starting MCP or loading embeddings:

```sh
brain-mcp --upgrade /absolute/path/brain.db
```

Each migration and ledger entry is transactional. Multiple starting harnesses
recheck the ledger under a write lock. An unknown newer schema is refused rather
than silently opened for writes by an older release. If a later migration fails,
that migration rolls back; earlier committed migrations remain recorded and the
next compatible attempt can resume. Backups are retained, not automatically purged.

Rollback is explicit: stop all writers, preserve the current database, and choose
a compatible application/database snapshot pair. Do not overwrite a live database
or discard new memories by automatically restoring an older snapshot. Restore
procedures must account for SQLite WAL/SHM files; keep the original database and
its sidecars together while it is closed, and restore to a fresh path first.

## Preview a memory merge

Codex and Claude on this PC already use one Brain database. **No merge is needed
for two configurations pointing at that same file.** They share project knowledge
through their existing scopes. The command below is for genuinely separate Brain
databases, including older installations:

```sh
brain-mcp --merge-db /path/claude-brain.db --into /path/shared-brain.db
```

Both paths must exist. The default operation is read-only: it reports additions,
unchanged records, conflicting IDs kept separately and a digest. It does not
print memory text. Source databases are never migrated or written. Existing
project IDs, global/project/session scopes, harness-private scopes, status,
timestamps, tags and source provenance are retained.

Stop Brain MCP processes using the destination. After reviewing the preview:

```sh
brain-mcp --merge-db /path/claude-brain.db --into /path/shared-brain.db --apply --digest=THE_PREVIEW_DIGEST
```

Apply refuses stale previews or a destination with a fresh recorded MCP heartbeat.
Older/unintegrated writers may not record heartbeats, so stop those too. It takes
a destination snapshot, rechecks under a write transaction and inserts the import
with an audit entry. The source stays intact. Repeating an unchanged import is
idempotent. File aliases/hardlinks pointing at the same database are rejected.

Same-ID divergent revisions are kept under deterministic new IDs; existing target
records are never overwritten. `supersedes` links are remapped to the matching
imported revision. A revision collision with an edited previous import or an
invalid/cyclic source lineage is refused for explicit resolution. This is a
snapshot merge, not ongoing synchronization or an automatic semantic deduplicator.
Identical text from different records is not sufficient reason to erase provenance.

This merges memory records and their lineage, not raw conversation transcripts,
code indexes, feedback/outcome history or learning counters. Original event history
remains in the source database; importing it without verified identity/context
mapping could fabricate evidence. Imported memories become keyword-searchable
immediately through the existing FTS triggers.

## Rebuild semantic indexes when needed

Source vectors are not copied blindly: equal vector dimensions do not prove two
databases used the same embedding model. For semantic retrieval after import:

```sh
brain-mcp --reindex-db /path/shared-brain.db
```

This uses the configured local embedding provider and reports indexed/failed
counts. Model weights may download on first use; set `BRAIN_LOCAL_FILES_ONLY=1`
to require an existing cache. Failed indexing leaves memory content intact and
keyword retrieval available. Reindex only current active revisions; content
changed during embedding is skipped rather than indexed with stale vectors.

## Native harness memory mirroring (opt-in)

An application update never imports native memory files automatically. When you
explicitly want Claude Code, Codex, and Antigravity to cross-reference each
other's native memories without modifying any native files or mixing them with
Brain-authored entries, run the read-only mirror command:

```sh
brain-mcp --sync-native /path/shared-brain.db --dry-run
brain-mcp --sync-native /path/shared-brain.db
brain-mcp --sync-native /path/shared-brain.db --watch
```

Mirrored items are written as dedicated `origin: "import"` records with
`sourceRef: "native-mirror:<harness>:..."` and tags
`["native-mirror", "native-authoritative", "native-source:<harness>"]`. Native
files are never modified and remain authoritative: edits at the native source
update or supersede the mirrored entry, deletions soft-archive only the mirror,
and existing Brain-authored memories are untouched. An automatic `VACUUM INTO`
backup is taken before any write. Raw conversation transcripts are never
imported.
