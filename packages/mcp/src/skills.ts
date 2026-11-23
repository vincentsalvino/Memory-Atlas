import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeCommand, resolveUserPath } from "./setup.js";

export const SUPPORTED_SKILL_HARNESSES = ["antigravity", "claude-code", "codex"] as const;
export type SkillHarness = (typeof SUPPORTED_SKILL_HARNESSES)[number];

export interface InstallSkillsOptions {
  dbPath: string;
  harnesses?: string[];
  homeDir?: string;
  nodeCommand?: string;
  cliPath?: string;
}

export interface InstallSkillsResult {
  dbPath: string;
  nodeCommand: string;
  cliPath: string;
  harnesses: SkillHarness[];
  installedFiles: string[];
}

export interface GlobalSkillStatus {
  harness: SkillHarness;
  visualizePath: string;
  visualizeInstalled: boolean;
  mergePath: string;
  mergeInstalled: boolean;
}

function normalizeHarnesses(input?: string[]): SkillHarness[] {
  if (!input || input.length === 0) {
    return [...SUPPORTED_SKILL_HARNESSES];
  }
  const expanded = input
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (expanded.length === 0) {
    throw new Error(`--harness requires one or more of: ${SUPPORTED_SKILL_HARNESSES.join(", ")}`);
  }
  const unique: SkillHarness[] = [];
  for (const name of expanded) {
    if (!(SUPPORTED_SKILL_HARNESSES as readonly string[]).includes(name)) {
      throw new Error(`Unsupported harness "${name}". Supported: ${SUPPORTED_SKILL_HARNESSES.join(", ")}`);
    }
    const typed = name as SkillHarness;
    if (!unique.includes(typed)) unique.push(typed);
  }
  return unique;
}

function skillPathsForHarness(harness: SkillHarness, homeDir: string): { visualizePath: string; mergePath: string } {
  if (harness === "antigravity") {
    return {
      visualizePath: join(homeDir, ".gemini", "config", "skills", "brain-visualize", "SKILL.md"),
      mergePath: join(homeDir, ".gemini", "config", "skills", "brain-merge", "SKILL.md"),
    };
  }
  if (harness === "codex") {
    return {
      visualizePath: join(homeDir, ".codex", "skills", "brain-visualize", "SKILL.md"),
      mergePath: join(homeDir, ".codex", "skills", "brain-merge", "SKILL.md"),
    };
  }
  return {
    visualizePath: join(homeDir, ".claude", "commands", "brain-visualize.md"),
    mergePath: join(homeDir, ".claude", "commands", "brain-merge.md"),
  };
}

function renderVisualizeSkill(nodeCommand: string, cliPath: string, dbPath: string, claudeCommand: boolean): string {
  if (claudeCommand) {
    return `---
description: Launch or inspect the read-only Memory Atlas visualizer web UI (http://localhost:4173)
---

Start the Memory Atlas visualizer in \`--foreground\` mode as a background task (so the process manager keeps the HTTP server alive) unless \`--status\` or \`--stop\` was passed:

\`\`\`sh
"${nodeCommand}" "${cliPath}" --visualize --db "${dbPath}" --foreground $ARGUMENTS
\`\`\`

For \`--status\` or \`--stop\`, run without \`--foreground\`. Report the clickable URL, whether the server was started or reused, and the overview counts from the JSON output. The visualizer is strictly read-only and never modifies \`brain.db\`.
`;
  }

  return `---
name: brain-visualize
description: Launch or inspect the read-only Memory Atlas visualizer web UI for the shared Brain database and open it at http://localhost:4173.
---

# Brain Visualizer (\`/brain-visualize\`)

Start (or reuse) the read-only Memory Atlas visualizer server and open it so the user can inspect the memory graph, context deliveries, harness usage rankings, and workflow overview.

## Steps

1. Start the launcher in \`--foreground\` mode as a **long-running background daemon** (\`IsDaemon: true\` in Antigravity, or background shell task in Claude Code / Codex) so the host process manager does not reap the HTTP server on exit:

   \`\`\`sh
   "${nodeCommand}" "${cliPath}" --visualize --db "${dbPath}" --foreground
   \`\`\`

   *(If the visualizer is already running on port 4173, the launcher automatically reuses it, opens the URL, prints the JSON status, and exits cleanly.)*

   Pass through any optional flags requested by the user:
   - \`--db <path>\` — inspect a specific SQLite database (defaults to \`${dbPath}\`)
   - \`--port <port>\` — override port (defaults to \`4173\`)
   - \`--no-open\` — start/check the server without opening the system browser
   - \`--status\` — check if the visualizer is running and print live stats (normal non-daemon call without \`--foreground\`)
   - \`--stop\` — cleanly stop the running visualizer server (normal non-daemon call without \`--foreground\`)

2. Report back concisely using the printed JSON output:
   - Clickable URL (e.g. \`http://localhost:4173\`)
   - Whether the server was freshly started or already running
   - Live overview counts (\`memoriesActive\` / \`memoriesTotal\`, \`contexts\`, \`runtimeInstances\`, \`vectorSearchAvailable\`)

The visualizer opens SQLite in driver-enforced read-only mode and never modifies \`brain.db\`.
`;
}

function renderMergeSkill(nodeCommand: string, cliPath: string, dbPath: string, claudeCommand: boolean): string {
  if (claudeCommand) {
    return `---
description: Non-destructively mirror native harness memories (Claude, Codex, Antigravity) into dedicated entries in Memory Atlas
---

Run the Memory Atlas native memory auto-sync (strictly read-only on native harness files; never mixes with or modifies existing Brain-authored memories; native files remain authoritative):

\`\`\`sh
"${nodeCommand}" "${cliPath}" --sync-native "${dbPath}" $ARGUMENTS
\`\`\`

Supported flags: \`--dry-run\`, \`--watch\`, \`--harness=<name>\`, \`--source=<name>:<path>\`, \`--no-embed\`, \`--no-backup\`.
Summarize the JSON output (scanned harnesses, discovered, added, updated, superseded, archived, unchanged, embedded, backup path, warnings). If the user wants to merge two separate Brain \`.db\` files instead, use \`--merge-db SOURCE --into TARGET\` to preview first.
`;
  }

  return `---
name: brain-merge
description: Non-destructively mirror native harness memories (Claude Code, Codex, Antigravity) into dedicated, authoritative entries in the shared Memory Atlas database without modifying native files or mixing them with Brain-authored memories.
---

# Brain Native Memory Auto-Sync (\`/brain-merge\`)

Mirror native harness memories into the shared Memory Atlas SQLite database so every connected harness (Claude Code, Codex, Antigravity) can retrieve them without altering or conflicting with any harness's native memory store.

## Guarantees
- **Strictly read-only on native sources**: never edits, moves, or deletes files in \`~/.claude/\`, \`~/.codex/\`, or \`~/.gemini/\`.
- **Dedicated entries (no mixing)**: mirrors are stored as separate \`origin: "import"\` records with \`sourceRef: "native-mirror:<harness>:..."\` and tags \`["native-mirror", "native-authoritative", "native-source:<harness>"]\`. Existing Brain-authored memories are never modified or overwritten.
- **Native priority**: edits at the native source update or supersede the mirrored row; deletions at the native source soft-archive the mirrored row.
- **Safe & idempotent**: takes an automatic \`VACUUM INTO\` backup before any write; unchanged re-runs perform zero writes.

## Steps

1. Run the native sync command:

   \`\`\`sh
   "${nodeCommand}" "${cliPath}" --sync-native "${dbPath}"
   \`\`\`

   Pass through any flags the user requested:
   - \`--dry-run\` — preview what would be added, updated, superseded, or archived without writing
   - \`--watch\` — keep watching native memory folders and auto-sync changes live
   - \`--harness=<name>\` — limit sync to specific harness(es) (\`claude-code\`, \`codex\`, \`antigravity\`), repeatable
   - \`--source=<name>:<path>\` — include an additional custom harness markdown directory, repeatable
   - \`--no-embed\` — skip local vector embedding (lexical FTS5 search still updates immediately)

   *(If the user instead asked to merge two separate Brain \`.db\` files, run \`"${nodeCommand}" "${cliPath}" --merge-db <source.db> --into "${dbPath}"\` to preview first, then \`--apply --digest=<hash>\` after confirmation.)*

2. Parse the JSON result and report:
   - Scanned harnesses and total discovered native memories
   - Counts of \`added\`, \`updated\`, \`superseded\`, \`archived\`, \`unchanged\`, and \`embedded\`
   - Any \`warnings\` and the \`backup\` snapshot path (if mutations occurred)
   - Confirm that native harness files were untouched and existing Brain memories were preserved.
`;
}

/** Inspects whether global `/brain-visualize` and `/brain-merge` skills are installed for each harness. */
export function inspectGlobalSkills(homeDir: string = homedir()): GlobalSkillStatus[] {
  return SUPPORTED_SKILL_HARNESSES.map((harness) => {
    const paths = skillPathsForHarness(harness, homeDir);
    return {
      harness,
      visualizePath: paths.visualizePath,
      visualizeInstalled: existsSync(paths.visualizePath),
      mergePath: paths.mergePath,
      mergeInstalled: existsSync(paths.mergePath),
    };
  });
}

/** Installs global `/brain-visualize` and `/brain-merge` skills/commands with absolute paths across harnesses. */
export function installGlobalSkills(options: InstallSkillsOptions): InstallSkillsResult {
  const homeDir = options.homeDir ?? homedir();
  const dbPath = resolveUserPath(options.dbPath, homeDir);
  const nodeCommand = options.nodeCommand ?? resolveNodeCommand(process.execPath);
  const cliPath = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  const harnesses = normalizeHarnesses(options.harnesses);
  const installedFiles: string[] = [];

  for (const harness of harnesses) {
    const { visualizePath, mergePath } = skillPathsForHarness(harness, homeDir);
    const claudeCommand = harness === "claude-code";

    mkdirSync(dirname(visualizePath), { recursive: true });
    writeFileSync(visualizePath, renderVisualizeSkill(nodeCommand, cliPath, dbPath, claudeCommand), "utf8");
    installedFiles.push(visualizePath);

    mkdirSync(dirname(mergePath), { recursive: true });
    writeFileSync(mergePath, renderMergeSkill(nodeCommand, cliPath, dbPath, claudeCommand), "utf8");
    installedFiles.push(mergePath);
  }

  return {
    dbPath,
    nodeCommand,
    cliPath,
    harnesses,
    installedFiles,
  };
}
