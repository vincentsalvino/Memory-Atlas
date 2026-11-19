---
name: brain-merge
description: Non-destructively mirror native harness memories (Claude Code, Codex, Antigravity) into dedicated, authoritative entries in the shared Memory Atlas database without modifying native files or mixing them with Brain-authored memories.
---

# Brain Native Memory Auto-Sync (`/brain-merge`)

Mirror native harness memories into the shared Memory Atlas SQLite database so every connected harness (Claude Code, Codex, Antigravity) can retrieve them without altering or conflicting with any harness's native memory store.

## Guarantees
- **Strictly read-only on native sources**: never edits, moves, or deletes files in `~/.claude/`, `~/.codex/`, or `~/.gemini/`.
- **Dedicated entries (no mixing)**: mirrors are stored as separate `origin: "import"` records with `sourceRef: "native-mirror:<harness>:..."` and tags `["native-mirror", "native-authoritative", "native-source:<harness>"]`. Existing Brain-authored memories are never modified or overwritten.
- **Native priority**: edits at the native source update or supersede the mirrored row; deletions at the native source soft-archive the mirrored row.
- **Safe & idempotent**: takes an automatic `VACUUM INTO` backup before any write; unchanged re-runs perform zero writes.

## Steps

1. Run the native sync command from the Memory Atlas repository root (or using `brain-mcp` when installed globally):

   ```sh
   npm run sync:native
   ```

   Or invoke directly with optional flags:

   ```sh
   node packages/mcp/dist/cli.js --sync-native data/brain.db [--dry-run] [--watch] [--harness=<name>] [--source=<name>:<path>] [--no-embed]
   ```

   - `--dry-run` — preview what would be added, updated, superseded, or archived without writing
   - `--watch` — keep watching native memory folders and auto-sync changes live
   - `--harness=<name>` — limit sync to specific harness(es) (`claude-code`, `codex`, `antigravity`), repeatable
   - `--source=<name>:<path>` — include an additional custom harness markdown directory, repeatable
   - `--no-embed` — skip local vector embedding (lexical FTS5 search still updates immediately)

   *(If the user instead asks to merge two separate Brain `.db` files, run `brain-mcp --merge-db <source.db> --into <target.db>` to preview first, then `--apply --digest=<hash>` after confirmation.)*

2. Parse the JSON result and report:
   - Scanned harnesses and total discovered native memories
   - Counts of `added`, `updated`, `superseded`, `archived`, `unchanged`, and `embedded`
   - Any `warnings` and the `backup` snapshot path (if mutations occurred)
   - Confirm that native harness files were untouched and existing Brain memories were preserved.
