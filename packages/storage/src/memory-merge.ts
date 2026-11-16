import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import { MemoryRecordSchema, type MemoryRecord, type EmbeddingProvider } from "@brain/contracts";
import { openDatabase, backupDatabase, assertCompatibleSchema } from "./db.js";
import { rowToRecord } from "./memory-repository.js";
import { insertMutationEventRow } from "./event-store.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a: MemoryRecord, b: MemoryRecord) => JSON.stringify(a) === JSON.stringify(b);
function records(db: Database.Database): MemoryRecord[] {
  assertCompatibleSchema(db);
  const columns = db.prepare("PRAGMA table_info(memories)").all() as {name: string}[];
  const supported = new Set(["id","type","content","domain","scope_kind","scope_id","source_origin","source_agent_id","source_session_id","source_task_id","source_ref","confidence","status","tags","supersedes","created_at","updated_at"]);
  if (columns.some(column => !supported.has(column.name))) throw new Error("Unsupported memory fields; use a compatible release before merging");
  return (db.prepare("SELECT * FROM memories ORDER BY id").all() as Parameters<typeof rowToRecord>[0][])
    .map(row => MemoryRecordSchema.parse(rowToRecord(row)));
}
function paths(source: string, target: string) {
  const from = realpathSync(source), into = realpathSync(target);
  const a = statSync(from), b = statSync(into);
  if (from === into || (a.dev === b.dev && a.ino === b.ino)) throw new Error("Both paths already refer to the same Brain database");
  return { from, into };
}
function plan(source: MemoryRecord[], target: MemoryRecord[]) {
  const incoming = new Map(source.map(r => [r.id, r]));
  const existing = new Map(target.map(r => [r.id, r]));
  const mapped = new Map<string, MemoryRecord>();
  const visiting = new Set<string>();
  let conflicts = 0;
  function map(id: string): MemoryRecord {
    const done = mapped.get(id); if (done) return done;
    const record = incoming.get(id);
    if (!record || visiting.has(id) || visiting.size > 1000) throw new Error("Source contains missing, cyclic or excessively deep supersedes references");
    visiting.add(id);
    let result = { ...record, supersedes: record.supersedes ? map(record.supersedes).id : null };
    const current = existing.get(id);
    if (current && !equal(current, result)) {
      conflicts++;
      const h = digest(["memory-atlas-import-v1", result]);
      result = { ...result, id: `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}` };
    }
    const collision = existing.get(result.id);
    if (collision && !equal(collision, result)) throw new Error("An imported revision was modified in the target; resolve that conflict before merging");
    mapped.set(id, result); visiting.delete(id); return result;
  }
  source.forEach(r => map(r.id));
  const additions = [...mapped.values()].filter(r => !existing.has(r.id));
  return { additions, conflicts, skipped: source.length - additions.length,
    digest: digest({ source, target }), total: source.length };
}

export function previewMemoryMerge(sourcePath: string, targetPath: string) {
  const {from, into} = paths(sourcePath, targetPath);
  const source = openDatabase(from, {readonly: true});
  try {
    const target = openDatabase(into, {readonly: true});
    try {
      const result = plan(records(source.raw), records(target.raw));
      return { digest: result.digest, total: result.total, additions: result.additions.length,
        conflictsKeptSeparately: result.conflicts, skipped: result.skipped };
    } finally { target.close(); }
  } finally { source.close(); }
}

/** Administrative snapshot merge, not a harness tool: keeps scopes, revisions and source data intact. */
export function applyMemoryMerge(sourcePath: string, targetPath: string, expectedDigest: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Apply requires the digest from a reviewed merge preview");
  const {from, into} = paths(sourcePath, targetPath);
  const source = openDatabase(from, {readonly: true});
  try {
    const sourceRows = records(source.raw);
    const target = openDatabase(into);
    try {
      const initial = plan(sourceRows, records(target.raw));
      if (initial.digest !== expectedDigest) throw new Error("Merge preview is stale; preview again before applying");
      const active = target.raw.prepare("SELECT 1 FROM runtime_instances WHERE updated_at >= ? LIMIT 1")
        .get(new Date(Date.now() - 90_000).toISOString());
      if (active) throw new Error("Stop Brain MCP processes before applying a database merge");
      if (!initial.additions.length) return { imported: 0, skipped: initial.skipped, backup: null, semanticIndexPending: 0 };
      const backup = backupDatabase(target.raw, into, "merge");
      const insert = target.raw.prepare(`INSERT INTO memories
        (id,type,content,domain,scope_kind,scope_id,source_origin,source_agent_id,source_session_id,source_task_id,source_ref,confidence,status,tags,supersedes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      target.raw.transaction(() => {
        if (target.raw.prepare("SELECT 1 FROM runtime_instances WHERE updated_at >= ? LIMIT 1").get(new Date(Date.now() - 90_000).toISOString())) {
          throw new Error("Stop Brain MCP processes before applying a database merge");
        }
        const fresh = plan(sourceRows, records(target.raw));
        if (fresh.digest !== expectedDigest) throw new Error("Target changed while preparing merge; preview again");
        target.raw.pragma("defer_foreign_keys = ON");
        for (const r of fresh.additions) {
          insert.run(r.id,r.type,r.content,r.domain,r.scope.kind,r.scope.id,r.source.origin,r.source.agentId ?? null,
            r.source.sessionId ?? null,r.source.taskId ?? null,r.source.sourceRef ?? null,r.confidence,r.status,
            JSON.stringify(r.tags),r.supersedes,r.createdAt,r.updatedAt);
          insertMutationEventRow(target.raw, { id: randomUUID(),timestamp: new Date().toISOString(),memoryId: r.id,
            mutationType: "create",actor: {origin: "import"},summary: `Database snapshot import ${expectedDigest}` });
        }
      }).immediate();
      return { imported: initial.additions.length, skipped: initial.skipped, backup, semanticIndexPending: initial.additions.length };
    } finally { target.close(); }
  } finally { source.close(); }
}

export async function reindexMemoryDatabase(path: string, embeddings: EmbeddingProvider) {
  const db = openDatabase(realpathSync(path));
  let indexed = 0, failed = 0;
  try {
    if (!db.vectorSearchAvailable) throw new Error("Semantic indexing is unavailable on this platform");
    for (const r of records(db.raw).filter(r => r.status === "active")) {
      try {
        const vector = JSON.stringify(await embeddings.embed(r.content));
        db.raw.transaction(() => {
          const current = db.raw.prepare("SELECT content,status FROM memories WHERE id=?").get(r.id) as {content: string; status: string} | undefined;
          if (current?.content !== r.content || current.status !== "active") { failed++; return; }
          if (db.raw.prepare("SELECT 1 FROM memory_vectors WHERE memory_id=?").get(r.id)) {
            db.raw.prepare("UPDATE memory_vectors SET embedding=? WHERE memory_id=?").run(vector, r.id);
          } else db.raw.prepare("INSERT INTO memory_vectors (memory_id,embedding) VALUES (?,?)").run(r.id, vector);
          indexed++;
        }).immediate();
      } catch { failed++; }
    }
    return { indexed, failed };
  } finally { db.close(); }
}
