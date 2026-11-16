import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteMemoryRepository, SqliteEventStore, SqliteRetrievalStore, SqliteHarnessStore } from "@brain/storage";
import { FakeEmbeddingProvider } from "@brain/test-fixtures";
import { privateProjectScope, resolveRuntimeConfig } from "@brain/contracts";
import { MemoryService } from "@brain/memory";
import { RetrievalService } from "@brain/retrieval";
import { EventService } from "@brain/learning";
import { Gateway } from "@brain/gateway";
import { setupMcp } from "./setup.js";
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
