import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
import {
  previewMemoryMerge,
  applyMemoryMerge,
  reindexMemoryDatabase,
  appliedMigrations,
  syncNativeMemories,
  watchNativeMemories,
  type CustomNativeSource,
  type NativeSyncResult,
} from "@brain/storage";

export function mergeMemoryDatabases(source: string, target: string, reviewedDigest?: string) {
  return reviewedDigest === undefined ? previewMemoryMerge(source, target) : applyMemoryMerge(source, target, reviewedDigest);
}

export function syncNativeMemorySources(
  dbPath: string,
  options: {
    homeDir?: string;
    harnesses?: string[];
    customSources?: CustomNativeSource[];
    dryRun?: boolean;
    backup?: boolean;
    embed?: boolean;
    cacheDir?: string;
    localFilesOnly?: boolean;
  } = {},
) {
  const embeddings = options.embed === false ? undefined : new LocalEmbeddingProvider(options);
  return syncNativeMemories({
    dbPath,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.harnesses !== undefined ? { harnesses: options.harnesses } : {}),
    ...(options.customSources !== undefined ? { customSources: options.customSources } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.backup !== undefined ? { backup: options.backup } : {}),
    ...(embeddings !== undefined ? { embeddings } : {}),
  });
}

export function watchNativeMemorySources(
  dbPath: string,
  options: {
    homeDir?: string;
    harnesses?: string[];
    customSources?: CustomNativeSource[];
    embed?: boolean;
    cacheDir?: string;
    localFilesOnly?: boolean;
  } = {},
  onSync?: (result: NativeSyncResult) => void,
  onError?: (error: unknown) => void,
) {
  const embeddings = options.embed === false ? undefined : new LocalEmbeddingProvider(options);
  return watchNativeMemories(
    {
      dbPath,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.harnesses !== undefined ? { harnesses: options.harnesses } : {}),
      ...(options.customSources !== undefined ? { customSources: options.customSources } : {}),
      ...(embeddings !== undefined ? { embeddings } : {}),
    },
    onSync,
    onError,
  );
}

export function upgradeMemoryDatabase(path: string) {
  const db = openDatabase(path);
  try { return { database: path, migrations: appliedMigrations(db.raw) }; }
  finally { db.close(); }
}

export interface MemoryDatabaseInspection {
  path: string;
  exists: boolean;
  valid: boolean;
  sizeBytes: number | null;
  memoriesTotal: number;
  memoriesActive: number;
  appliedMigrationsCount: number;
  latestMigration: string | null;
  vectorSearchAvailable: boolean;
  error?: string;
}

export function inspectMemoryDatabase(path: string): MemoryDatabaseInspection {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      valid: false,
      sizeBytes: null,
      memoriesTotal: 0,
      memoriesActive: 0,
      appliedMigrationsCount: 0,
      latestMigration: null,
      vectorSearchAvailable: false,
    };
  }
  const sizeBytes = statSync(path).size;
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(path, { readonly: true });
    const hasMemories = Boolean(
      db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get(),
    );
    const hasMigrations = Boolean(
      db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(),
    );
    let memoriesTotal = 0;
    let memoriesActive = 0;
    if (hasMemories) {
      const row = db.raw
        .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM memories")
        .get() as { total: number; active: number | null };
      memoriesTotal = row.total;
      memoriesActive = row.active ?? 0;
    }
    const migrations = hasMigrations ? appliedMigrations(db.raw) : [];
    return {
      path,
      exists: true,
      valid: hasMemories,
      sizeBytes,
      memoriesTotal,
      memoriesActive,
      appliedMigrationsCount: migrations.length,
      latestMigration: migrations[migrations.length - 1] ?? null,
      vectorSearchAvailable: db.vectorSearchAvailable,
      ...(hasMemories ? {} : { error: "SQLite file is missing the memories table" }),
    };
  } catch (error) {
    return {
      path,
      exists: true,
      valid: false,
      sizeBytes,
      memoriesTotal: 0,
      memoriesActive: 0,
      appliedMigrationsCount: 0,
      latestMigration: null,
      vectorSearchAvailable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
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
