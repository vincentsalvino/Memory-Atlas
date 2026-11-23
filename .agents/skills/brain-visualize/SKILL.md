---
name: brain-visualize
description: Launch or inspect the read-only Memory Atlas visualizer web UI for the shared Brain database and open it at http://localhost:4173.
---

# Brain Visualizer (`/brain-visualize`)

Start (or reuse) the read-only Memory Atlas visualizer server and open it so the user can inspect the memory graph, context deliveries, harness usage rankings, and workflow overview.

## Steps

1. Start the launcher in `--foreground` mode as a **long-running background daemon** (`IsDaemon: true` in Antigravity, or background shell task in Claude Code / Codex) so the host process manager does not reap the HTTP server on exit:

   From a repository checkout:
   ```sh
   node scripts/launch-visualizer.mjs --foreground
   ```

   Or from a global `@beanvincentcat/memory-atlas` npm install:
   ```sh
   brain-visualize --foreground
   ```
   (Equivalent to `brain-mcp --visualize --foreground`. Run `brain-mcp --install-skills` to install absolute-path copies of `/brain-visualize` and `/brain-merge` into global Antigravity, Claude Code, and Codex directories.)

   *(If the visualizer is already running on port 4173, the launcher automatically reuses it, opens the URL, prints the JSON status, and exits cleanly.)*

   Pass through any optional flags requested by the user:
   - `--db <path>` — inspect a specific SQLite database (defaults to configured harness DB, `data/brain.db`, or `~/.brainded/brain.db`)
   - `--port <port>` — override port (defaults to `4173`)
   - `--no-open` — start/check the server without opening the system browser
   - `--status` — check if the visualizer is running and print live stats (normal non-daemon call)
   - `--stop` — cleanly stop the running visualizer server (normal non-daemon call)

2. Report back concisely using the printed JSON output:
   - Clickable URL (e.g. `http://localhost:4173`)
   - Whether the server was freshly started or already running
   - Live overview counts (`memoriesActive` / `memoriesTotal`, `contexts`, `runtimeInstances`, `vectorSearchAvailable`)

The visualizer opens SQLite in driver-enforced read-only mode and never modifies `brain.db`.
