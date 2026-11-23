#!/usr/bin/env node

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.js";
import {
  formatMcpConfig,
  resolveNodeCommand,
  resolveUserPath,
  setupMcp,
  type Json,
  type McpConfigFormat,
} from "./setup.js";
import { installGlobalSkills } from "./skills.js";
import { resolveDefaultVisualizerDbPath, runVisualizeCli } from "./visualize.js";

const help = `Usage: brain-mcp [database-path]
       brain-mcp --check [database-path]
       brain-mcp --config [database-path] [--harness-id=NAME] [--model-cache=PATH] [--format=json|toml]
       brain-mcp --setup CONFIG_PATH --harness-id=NAME --database=PATH [--model-cache=PATH] [--format=json|toml] [--replace]
       brain-mcp --undo-setup CONFIG_PATH [--format=json|toml]
       brain-mcp --visualize [--db PATH] [--port 4173] [--no-open] [--status] [--stop] [--foreground]
       brain-mcp --install-skills [--harness=antigravity,claude-code,codex] [--database=PATH]
       brain-mcp --doctor [database-path] [--database=PATH] [--strict]
       brain-mcp --version

Run the Brainded MCP server over stdio. The default database is ~/.brainded/brain.db.
--check opens the database and reports storage and vector extension availability.
--config prints an MCP host configuration for this installation (JSON or Codex TOML).
--harness-id=NAME sets trusted launcher identity for private project access.
--model-cache=PATH sets BRAIN_MODEL_CACHE_DIR in generated config entries.
--format=json|toml selects mcpServers JSON or Codex [mcp_servers.ai-brain] TOML output.
--setup CONFIG_PATH installs an MCP entry (auto-detects .toml/.json unless --format is given).
--undo-setup CONFIG_PATH removes the unchanged entry installed by setup.
--visualize launches or inspects the read-only Memory Atlas web UI.
--install-skills writes global /brain-visualize and /brain-merge skills for Antigravity, Claude Code, and Codex.
--doctor audits harness configs, Node runtime/ABI alignment, global skills, and split databases.
--upgrade [database-path] backs up and applies pending database migrations.
--merge-db SOURCE --into TARGET previews a memory snapshot merge.
--merge-db SOURCE --into TARGET --apply --digest=HASH applies the reviewed preview.
--sync-native [database-path] [--dry-run] [--watch] [--harness=NAME] [--source=NAME:PATH] [--no-embed] [--no-backup]
       mirrors native harness memories (Claude, Codex, Antigravity) read-only into dedicated Brain entries.
--reindex-db PATH rebuilds semantic memory indexes (may download model weights).`;

function parseFormat(raw: string | undefined): McpConfigFormat | undefined {
  if (raw === undefined) return undefined;
  if (raw === "json" || raw === "toml") return raw;
  throw new Error(`Invalid --format value "${raw}"; expected json or toml`);
}

async function run(args: string[]): Promise<void> {
  if (args[0] === "--visualize") {
    await runVisualizeCli(args.slice(1));
    return;
  }

  if (args[0] === "--install-skills") {
    const rest = args.slice(1);
    const harnesses: string[] = [];
    let givenDb: string | undefined;
    let homeOverride: string | undefined;

    for (const token of rest) {
      if (token.startsWith("--harness=")) {
        const value = token.slice(10).trim();
        if (!value) throw new Error("--harness= requires one or more harness names");
        harnesses.push(value);
      } else if (token.startsWith("--database=")) {
        const value = token.slice(11).trim();
        if (!value) throw new Error("--database= requires a database path");
        givenDb = value;
      } else if (token.startsWith("--db=")) {
        const value = token.slice(5).trim();
        if (!value) throw new Error("--db= requires a database path");
        givenDb = value;
      } else if (token.startsWith("--home=")) {
        const value = token.slice(7).trim();
        if (!value) throw new Error("--home= requires a directory path");
        homeOverride = resolveUserPath(value);
      } else if (token.startsWith("-")) {
        throw new Error(`Unknown flag for --install-skills: ${token}`);
      } else if (!givenDb) {
        givenDb = token;
      } else {
        throw new Error("Usage: brain-mcp --install-skills [--harness=antigravity,claude-code,codex] [--database=PATH]");
      }
    }

    const effectiveHome = homeOverride ?? homedir();
    const dbPath = givenDb
      ? resolveUserPath(givenDb, effectiveHome)
      : resolveDefaultVisualizerDbPath({ homeDir: effectiveHome });

    const result = installGlobalSkills({
      dbPath,
      ...(harnesses.length > 0 ? { harnesses } : {}),
      homeDir: effectiveHome,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args[0] === "--doctor") {
    const rest = args.slice(1);
    let givenDb: string | undefined;
    let homeOverride: string | undefined;
    let strict = false;

    for (const token of rest) {
      if (token === "--strict") {
        strict = true;
      } else if (token.startsWith("--database=")) {
        const value = token.slice(11).trim();
        if (!value) throw new Error("--database= requires a database path");
        givenDb = value;
      } else if (token.startsWith("--db=")) {
        const value = token.slice(5).trim();
        if (!value) throw new Error("--db= requires a database path");
        givenDb = value;
      } else if (token.startsWith("--home=")) {
        const value = token.slice(7).trim();
        if (!value) throw new Error("--home= requires a directory path");
        homeOverride = resolveUserPath(value);
      } else if (token.startsWith("-")) {
        throw new Error(`Unknown flag for --doctor: ${token}`);
      } else if (!givenDb) {
        givenDb = token;
      } else {
        throw new Error("Usage: brain-mcp --doctor [database-path] [--database=PATH] [--strict]");
      }
    }

    const report = runDoctor({
      ...(givenDb ? { dbPath: givenDb } : {}),
      ...(homeOverride ? { homeDir: homeOverride } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    if (strict && !report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === "--sync-native") {
    const rest = args.slice(1);
    let givenDb: string | undefined;
    let dryRun = false;
    let watchMode = false;
    let embed = true;
    let backup = true;
    const harnesses: string[] = [];
    const customSources: { harness: string; path: string }[] = [];

    for (const token of rest) {
      if (token === "--dry-run") dryRun = true;
      else if (token === "--watch") watchMode = true;
      else if (token === "--no-embed") embed = false;
      else if (token === "--no-backup") backup = false;
      else if (token.startsWith("--harness=")) {
        const name = token.slice(10).trim();
        if (!name) throw new Error("--harness=NAME requires a harness name");
        harnesses.push(name);
      } else if (token.startsWith("--source=")) {
        const spec = token.slice(9);
        const sep = spec.indexOf(":");
        if (sep <= 0 || sep === spec.length - 1) throw new Error("--source=NAME:PATH requires both harness name and path");
        customSources.push({ harness: spec.slice(0, sep).trim(), path: spec.slice(sep + 1).trim() });
      } else if (token.startsWith("-")) {
        throw new Error(`Unknown flag for --sync-native: ${token}`);
      } else if (!givenDb) {
        givenDb = token;
      } else {
        throw new Error("Usage: brain-mcp --sync-native [database-path] [--dry-run] [--watch] [--harness=NAME] [--source=NAME:PATH] [--no-embed] [--no-backup]");
      }
    }

    const dataDir = join(homedir(), ".brainded");
    const dbPath = givenDb ? resolveUserPath(givenDb) : process.env.BRAIN_DB_PATH ? resolveUserPath(process.env.BRAIN_DB_PATH) : join(dataDir, "brain.db");
    if (!givenDb || dbPath === join(dataDir, "brain.db")) mkdirSync(dataDir, { recursive: true });

    const syncOptions = {
      ...(harnesses.length ? { harnesses } : {}),
      ...(customSources.length ? { customSources } : {}),
      dryRun,
      backup,
      embed,
      cacheDir: process.env.BRAIN_MODEL_CACHE_DIR ? resolveUserPath(process.env.BRAIN_MODEL_CACHE_DIR) : join(dataDir, "models"),
      localFilesOnly: process.env.BRAIN_LOCAL_FILES_ONLY === "1",
    };

    const { syncNativeMemorySources, watchNativeMemorySources } = await import("./bootstrap.js");
    const initial = await syncNativeMemorySources(dbPath, syncOptions);
    console.log(JSON.stringify(initial, null, 2));

    if (watchMode && !dryRun) {
      const handle = watchNativeMemorySources(
        dbPath,
        syncOptions,
        (result) => {
          if (result.added || result.updated || result.superseded || result.archived) {
            console.log(JSON.stringify(result));
          }
        },
        (error) => {
          console.error("Native sync watch error:", error instanceof Error ? error.message : String(error));
        },
      );
      console.error(`Watching native memory directories (${handle.watchedPaths.length}): ${handle.watchedPaths.join(", ")}`);
      await new Promise<void>((resolveStop) => {
        const stop = () => {
          handle.close();
          resolveStop();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }
    return;
  }

  if (args[0] === "--merge-db") {
    const [, source, intoFlag, target, ...flags] = args;
    const apply = flags.includes("--apply");
    const digest = flags.find((flag) => flag.startsWith("--digest="))?.slice(9);
    if (!source || intoFlag !== "--into" || !target || flags.some((flag) => flag !== "--apply" && !flag.startsWith("--digest=")) || apply !== Boolean(digest)) {
      throw new Error("Usage: brain-mcp --merge-db SOURCE --into TARGET [--apply --digest=PREVIEW_DIGEST]");
    }
    const { mergeMemoryDatabases } = await import("./bootstrap.js");
    console.log(JSON.stringify(mergeMemoryDatabases(resolveUserPath(source), resolveUserPath(target), apply ? digest : undefined), null, 2));
    return;
  }

  const setupMode = args[0] === "--setup" || args[0] === "--undo-setup";
  if (setupMode) {
    const [mode, configPath, ...flags] = args;
    const harness = flags.find((a) => a.startsWith("--harness-id="))?.slice(13);
    const database = flags.find((a) => a.startsWith("--database="))?.slice(11);
    const modelCacheArg = flags.find((a) => a.startsWith("--model-cache="));
    const modelCache = modelCacheArg?.slice(14);
    const formatArg = flags.find((a) => a.startsWith("--format="));
    const format = parseFormat(formatArg?.slice(9));
    if (modelCacheArg !== undefined && !modelCache) {
      throw new Error("--model-cache=PATH requires a directory path");
    }
    if (
      !configPath ||
      flags.some(
        (a) =>
          !a.startsWith("--harness-id=") &&
          !a.startsWith("--database=") &&
          !a.startsWith("--model-cache=") &&
          !a.startsWith("--format=") &&
          a !== "--replace",
      )
    ) {
      throw new Error(
        "Usage: --setup CONFIG_PATH --harness-id=NAME --database=ABSOLUTE_PATH [--model-cache=PATH] [--format=json|toml] [--replace]; --undo-setup CONFIG_PATH [--format=json|toml]",
      );
    }
    if (mode === "--setup" && (!harness || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(harness) || !database)) {
      throw new Error("Setup requires a valid harness identity and explicit database path");
    }
    const entry: Json = {
      command: resolveNodeCommand(process.execPath),
      args: [fileURLToPath(import.meta.url), resolveUserPath(database ?? "."), `--harness-id=${harness}`],
      ...(modelCache ? { env: { BRAIN_MODEL_CACHE_DIR: resolveUserPath(modelCache) } } : {}),
    };
    setupMcp(resolveUserPath(configPath), entry, mode === "--undo-setup", flags.includes("--replace"), format);
    console.log("MCP configuration updated. Reconnect the harness and call brain_status to verify connectivity.");
    return;
  }

  const harnessArg = args.find((arg) => arg.startsWith("--harness-id="));
  const harnessId = harnessArg?.slice(13);
  if (harnessId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(harnessId)) throw new Error("Invalid harness identity");

  const isConfigMode = args.includes("--config");
  const modelCacheArg = isConfigMode ? args.find((arg) => arg.startsWith("--model-cache=")) : undefined;
  const modelCache = modelCacheArg?.slice(14);
  if (modelCacheArg !== undefined && !modelCache) {
    throw new Error("--model-cache=PATH requires a directory path");
  }
  const formatArg = isConfigMode ? args.find((arg) => arg.startsWith("--format=")) : undefined;
  const format = parseFormat(formatArg?.slice(9));

  args = args.filter((arg) => arg !== harnessArg && arg !== modelCacheArg && arg !== formatArg);
  const [first, second] = args;
  if (args.length === 1 && (first === "--help" || first === "-h")) {
    console.log(help);
    return;
  }
  if (args.length === 1 && first === "--version") {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(manifest.version);
    return;
  }
  const mode = first === "--check" || first === "--config" || first === "--upgrade" || first === "--reindex-db" ? first : undefined;
  const givenPath = mode ? second : first;
  if (args.length > (mode ? 2 : 1) || givenPath?.startsWith("-")) throw new Error(help);

  const dataDir = join(homedir(), ".brainded");
  const dbPath = givenPath ? resolveUserPath(givenPath) : process.env.BRAIN_DB_PATH ? resolveUserPath(process.env.BRAIN_DB_PATH) : join(dataDir, "brain.db");
  if (mode === "--config") {
    const entry: Json = {
      command: resolveNodeCommand(process.execPath),
      args: [fileURLToPath(import.meta.url), dbPath, ...(harnessArg ? [harnessArg] : [])],
      ...(modelCache ? { env: { BRAIN_MODEL_CACHE_DIR: resolveUserPath(modelCache) } } : {}),
    };
    console.log(formatMcpConfig(entry, format ?? "json"));
    return;
  }

  if (!givenPath || dbPath === join(dataDir, "brain.db")) mkdirSync(dataDir, { recursive: true });
  const options = {
    ...(harnessId ? { harnessId } : {}),
    cacheDir: process.env.BRAIN_MODEL_CACHE_DIR ? resolveUserPath(process.env.BRAIN_MODEL_CACHE_DIR) : join(dataDir, "models"),
    localFilesOnly: process.env.BRAIN_LOCAL_FILES_ONLY === "1",
  };
  if (mode === "--upgrade") {
    const { upgradeMemoryDatabase } = await import("./bootstrap.js");
    console.log(JSON.stringify(upgradeMemoryDatabase(dbPath), null, 2));
    return;
  }
  if (mode === "--reindex-db") {
    const { reindexMemories } = await import("./bootstrap.js");
    const result = await reindexMemories(dbPath, options);
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (mode === "--check") {
    const { createBrain } = await import("./bootstrap.js");
    const brain = createBrain(dbPath, options);
    try {
      console.log(JSON.stringify({ dbPath, ...await brain.gateway.status() }, null, 2));
    } finally {
      brain.close();
    }
    return;
  }

  const { main } = await import("./server.js");
  await main(dbPath, options);
}

run(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
