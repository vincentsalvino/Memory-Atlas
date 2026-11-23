import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteMemoryRepository, SqliteEventStore, SqliteRetrievalStore, SqliteHarnessStore } from "@brain/storage";
import { FakeEmbeddingProvider } from "@brain/test-fixtures";
import { privateProjectScope, resolveRuntimeConfig } from "@brain/contracts";
import { MemoryService } from "@brain/memory";
import { RetrievalService } from "@brain/retrieval";
import { EventService } from "@brain/learning";
import { Gateway } from "@brain/gateway";
import { formatMcpConfig, parseTomlMcpServers, setupMcp } from "./setup.js";
import { installGlobalSkills } from "./skills.js";
import { runDoctor } from "./doctor.js";
import { runVisualizeCli } from "./visualize.js";
import { feedbackShape, recordOutcomeShape } from "./schemas.js";

test("private project knowledge cannot be read or changed by a foreign or unidentified launcher", async () => {
  const db = openDatabase(":memory:");
  try {
    const embed = new FakeEmbeddingProvider();
    function gateway(id: string | null) {
      return new Gateway(new MemoryService(new SqliteMemoryRepository(db.raw, embed, id)),
        new RetrievalService(new SqliteRetrievalStore(db.raw, embed, db.vectorSearchAvailable)),
        new EventService(new SqliteEventStore(db.raw, id)), { vectorSearchAvailable: true },
        undefined, undefined, undefined, undefined, id, new SqliteHarnessStore(db.raw));
    }
    const a = gateway("a"), b = gateway("b"), unknown = gateway(null);
    const anonymous = await unknown.remember({type: "fact", content: "anonymous provenance", scope: {kind: "global", id: null}, source: {origin: "agent", agentId: "forged"}});
    assert.equal(anonymous.source.agentId, undefined);
    const scope = privateProjectScope("a", "example");
    const secret = await a.remember({ type: "fact", content: "database isolation rule", scope });
    await assert.rejects(() => unknown.feedback({ memoryId: secret.id, taskId: null, contextId: null, useful: true, reason: null, notes: null }));
    const shared = await a.remember({ type: "fact", content: "database shared convention", scope: { kind: "project", id: "example" } });
    for (const other of [b, unknown]) {
      await assert.rejects(() => other.recall({ scope, id: secret.id }));
      await assert.rejects(() => other.search({ scope, text: "database" }));
      await assert.rejects(() => other.getContext({ scope, task: "database", budget: {maxTokens: 500} }));
      await assert.rejects(() => other.remember({ scope, type: "fact", content: "overwrite" }));
      await assert.rejects(() => other.update({ scope, input: {id: secret.id, content: "changed"} }));
      await assert.rejects(() => other.forget({ scope, id: secret.id }));
      await assert.rejects(() => other.project({ projectId: scope.id! }));
    }
    await b.update({scope: {kind: "project", id: "example"}, input: {id: shared.id, content: "database shared convention revised"}});
    assert.equal((db.raw.prepare("SELECT actor_agent_id FROM memory_mutation_events WHERE memory_id=? AND mutation_type='update'").get(shared.id) as {actor_agent_id: string}).actor_agent_id, "b");
    const pack = await a.getContext({ scope: {kind: "project", id: "example"}, task: "database", budget: {maxTokens: 500} });
    assert(pack.items.some(i => i.memoryId === secret.id));
    assert(pack.items.some(i => i.memoryId === shared.id));
    assert(pack.tokenCount <= 500);
    const otherPack = await b.getContext({ scope: {kind: "project", id: "example"}, task: "database", budget: {maxTokens: 500} });
    assert(!otherPack.items.some(i => i.memoryId === secret.id));
    const differentProject = await a.search({scope: {kind: "project", id: "different"}, text: "database"});
    assert(!differentProject.some(i => i.memoryId === secret.id));
    assert.equal(db.raw.prepare("SELECT harness_id FROM context_events WHERE id=?").get(pack.contextId) &&
      (db.raw.prepare("SELECT harness_id FROM context_events WHERE id=?").get(pack.contextId) as {harness_id: string}).harness_id, "a");
    for (const other of [b, unknown]) await assert.rejects(() => other.recordOutcome({ contextId: pack.contextId, taskId: "t", sessionId: null, outcome: "success", signal: null, notes: null }));
    await a.feedback({ contextId: pack.contextId, memoryId: secret.id, taskId: "t", useful: true, reason: null, notes: null });
    assert.equal((db.raw.prepare("SELECT harness_id FROM feedback_events").get() as {harness_id: string}).harness_id, "a");
    await a.forget({scope, id: secret.id});
    assert(!("harnessId" in feedbackShape));
    assert(!("harnessId" in recordOutcomeShape));
  } finally { db.close(); }
});

test("runtime flags reject ambiguous values; runtime state expires and reports mixed settings", async () => {
  assert.deepEqual(resolveRuntimeConfig({}), {learningEnabled: true, redundancyEnabled: true});
  assert.equal(resolveRuntimeConfig({BRAIN_LEARNING_ENABLED: "false"}).learningEnabled, false);
  assert.throws(() => resolveRuntimeConfig({BRAIN_LEARNING_ENABLED: "typo"}));
  const db = openDatabase(":memory:");
  try {
    const store = new SqliteHarnessStore(db.raw);
    assert.equal(store.runtimeStatus().learningEnabled, null);
    store.heartbeat("a", "a", {learningEnabled: true, redundancyEnabled: true});
    store.heartbeat("b", "b", {learningEnabled: false, redundancyEnabled: true});
    assert.deepEqual(store.runtimeStatus(), {learningEnabled: null, redundancyEnabled: true, instances: 2});
    db.raw.prepare("UPDATE runtime_instances SET updated_at=? WHERE id='b'").run("2000-01-01T00:00:00.000Z");
    assert.equal(store.runtimeStatus().learningEnabled, true);
    await store.recordUsage({kind: "skill", identifier: "review", stage: "loaded", source: "reported", harnessId: "a", projectId: "example", success: null, durationMs: null});
    assert.equal((await store.rankings("a"))[0]?.source, "reported");
    assert.deepEqual(await store.rankings("b"), []);
  } finally { db.close(); }
});

test("setup is repeatable, preserves unrelated settings, rejects replacements and supports undo", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-setup-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({other: true, mcpServers: {other: {command: "other"}}}));
    const entry = { command: "node", args: ["brain", "--harness-id=test"] };
    setupMcp(path, entry); setupMcp(path, entry);
    assert.throws(() => setupMcp(path, {command: "changed"}));
    const updated = JSON.parse(readFileSync(path, "utf8"));
    updated.concurrent = "keep"; writeFileSync(path, JSON.stringify(updated));
    setupMcp(path, {}, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {other: true, concurrent: "keep", mcpServers: {other: {command: "other"}}});
    const original = {command: "original"};
    writeFileSync(path, JSON.stringify({mcpServers: {"ai-brain": original}}));
    setupMcp(path, entry, false, true);
    setupMcp(path, {}, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).mcpServers["ai-brain"], original);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test("setupMcp preserves harness-specific JSON fields and merges env on --replace, and supports undo", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-setup-preserve-"));
  try {
    const configPath = join(dir, "claude.json");
    const original = {
      type: "stdio",
      command: "node",
      args: ["old.js"],
      disabled: false,
      timeout: 60000,
      env: { KEEP_VAR: "stay", BRAIN_MODEL_CACHE_DIR: "/old/models" },
    };
    writeFileSync(configPath, JSON.stringify({ otherSetting: 42, mcpServers: { "ai-brain": original } }));

    setupMcp(
      configPath,
      {
        command: "C:\\node\\v26\\node.exe",
        args: ["C:\\pkg\\cli.js", "C:\\data\\brain.db", "--harness-id=claude-code"],
        env: { BRAIN_MODEL_CACHE_DIR: "C:\\models" },
      },
      false,
      true,
    );

    const replaced = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(replaced.otherSetting, 42);
    assert.deepEqual(replaced.mcpServers["ai-brain"], {
      type: "stdio",
      disabled: false,
      timeout: 60000,
      command: "C:\\node\\v26\\node.exe",
      args: ["C:\\pkg\\cli.js", "C:\\data\\brain.db", "--harness-id=claude-code"],
      env: { KEEP_VAR: "stay", BRAIN_MODEL_CACHE_DIR: "C:\\models" },
    });

    // Repeating with the same base entry after --replace is a no-op once merged entry matches.
    setupMcp(
      configPath,
      {
        command: "C:\\node\\v26\\node.exe",
        args: ["C:\\pkg\\cli.js", "C:\\data\\brain.db", "--harness-id=claude-code"],
        env: { BRAIN_MODEL_CACHE_DIR: "C:\\models" },
      },
      false,
      true,
    );

    setupMcp(configPath, {}, true);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).mcpServers["ai-brain"], original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setupMcp supports Codex TOML format: create, idempotent, preserve fields/env on --replace, and undo", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-setup-toml-"));
  try {
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.ai-brain]",
        'command = "node"',
        'args = ["old/server.js", "old/brain.db"]',
        "startup_timeout_sec = 45",
        "",
        "[mcp_servers.ai-brain.env]",
        'CUSTOM_TOKEN = "abc"',
        "",
        "[mcp_servers.other]",
        'command = "other-tool"',
        "args = []",
        "",
      ].join("\n"),
      "utf8",
    );

    const incoming = {
      command: "C:\\nvm\\v26.13.1\\node.exe",
      args: ["C:\\pkg\\cli.js", "C:\\shared\\brain.db", "--harness-id=codex"],
      env: { BRAIN_MODEL_CACHE_DIR: "C:\\models" },
    };

    assert.throws(() => setupMcp(configPath, incoming, false, false, "toml"), /already exists/i);
    setupMcp(configPath, incoming, false, true, "toml");
    setupMcp(configPath, incoming, false, true, "toml");

    const updatedRaw = readFileSync(configPath, "utf8");
    const parsed = parseTomlMcpServers(updatedRaw);
    assert.deepEqual(parsed["ai-brain"], {
      command: "C:\\nvm\\v26.13.1\\node.exe",
      args: ["C:\\pkg\\cli.js", "C:\\shared\\brain.db", "--harness-id=codex"],
      startup_timeout_sec: 45,
      env: {
        CUSTOM_TOKEN: "abc",
        BRAIN_MODEL_CACHE_DIR: "C:\\models",
      },
    });
    assert.deepEqual(parsed.other, { command: "other-tool", args: [] });
    assert.match(updatedRaw, /model = "gpt-5"/);

    // Concurrent edit elsewhere in config.toml survives undo.
    writeFileSync(configPath, updatedRaw + '\n[profiles.fast]\nmodel = "mini"\n', "utf8");
    setupMcp(configPath, {}, true, false, "toml");
    const undoneRaw = readFileSync(configPath, "utf8");
    assert.match(undoneRaw, /\[profiles\.fast\]/);
    assert.deepEqual(parseTomlMcpServers(undoneRaw)["ai-brain"], {
      command: "node",
      args: ["old/server.js", "old/brain.db"],
      startup_timeout_sec: 45,
      env: { CUSTOM_TOKEN: "abc" },
    });

    // Fresh TOML setup + undo removes the installed section cleanly.
    const freshToml = join(dir, "fresh.toml");
    writeFileSync(freshToml, 'model = "gpt-5"\n', "utf8");
    setupMcp(freshToml, incoming);
    assert.ok(parseTomlMcpServers(readFileSync(freshToml, "utf8"))["ai-brain"]);
    setupMcp(freshToml, {}, true);
    assert.equal(parseTomlMcpServers(readFileSync(freshToml, "utf8"))["ai-brain"], undefined);
    assert.match(readFileSync(freshToml, "utf8"), /model = "gpt-5"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatMcpConfig formats JSON and TOML entries with BRAIN_MODEL_CACHE_DIR", () => {
  const entry = {
    command: "C:\\nvm\\v26.13.1\\node.exe",
    args: ["C:\\pkg\\cli.js", "C:\\data\\brain.db", "--harness-id=codex"],
    env: { BRAIN_MODEL_CACHE_DIR: "C:\\cache\\models" },
  };
  const jsonOut = JSON.parse(formatMcpConfig(entry, "json"));
  assert.deepEqual(jsonOut.mcpServers["ai-brain"], entry);

  const tomlOut = formatMcpConfig(entry, "toml");
  assert.match(tomlOut, /^\[mcp_servers\.ai-brain\]/m);
  assert.match(tomlOut, /\[mcp_servers\.ai-brain\.env\]/);
  assert.deepEqual(parseTomlMcpServers(tomlOut)["ai-brain"], entry);
});

test("installGlobalSkills writes /brain-visualize and /brain-merge for antigravity, claude-code, and codex", () => {
  const home = mkdtempSync(join(tmpdir(), "brain-skills-"));
  try {
    const dbPath = join(home, ".brainded", "brain.db");
    const result = installGlobalSkills({
      dbPath,
      homeDir: home,
      nodeCommand: "C:\\node\\node.exe",
      cliPath: "C:\\pkg\\dist\\cli.js",
    });

    assert.equal(result.installedFiles.length, 6);
    const agVis = readFileSync(join(home, ".gemini", "config", "skills", "brain-visualize", "SKILL.md"), "utf8");
    const agMerge = readFileSync(join(home, ".gemini", "config", "skills", "brain-merge", "SKILL.md"), "utf8");
    const codexVis = readFileSync(join(home, ".codex", "skills", "brain-visualize", "SKILL.md"), "utf8");
    const codexMerge = readFileSync(join(home, ".codex", "skills", "brain-merge", "SKILL.md"), "utf8");
    const claudeVis = readFileSync(join(home, ".claude", "commands", "brain-visualize.md"), "utf8");
    const claudeMerge = readFileSync(join(home, ".claude", "commands", "brain-merge.md"), "utf8");

    for (const content of [agVis, codexVis, claudeVis]) {
      assert.ok(content.includes('"C:\\node\\node.exe" "C:\\pkg\\dist\\cli.js" --visualize --db'));
      assert.ok(content.includes(dbPath));
    }
    for (const content of [agMerge, codexMerge, claudeMerge]) {
      assert.ok(content.includes('"C:\\node\\node.exe" "C:\\pkg\\dist\\cli.js" --sync-native'));
      assert.ok(content.includes(dbPath));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDoctor flags split databases, legacy server.js, missing --harness-id, bare node, non-canonical key, and nvm symlink, then reports clean after fixing", () => {
  const home = mkdtempSync(join(tmpdir(), "brain-doctor-"));
  try {
    const primaryDb = join(home, ".brainded", "brain.db");
    const secondaryDb = join(home, "legacy", "brain.db");
    mkdirSync(join(home, ".brainded"), { recursive: true });
    mkdirSync(join(home, "legacy"), { recursive: true });
    openDatabase(primaryDb).close();
    openDatabase(secondaryDb).close();

    const realNodeDir = join(home, "nvm", "v26.13.1");
    const junctionNodeDir = join(home, "nvm4w", "nodejs");
    const fakeCli = join(realNodeDir, "node_modules", "@beanvincentcat", "memory-atlas", "dist", "cli.js");
    const fakeLegacyServer = join(home, "legacy", "server.js");
    mkdirSync(join(realNodeDir, "node_modules", "@beanvincentcat", "memory-atlas", "dist"), { recursive: true });
    mkdirSync(join(home, "nvm4w"), { recursive: true });
    const nodeBinName = process.platform === "win32" ? "node.exe" : "node";
    const realNodeBin = join(realNodeDir, nodeBinName);
    writeFileSync(realNodeBin, "", "utf8");
    writeFileSync(fakeCli, "", "utf8");
    writeFileSync(fakeLegacyServer, "", "utf8");
    symlinkSync(realNodeDir, junctionNodeDir, process.platform === "win32" ? "junction" : "dir");
    const symlinkNodeBin = join(junctionNodeDir, nodeBinName);

    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "ai-brain": {
            command: symlinkNodeBin,
            args: [fakeCli, primaryDb],
          },
        },
      }),
      "utf8",
    );

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          brain: {
            type: "stdio",
            command: "node",
            args: [fakeLegacyServer, secondaryDb, "--harness-id=claude-code"],
          },
        },
      }),
      "utf8",
    );

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.ai-brain]\ncommand = "node"\nargs = [${JSON.stringify(fakeCli)}, ${JSON.stringify(primaryDb)}]\n`,
      "utf8",
    );

    const broken = runDoctor({
      homeDir: home,
      cwd: home,
      execPath: realNodeBin,
      cliPath: fakeCli,
    });
    assert.equal(broken.ok, false);
    const codes = new Set(broken.issues.map((i) => i.code));
    assert.ok(codes.has("nvm_symlink_command"));
    assert.ok(codes.has("missing_harness_id"));
    assert.ok(codes.has("non_canonical_server_key"));
    assert.ok(codes.has("bare_node_command"));
    assert.ok(codes.has("legacy_server_entrypoint"));
    assert.ok(codes.has("split_configured_databases"));
    assert.ok(codes.has("legacy_or_split_databases_detected"));
    assert.ok(codes.has("missing_model_cache_dir"));
    assert.ok(codes.has("missing_global_skills"));
    assert.ok(broken.recommendations.length >= 3);

    // Fix configs, remove legacy secondary DB, and install global skills.
    rmSync(secondaryDb, { force: true });
    const cacheDir = join(home, ".brainded", "models");
    setupMcp(
      join(home, ".gemini", "config", "mcp_config.json"),
      { command: realNodeBin, args: [fakeCli, primaryDb, "--harness-id=antigravity"], env: { BRAIN_MODEL_CACHE_DIR: cacheDir } },
      false,
      true,
    );
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    setupMcp(
      join(home, ".claude.json"),
      { type: "stdio", command: realNodeBin, args: [fakeCli, primaryDb, "--harness-id=claude-code"], env: { BRAIN_MODEL_CACHE_DIR: cacheDir } },
      false,
      true,
    );
    setupMcp(
      join(home, ".codex", "config.toml"),
      { command: realNodeBin, args: [fakeCli, primaryDb, "--harness-id=codex"], env: { BRAIN_MODEL_CACHE_DIR: cacheDir } },
      false,
      true,
      "toml",
    );
    installGlobalSkills({ dbPath: primaryDb, homeDir: home, nodeCommand: realNodeBin, cliPath: fakeCli });

    const clean = runDoctor({
      homeDir: home,
      cwd: home,
      execPath: realNodeBin,
      cliPath: fakeCli,
    });
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.issues, []);
    assert.equal(clean.databases.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function allocateFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function removeDirWithRetry(dir: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw error;
    }
  }
}

test("runVisualizeCli reports stopped status, starts server against a temp DB, checks running status, and stops cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-viz-cli-"));
  const dbPath = join(dir, "brain.db");
  const port = await allocateFreePort();
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };

  try {
    openDatabase(dbPath).close();
    assert.ok(existsSync(dbPath));

    await runVisualizeCli(["--status", `--port=${port}`], { homeDir: dir, cwd: dir });
    const before = JSON.parse(captured.pop()!);
    assert.equal(before.running, false);

    await runVisualizeCli(["--db", dbPath, `--port=${port}`, "--no-open"], { homeDir: dir, cwd: dir });
    const started = JSON.parse(captured.pop()!);
    assert.equal(started.alreadyRunning, false);
    assert.equal(started.port, port);
    assert.equal(started.opened, false);
    assert.equal(typeof started.overview?.memoriesTotal, "number");

    await runVisualizeCli(["--status", `--port=${port}`], { homeDir: dir, cwd: dir });
    const running = JSON.parse(captured.pop()!);
    assert.equal(running.running, true);
    assert.equal(running.port, port);

    await runVisualizeCli(["--stop", `--port=${port}`], { homeDir: dir, cwd: dir });
    const stopped = JSON.parse(captured.pop()!);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.port, port);

    await runVisualizeCli(["--status", `--port=${port}`], { homeDir: dir, cwd: dir });
    const after = JSON.parse(captured.pop()!);
    assert.equal(after.running, false);
  } finally {
    try {
      await runVisualizeCli(["--stop", `--port=${port}`], { homeDir: dir, cwd: dir });
    } catch {
      // ignore if already stopped
    }
    console.log = origLog;
    await removeDirWithRetry(dir);
  }
});
