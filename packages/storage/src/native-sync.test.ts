import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { FakeEmbeddingProvider } from "@brain/test-fixtures";
import { openDatabase } from "./db.js";
import { SqliteMemoryRepository } from "./memory-repository.js";
import { parseNativeFrontmatter, resolveClaudeProjectScope, syncNativeMemories } from "./native-sync.js";

function encodeClaudePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

test("parseNativeFrontmatter parses nested metadata and strips quotes cleanly", () => {
  const raw = [
    "---",
    "name: feedback-no-coauthor",
    'description: "Do not add Co-Authored-By trailers"',
    "metadata:",
    "  node_type: memory",
    "  type: feedback",
    "  originSessionId: sess-123",
    "---",
    "",
    "Never add Co-Authored-By.",
  ].join("\r\n");

  const parsed = parseNativeFrontmatter(raw);
  assert.equal(parsed.meta["name"], "feedback-no-coauthor");
  assert.equal(parsed.meta["description"], "Do not add Co-Authored-By trailers");
  assert.equal(parsed.meta["metadata.type"], "feedback");
  assert.equal(parsed.meta["metadata.originSessionId"], "sess-123");
  assert.equal(parsed.body, "Never add Co-Authored-By.");
});

test("resolveClaudeProjectScope preserves hyphenated project folders and maps container roots to global", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "brain-scope-"));
  try {
    const desktop = join(fakeHome, "OneDrive", "Desktop");
    const repo = join(desktop, "ai-brain");
    const nested = join(desktop, "portfolio", "Portfolio");
    mkdirSync(repo, { recursive: true });
    mkdirSync(nested, { recursive: true });

    assert.deepEqual(resolveClaudeProjectScope(encodeClaudePath(desktop), fakeHome), { kind: "global", id: null });
    assert.deepEqual(resolveClaudeProjectScope(encodeClaudePath(repo), fakeHome), { kind: "project", id: "ai-brain" });
    assert.deepEqual(resolveClaudeProjectScope(encodeClaudePath(nested), fakeHome), { kind: "project", id: "Portfolio" });
    assert.deepEqual(resolveClaudeProjectScope(encodeClaudePath(join(desktop, "removed-app")), fakeHome), {
      kind: "project",
      id: "removed-app",
    });
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("syncNativeMemories mirrors Claude, Codex, and Antigravity read-only without mixing with native Brain memories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-native-sync-"));
  try {
    const fakeHome = join(dir, "home");
    const desktop = join(fakeHome, "Desktop");
    const projectDir = join(desktop, "my-app");
    mkdirSync(projectDir, { recursive: true });

    // 1. Seed native Claude Code memories (one project-scoped, one global, plus MEMORY.md index that must be skipped)
    const claudeProjMem = join(fakeHome, ".claude", "projects", encodeClaudePath(projectDir), "memory");
    const claudeRootMem = join(fakeHome, ".claude", "projects", encodeClaudePath(desktop), "memory");
    mkdirSync(claudeProjMem, { recursive: true });
    mkdirSync(claudeRootMem, { recursive: true });

    const claudeProjectFile = join(claudeProjMem, "build_rule.md");
    const claudeProjectOriginal = `---\nname: build-rule\ndescription: "Always run build before test"\nmetadata:\n  type: feedback\n---\n\nRun npm run build first.`;
    writeFileSync(claudeProjectFile, claudeProjectOriginal, "utf8");
    writeFileSync(join(claudeProjMem, "MEMORY.md"), "# Index\n- [build-rule](build_rule.md)\n", "utf8");
    writeFileSync(
      join(claudeRootMem, "global_pref.md"),
      `---\nname: concise-style\nmetadata:\n  type: user\n---\n\nPrefer concise replies.`,
      "utf8",
    );

    // 2. Seed native Codex memories (markdown file + read-only memories_1.sqlite)
    const codexMemDir = join(fakeHome, ".codex", "memories");
    mkdirSync(codexMemDir, { recursive: true });
    writeFileSync(
      join(codexMemDir, "codex_tip.md"),
      `---\nname: codex-tip\nproject: my-app\ntype: pattern\n---\n\nUse WAL mode for SQLite.`,
      "utf8",
    );
    const codexDbPath = join(fakeHome, ".codex", "memories_1.sqlite");
    const codexDb = new Database(codexDbPath);
    codexDb.exec(`CREATE TABLE stage1_outputs (
      thread_id TEXT PRIMARY KEY,
      source_updated_at INTEGER NOT NULL,
      raw_memory TEXT NOT NULL,
      rollout_summary TEXT NOT NULL,
      rollout_slug TEXT,
      generated_at INTEGER NOT NULL
    )`);
    codexDb
      .prepare("INSERT INTO stage1_outputs VALUES (?,?,?,?,?,?)")
      .run("thread-1", 1000, "Always inspect migration ledger before editing schema.", "Migration rule", "migration-rule", 1000);
    codexDb.close();

    // 3. Seed native Antigravity knowledge item
    const agyTopicDir = join(fakeHome, ".gemini", "antigravity", "knowledge", "sqlite_notes", "artifacts");
    mkdirSync(agyTopicDir, { recursive: true });
    writeFileSync(
      join(fakeHome, ".gemini", "antigravity", "knowledge", "sqlite_notes", "metadata.json"),
      JSON.stringify({ title: "SQLite Notes", summary: "Pragmas and locks", projectId: "my-app" }),
      "utf8",
    );
    writeFileSync(join(agyTopicDir, "overview.md"), "Enable foreign_keys = ON per connection.", "utf8");

    // 4. Create target Brain DB with an existing normal Brain memory (must stay untouched!)
    const dbPath = join(dir, "brain.db");
    const initDb = openDatabase(dbPath);
    const repo = new SqliteMemoryRepository(initDb.raw, new FakeEmbeddingProvider(), "antigravity");
    const brainAuthored = await repo.create({
      type: "decision",
      content: "Core Brain architecture decision written directly via brain_remember",
      scope: { kind: "project", id: "my-app" },
      source: { origin: "agent", agentId: "antigravity" },
    });
    initDb.close();

    // Dry run must perform zero writes and zero backups
    const dry = await syncNativeMemories({ dbPath, homeDir: fakeHome, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.discovered, 5);
    assert.equal(dry.added, 5);
    assert.equal(dry.backup, null);
    assert.equal(existsSync(join(dir, ".brain-backups")), false);

    // Real sync: backs up DB, adds 5 mirrors, embeds them, preserves original Brain record and native files
    const first = await syncNativeMemories({ dbPath, homeDir: fakeHome, embeddings: new FakeEmbeddingProvider() });
    assert.equal(first.added, 5);
    assert.equal(first.updated, 0);
    assert.equal(first.archived, 0);
    assert.equal(first.embedded, 5);
    assert.equal(first.embeddingFailed, 0);
    assert.ok(first.backup, "expected automatic pre-sync backup");
    assert.equal(readFileSync(claudeProjectFile, "utf8"), claudeProjectOriginal, "native source file must remain byte-identical");

    // Verify DB contents: 1 original Brain memory + 5 dedicated native mirrors (FTS-searchable)
    const verify1 = openDatabase(dbPath, { readonly: true });
    try {
      const original = verify1.raw.prepare("SELECT content, status, source_origin FROM memories WHERE id = ?").get(brainAuthored.id) as {
        content: string;
        status: string;
        source_origin: string;
      };
      assert.equal(original.content, brainAuthored.content);
      assert.equal(original.status, "active");
      assert.equal(original.source_origin, "agent");

      const mirrors = verify1.raw
        .prepare("SELECT source_agent_id, scope_kind, scope_id, type, confidence, tags, source_ref FROM memories WHERE source_ref LIKE 'native-mirror:%' ORDER BY source_ref")
        .all() as { source_agent_id: string; scope_kind: string; scope_id: string | null; type: string; confidence: number; tags: string; source_ref: string }[];
      assert.equal(mirrors.length, 5);
      for (const m of mirrors) {
        assert.equal(m.confidence, 0.95);
        const parsedTags = JSON.parse(m.tags) as string[];
        assert.ok(parsedTags.includes("native-mirror"));
        assert.ok(parsedTags.includes("native-authoritative"));
      }
      assert.ok(mirrors.some((m) => m.source_agent_id === "claude-code" && m.scope_kind === "project" && m.scope_id === "my-app" && m.type === "rule"));
      assert.ok(mirrors.some((m) => m.source_agent_id === "claude-code" && m.scope_kind === "global" && m.scope_id === null && m.type === "preference"));
      assert.ok(mirrors.some((m) => m.source_agent_id === "codex" && m.source_ref.includes("stage1:thread-1")));
      assert.ok(mirrors.some((m) => m.source_agent_id === "antigravity" && m.scope_id === "my-app"));
      assert.equal(
        (verify1.raw.prepare("SELECT count(*) as n FROM memories_fts WHERE memories_fts MATCH 'WAL'").get() as { n: number }).n,
        1,
      );
    } finally {
      verify1.close();
    }

    // Re-running with unchanged native files must be an idempotent no-op (zero new backup)
    const backupsBefore = readdirSync(join(dir, ".brain-backups")).length;
    const second = await syncNativeMemories({ dbPath, homeDir: fakeHome, embeddings: new FakeEmbeddingProvider() });
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.archived, 0);
    assert.equal(second.unchanged, 5);
    assert.equal(second.backup, null);
    assert.equal(readdirSync(join(dir, ".brain-backups")).length, backupsBefore);

    // Updating a native file updates the mirror (native has priority); deleting a native file soft-archives only its mirror
    writeFileSync(
      claudeProjectFile,
      `---\nname: build-rule\ndescription: "Always run build before test"\nmetadata:\n  type: feedback\n---\n\nRun npm run check before pushing.`,
      "utf8",
    );
    unlinkSync(join(codexMemDir, "codex_tip.md"));

    const third = await syncNativeMemories({ dbPath, homeDir: fakeHome, embeddings: new FakeEmbeddingProvider() });
    assert.equal(third.updated, 1);
    assert.equal(third.archived, 1);
    assert.equal(third.unchanged, 3);

    // Changing native type triggers supersede (old archived, new active with supersedes edge)
    writeFileSync(
      claudeProjectFile,
      `---\nname: build-rule\ndescription: "Always run build before test"\nmetadata:\n  type: project\n---\n\nRun npm run check before pushing.`,
      "utf8",
    );
    const fourth = await syncNativeMemories({ dbPath, homeDir: fakeHome });
    assert.equal(fourth.superseded, 1);

    const verify2 = openDatabase(dbPath, { readonly: true });
    try {
      const supersededRow = verify2.raw
        .prepare("SELECT id, type, status, supersedes FROM memories WHERE source_ref LIKE '%build_rule.md' AND status = 'active'")
        .get() as { id: string; type: string; status: string; supersedes: string | null };
      assert.equal(supersededRow.type, "project_state");
      assert.ok(supersededRow.supersedes, "expected supersedes pointer to archived predecessor");

      // Original Brain-authored memory is still completely untouched
      const original = verify2.raw.prepare("SELECT status FROM memories WHERE id = ?").get(brainAuthored.id) as { status: string };
      assert.equal(original.status, "active");
    } finally {
      verify2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
