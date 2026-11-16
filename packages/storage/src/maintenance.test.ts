import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./db.js";
import { previewMemoryMerge, applyMemoryMerge, reindexMemoryDatabase } from "./memory-merge.js";
import { SqliteMemoryRepository } from "./memory-repository.js";
import { FakeEmbeddingProvider } from "@brain/test-fixtures";

test("an existing database is backed up before upgrade and a newer schema is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-upgrade-"));
  try {
    const path = join(dir, "brain.db");
    const first = openDatabase(path); first.close();
    const old = new Database(path);
    old.exec("DROP TABLE usage_events; DROP TABLE runtime_instances; ALTER TABLE retrieval_events DROP COLUMN harness_id; ALTER TABLE context_events DROP COLUMN harness_id; ALTER TABLE feedback_events DROP COLUMN harness_id; ALTER TABLE outcome_events DROP COLUMN harness_id; DELETE FROM schema_migrations WHERE name='0008_harness_observability.sql'");
    old.close();
    const upgraded = openDatabase(path); upgraded.close();
    const backups = readdirSync(join(dir, ".brain-backups"));
    assert.equal(backups.length, 1);
    const snapshot = new Database(join(dir, ".brain-backups", backups[0]!), {readonly: true});
    assert.equal(snapshot.prepare("SELECT count(*) n FROM schema_migrations WHERE name='0008_harness_observability.sql'").get() &&
      (snapshot.prepare("SELECT count(*) n FROM schema_migrations WHERE name='0008_harness_observability.sql'").get() as {n: number}).n, 0);
    snapshot.close();
    const again = openDatabase(path); again.close();
    assert.equal(readdirSync(join(dir, ".brain-backups")).length, 1);
    const future = new Database(path);
    future.prepare("INSERT INTO schema_migrations VALUES (?,?)").run("9999_future.sql", "now"); future.close();
    assert.throws(() => openDatabase(path), /newer|unsupported/i);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("merge previews changes, preserves conflicting revisions/private scopes and is repeatable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-merge-"));
  try {
    const from = join(dir, "claude.db"), into = join(dir, "codex.db");
    const source = openDatabase(from), target = openDatabase(into);
    const repo = new SqliteMemoryRepository(source.raw, new FakeEmbeddingProvider());
    const first = await repo.create({type: "fact", content: "source convention", scope: {kind: "project", id: "harness:claude-code:example"}, source: {origin: "agent", agentId: "claude-code"}});
    await repo.create({type: "decision", content: "source successor", scope: first.scope, supersedes: first.id});
    target.raw.prepare(`INSERT INTO memories (id,type,content,scope_kind,scope_id,source_origin,confidence,status,tags,created_at,updated_at)
      VALUES (?,'fact','target convention','project','example','agent',0.5,'active','[]',?,?)`).run(first.id,first.createdAt,first.updatedAt);
    source.close(); target.close();
    const preview = previewMemoryMerge(from, into);
    assert.equal(preview.additions, 2); assert.equal(preview.conflictsKeptSeparately, 1);
    assert.throws(() => applyMemoryMerge(from, into, "0".repeat(64)), /stale/);
    const result = applyMemoryMerge(from, into, preview.digest);
    assert.equal(result.imported, 2); assert(result.backup);
    const check = openDatabase(into, {readonly: true});
    assert.equal((check.raw.prepare("SELECT content FROM memories WHERE id=?").get(first.id) as {content: string}).content, "target convention");
    const privateRows = check.raw.prepare("SELECT id,supersedes,source_agent_id FROM memories WHERE scope_id='harness:claude-code:example' ORDER BY type").all() as {id: string; supersedes: string | null; source_agent_id: string | null}[];
    assert.equal(privateRows.length, 2);
    assert(privateRows.some(r => r.source_agent_id === "claude-code"));
    assert(privateRows.some(r => r.supersedes !== null && privateRows.some(parent => parent.id === r.supersedes)));
    assert.equal((check.raw.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'source'").get() as {n: number}).n, 2);
    check.close();
    const again = previewMemoryMerge(from, into);
    assert.equal(again.additions, 0); assert.equal(applyMemoryMerge(from, into, again.digest).imported, 0);
    assert.throws(() => previewMemoryMerge(from, from), /same Brain/);
    const indexed = await reindexMemoryDatabase(into, new FakeEmbeddingProvider());
    assert.deepEqual(indexed, {indexed: 3, failed: 0});
    const unavailable = await reindexMemoryDatabase(into, { embed: async () => { throw new Error("offline"); } });
    assert.deepEqual(unavailable, {indexed: 0, failed: 3});
    const original = openDatabase(from, {readonly: true});
    assert.equal((original.raw.prepare("SELECT count(*) n FROM memories").get() as {n: number}).n, 2);
    original.close();
    const live = openDatabase(into);
    live.raw.prepare("INSERT INTO runtime_instances VALUES ('running','codex',?,1,1)").run(new Date().toISOString());
    live.close();
    assert.throws(() => applyMemoryMerge(from, into, previewMemoryMerge(from, into).digest), /Stop Brain/);
    const future = new Database(from);
    future.prepare("INSERT INTO schema_migrations VALUES ('9999_future.sql','now')").run(); future.close();
    assert.throws(() => previewMemoryMerge(from, into), /newer|unsupported/i);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
