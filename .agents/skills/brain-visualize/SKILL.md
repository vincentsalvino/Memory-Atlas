---
name: brain-visualize
description: Launch or inspect the read-only Memory Atlas visualizer web UI for the shared Brain database and open it at http://localhost:4173.
---

# Brain Visualizer (`/brain-visualize`)

Start (or reuse) the read-only Memory Atlas visualizer server and open it so the user can inspect the memory graph, context deliveries, harness usage rankings, and workflow overview.

## Steps

1. Run the launcher script from the Memory Atlas repository root (or pass its absolute path when installed globally):

   ```sh
   npm run visualize
   ```

   Or invoke directly with optional flags:

   ```sh
   node scripts/launch-visualizer.mjs [--db <path>] [--port <port>] [--no-open] [--status] [--stop]
   ```

   - `--db <path>` — inspect a specific SQLite database (defaults to `data/brain.db`)
   - `--port <port>` — override port (defaults to `4173`)
   - `--no-open` — start/check the server without opening the system browser
   - `--status` — check if the visualizer is running and print live stats
   - `--stop` — cleanly stop the managed background visualizer server

2. Parse the JSON output and report back concisely:
   - Clickable URL (e.g. `http://localhost:4173`)
   - Whether the server was freshly started or already running
   - Live overview counts (`memoriesActive` / `memoriesTotal`, `contexts`, `runtimeInstances`, `vectorSearchAvailable`)
   - If the user wants to inspect it inside the agent's browser UI, open the URL with the browser tool.

The visualizer opens SQLite in driver-enforced read-only mode and never modifies `brain.db`.
