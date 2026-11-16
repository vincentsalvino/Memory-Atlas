import { randomUUID } from "node:crypto";
import { resolveRuntimeConfig } from "@brain/contracts";
import { SqliteHarnessStore } from "@brain/storage";
import { openDatabase } from "@brain/storage";
import { SqliteMemoryRepository } from "@brain/storage";
import { DEFAULT_MEMORY_RELEVANCE, SqliteRetrievalStore } from "@brain/storage";
import { SqliteEventStore } from "@brain/storage";
import { SqliteMemoryPerformanceStore } from "@brain/storage";
import { LocalEmbeddingProvider } from "@brain/storage";
import { SqliteCodeSearchStore } from "@brain/storage";
import { SqliteCodeDependencyStore } from "@brain/storage";
import { SqliteCodebaseRepository } from "@brain/storage";
import { MemoryService } from "@brain/memory";
import { RetrievalService, DEFAULT_NEAR_DUPLICATE_POLICY } from "@brain/retrieval";
import { CodeRetrievalService } from "@brain/retrieval";
import { EventService, LearningSignalService } from "@brain/learning";
import { DEFAULT_LEARNING_CONFIG } from "@brain/contracts";
import { DependencyGraphService } from "@brain/codebase";
import { Gateway } from "@brain/gateway";
import { previewMemoryMerge, applyMemoryMerge, reindexMemoryDatabase, appliedMigrations } from "@brain/storage";

export function mergeMemoryDatabases(source: string, target: string, reviewedDigest?: string) {
  return reviewedDigest === undefined ? previewMemoryMerge(source, target) : applyMemoryMerge(source, target, reviewedDigest);
}

export function upgradeMemoryDatabase(path: string) {
  const db = openDatabase(path);
  try { return { database: path, migrations: appliedMigrations(db.raw) }; }
  finally { db.close(); }
}

export function reindexMemories(path: string, options: {cacheDir?: string; localFilesOnly?: boolean}) {
  return reindexMemoryDatabase(path, new LocalEmbeddingProvider(options));
}

/**
 * The ONE file in this repository allowed to import both a concrete
 * packages/storage implementation and a packages/core service constructor
 * (PHASE_1_SPEC.md Package Architecture: "composition root"). Every other file
 * in packages/mcp imports @brain/gateway only. boundaries.test.ts is the
 * mechanical check that names this file as the sole exception -- it fails the
 * build if any other file in packages/mcp/src imports @brain/storage or a core
 * service package directly.
 */
export interface Brain {
  gateway: Gateway;
  close(): void;
}

export function createBrain(dbPath: string, options: { localFilesOnly?: boolean; cacheDir?: string; harnessId?: string } = {}): Brain {
  const config = resolveRuntimeConfig(process.env);
  const db = openDatabase(dbPath);
  const harnessId = options.harnessId ?? null;
  const harnessStore = new SqliteHarnessStore(db.raw);
  const instanceId = randomUUID();
  const heartbeat = () => { try { harnessStore.heartbeat(instanceId, harnessId, config); } catch (error) { console.warn("Runtime heartbeat failed:", error); } };
  heartbeat();
  const timer = setInterval(heartbeat, 30_000);
  timer.unref();
  const embeddings = new LocalEmbeddingProvider(options);

  const memoryRepository = new SqliteMemoryRepository(db.raw, embeddings, harnessId);
  const retrievalStore = new SqliteRetrievalStore(db.raw, embeddings, db.vectorSearchAvailable, DEFAULT_MEMORY_RELEVANCE);
  const eventStore = new SqliteEventStore(db.raw, harnessId);
  const codebaseRepository = new SqliteCodebaseRepository(db.raw);
  const codeSearchStore = new SqliteCodeSearchStore(db.raw, embeddings, db.vectorSearchAvailable);
  const codeDependencyStore = new SqliteCodeDependencyStore(db.raw);
  const performanceStore = new SqliteMemoryPerformanceStore(db.raw);

  const gateway = new Gateway(
    new MemoryService(memoryRepository),
    new RetrievalService(retrievalStore),
    new EventService(eventStore),
    { vectorSearchAvailable: db.vectorSearchAvailable },
    // User-authorized enablement; independent runtime flags support rollback.
    { enabled: config.redundancyEnabled, ...DEFAULT_NEAR_DUPLICATE_POLICY },
    new CodeRetrievalService(codeSearchStore),
    new DependencyGraphService(codebaseRepository, codeDependencyStore),
    // Keep calibrated parameters; override only production enablement.
    new LearningSignalService(performanceStore, { ...DEFAULT_LEARNING_CONFIG, enabled: config.learningEnabled }),
    harnessId,
    harnessStore,
  );

  return { gateway, close: () => { clearInterval(timer); try { harnessStore.removeInstance(instanceId); } finally { db.close(); } } };
}
