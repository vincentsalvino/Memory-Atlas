#!/usr/bin/env node

import { setupMcp } from "./setup.js";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const help = `Usage: brain-mcp [database-path]
       brain-mcp --check [database-path]
       brain-mcp --config [database-path]
       brain-mcp --version

Run the Brainded MCP server over stdio. The default database is ~/.brainded/brain.db.
--check opens the database and reports storage and vector extension availability.
--config prints an MCP host configuration for this installation.
--harness-id=NAME sets trusted launcher identity for private project access.
--setup CONFIG.json --harness-id=NAME --database=PATH installs a JSON MCP entry.
--undo-setup CONFIG.json removes the unchanged entry installed by setup.
--upgrade [database-path] backs up and applies pending database migrations.
--merge-db SOURCE --into TARGET previews a memory snapshot merge.
--merge-db SOURCE --into TARGET --apply --digest=HASH applies the reviewed preview.
--sync-native [database-path] [--dry-run] [--watch] [--harness=NAME] [--source=NAME:PATH] [--no-embed] [--no-backup]
       mirrors native harness memories (Claude, Codex, Antigravity) read-only into dedicated Brain entries.
--reindex-db PATH rebuilds semantic memory indexes (may download model weights).`;

async function run(args: string[]): Promise<void> {
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
    const dbPath = givenDb ? resolve(givenDb) : process.env.BRAIN_DB_PATH ? resolve(process.env.BRAIN_DB_PATH) : join(dataDir, "brain.db");
    if (!givenDb || dbPath === join(dataDir, "brain.db")) mkdirSync(dataDir, { recursive: true });

    const syncOptions = {
      ...(harnesses.length ? { harnesses } : {}),
      ...(customSources.length ? { customSources } : {}),
      dryRun,
      backup,
      embed,
      cacheDir: process.env.BRAIN_MODEL_CACHE_DIR ? resolve(process.env.BRAIN_MODEL_CACHE_DIR) : join(dataDir, "models"),
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
    const [ , source, intoFlag, target, ...flags ] = args;
    const apply = flags.includes("--apply");
    const digest = flags.find(flag => flag.startsWith("--digest="))?.slice(9);
    if (!source || intoFlag !== "--into" || !target || flags.some(flag => flag !== "--apply" && !flag.startsWith("--digest=")) || (apply !== Boolean(digest))) {
      throw new Error("Usage: brain-mcp --merge-db SOURCE --into TARGET [--apply --digest=PREVIEW_DIGEST]");
    }
    const { mergeMemoryDatabases } = await import("./bootstrap.js");
    console.log(JSON.stringify(mergeMemoryDatabases(resolve(source), resolve(target), apply ? digest : undefined), null, 2));
    return;
  }
  const setupMode = args[0] === "--setup" || args[0] === "--undo-setup";
  if (setupMode) {
    const [mode, configPath, ...flags] = args;
    const harness = flags.find(a => a.startsWith("--harness-id="))?.slice(13);
    const database = flags.find(a => a.startsWith("--database="))?.slice(11);
    if (!configPath || flags.some(a => !a.startsWith("--harness-id=") && !a.startsWith("--database=") && a !== "--replace")) throw new Error("Usage: --setup config.json --harness-id=NAME --database=ABSOLUTE_PATH; --undo-setup config.json");
    if (mode === "--setup" && (!harness || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(harness) || !database)) throw new Error("Setup requires a valid harness identity and explicit database path");
    setupMcp(configPath, { command: process.execPath, args: [fileURLToPath(import.meta.url), resolve(database ?? "."), `--harness-id=${harness}`] }, mode === "--undo-setup", flags.includes("--replace"));
    console.log("MCP configuration updated. Reconnect the harness and call brain_status to verify connectivity.");
    return;
  }
  const harnessArg = args.find(arg => arg.startsWith("--harness-id="));
  const harnessId = harnessArg?.slice(13);
  if (harnessId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(harnessId)) throw new Error("Invalid harness identity");
  args = args.filter(arg => arg !== harnessArg);
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
  const dbPath = givenPath ? resolve(givenPath) : process.env.BRAIN_DB_PATH ? resolve(process.env.BRAIN_DB_PATH) : join(dataDir, "brain.db");
  if (mode === "--config") {
    console.log(JSON.stringify({ mcpServers: { "ai-brain": { command: process.execPath, args: [fileURLToPath(import.meta.url), dbPath, ...(harnessArg ? [harnessArg] : [])] } } }, null, 2));
    return;
  }

  if (!givenPath || dbPath === join(dataDir, "brain.db")) mkdirSync(dataDir, { recursive: true });
  const options = {
    ...(harnessId ? { harnessId } : {}),
    cacheDir: process.env.BRAIN_MODEL_CACHE_DIR ? resolve(process.env.BRAIN_MODEL_CACHE_DIR) : join(dataDir, "models"),
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

run(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
