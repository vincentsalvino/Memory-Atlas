import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  MEMORY_TYPES,
  type EmbeddingProvider,
  type MemoryRecord,
  type MemoryType,
  type ScopeRef,
} from "@brain/contracts";
import { backupDatabase, openDatabase } from "./db.js";
import { insertMutationEventRow } from "./event-store.js";
import { rowToRecord } from "./memory-repository.js";

const NATIVE_MIRROR_PREFIX = "native-mirror:";
const NATIVE_MIRROR_CONFIDENCE = 0.95;

export interface NativeMemoryCandidate {
  harness: string;
  sourceRef: string;
  title: string | null;
  description: string | null;
  body: string;
  type: MemoryType;
  scope: ScopeRef;
  tags: string[];
  sourcePath: string;
  originSessionId?: string;
}

export interface CustomNativeSource {
  harness: string;
  path: string;
  scope?: ScopeRef;
}

export interface NativeSyncOptions {
  dbPath: string;
  homeDir?: string;
  harnesses?: string[];
  customSources?: CustomNativeSource[];
  dryRun?: boolean;
  backup?: boolean;
  embeddings?: EmbeddingProvider;
}

export interface NativeSyncChange {
  action: "add" | "update" | "supersede" | "archive" | "unchanged";
  harness: string;
  sourceRef: string;
  scope: ScopeRef;
  type: MemoryType;
  memoryId?: string;
}

export interface NativeSyncResult {
  dryRun: boolean;
  dbPath: string;
  backup: string | null;
  scannedHarnesses: string[];
  discovered: number;
  added: number;
  updated: number;
  superseded: number;
  archived: number;
  unchanged: number;
  embedded: number;
  embeddingFailed: number;
  warnings: string[];
  changes: NativeSyncChange[];
}

interface ParsedFrontmatter {
  meta: Record<string, string>;
  body: string;
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/** Zero-dependency frontmatter parser for native markdown memory files (supports 1-level nested maps like `metadata:`). */
export function parseNativeFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized.trim() };
  }
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { meta: {}, body: normalized.trim() };
  }
  const header = normalized.slice(4, endIndex);
  const rest = normalized.slice(endIndex + 4).replace(/^\n+/, "");
  const meta: Record<string, string> = {};
  let currentSection: string | null = null;

  for (const line of header.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = /^\s{2,}([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (nested && currentSection) {
      const key = `${currentSection}.${nested[1]!}`;
      const val = unquoteYaml(nested[2]!);
      if (val) meta[key] = val;
      continue;
    }
    const top = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (top) {
      const key = top[1]!;
      const rawVal = top[2]!.trim();
      if (!rawVal) {
        currentSection = key;
      } else {
        currentSection = null;
        meta[key] = unquoteYaml(rawVal);
      }
    }
  }
  return { meta, body: rest.trim() };
}

function mapNativeTypeToMemoryType(nativeType: string | undefined): MemoryType {
  if (!nativeType) return "fact";
  const lower = nativeType.trim().toLowerCase();
  if (lower === "feedback") return "rule";
  if (lower === "user") return "preference";
  if (lower === "reference") return "fact";
  if (lower === "project") return "project_state";
  if ((MEMORY_TYPES as readonly string[]).includes(lower)) {
    return lower as MemoryType;
  }
  return "fact";
}

function encodeClaudePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9]/g, "-");
}

function isSubdirMatch(remainderLower: string, encodedNameLower: string): "exact" | "prefix" | null {
  if (remainderLower === encodedNameLower) return "exact";
  if (remainderLower.startsWith(`${encodedNameLower}-`)) return "prefix";
  return null;
}

/**
 * Resolves a Claude Code encoded project directory name (e.g.
 * `c--Users-alice-Desktop-ai-brain`) back to a clean Memory Atlas
 * ScopeRef without breaking hyphenated folder names like `ai-brain`.
 */
export function resolveClaudeProjectScope(encodedDir: string, homeDir: string): ScopeRef {
  const containerRoots = [
    join(homeDir, "OneDrive", "Desktop"),
    join(homeDir, "OneDrive", "Documents"),
    join(homeDir, "Desktop"),
    join(homeDir, "Documents"),
    join(homeDir, "Projects"),
    join(homeDir, "projects"),
    join(homeDir, "Code"),
    join(homeDir, "code"),
    join(homeDir, "repos"),
    join(homeDir, "src"),
    homeDir,
  ];

  // Match the longest known workspace container root first.
  const encodedLower = encodedDir.toLowerCase();
  const candidates = containerRoots
    .map((dir) => ({ dir, encoded: encodeClaudePathSegment(dir) }))
    .sort((a, b) => b.encoded.length - a.encoded.length);

  for (const root of candidates) {
    const rootLower = root.encoded.toLowerCase();
    if (encodedLower === rootLower) {
      // Top-level workspace root (home/Desktop/Documents itself) holds cross-project preferences/env facts.
      return { kind: "global", id: null };
    }
    if (!encodedLower.startsWith(`${rootLower}-`)) continue;

    let currentDir = root.dir;
    let remainder = encodedDir.slice(root.encoded.length + 1);
    let lastMatchedName: string | null = null;

    while (remainder.length > 0 && existsSync(currentDir)) {
      let entries: string[];
      try {
        entries = readdirSync(currentDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((a, b) => b.length - a.length);
      } catch {
        break;
      }

      const remLower = remainder.toLowerCase();
      let matched = false;
      for (const name of entries) {
        const encName = encodeClaudePathSegment(name);
        const matchKind = isSubdirMatch(remLower, encName.toLowerCase());
        if (matchKind === "exact") {
          lastMatchedName = name;
          remainder = "";
          matched = true;
          break;
        }
        if (matchKind === "prefix") {
          currentDir = join(currentDir, name);
          lastMatchedName = name;
          remainder = remainder.slice(encName.length + 1);
          matched = true;
          break;
        }
      }
      if (!matched) break;
    }

    if (remainder.length === 0 && lastMatchedName) {
      return { kind: "project", id: lastMatchedName };
    }
    // Folder no longer exists on disk: keep deterministic project ID from remaining path segment.
    const fallbackId = remainder.length > 0 ? remainder : (lastMatchedName ?? encodedDir);
    return { kind: "project", id: fallbackId };
  }

  return { kind: "project", id: encodedDir };
}

function collectMarkdownFiles(rootDir: string, maxDepth = 3): string[] {
  const files: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }
  walk(rootDir, 0);
  return files.sort();
}

function stripTrailingSeparators(body: string): string {
  return body.replace(/(?:\n---\s*)+$/, "").trim();
}

function discoverClaudeCodeMemories(homeDir: string, warnings: string[]): { scanned: boolean; items: NativeMemoryCandidate[] } {
  const projectsDir = join(homeDir, ".claude", "projects");
  if (!existsSync(projectsDir)) return { scanned: false, items: [] };

  const items: NativeMemoryCandidate[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    warnings.push(`claude-code: unable to list ${projectsDir}: ${error instanceof Error ? error.message : String(error)}`);
    return { scanned: false, items: [] };
  }

  for (const encodedProject of projectDirs) {
    const memoryDir = join(projectsDir, encodedProject, "memory");
    if (!existsSync(memoryDir)) continue;
    const files = collectMarkdownFiles(memoryDir, 2);
    const scope = resolveClaudeProjectScope(encodedProject, homeDir);

    for (const file of files) {
      const rel = relative(memoryDir, file).replace(/\\/g, "/");
      // MEMORY.md is Claude Code's index file pointing to the individual memory files.
      if (rel.toLowerCase() === "memory.md") continue;

      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        warnings.push(`claude-code: failed reading ${file}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const parsed = parseNativeFrontmatter(raw);
      const body = stripTrailingSeparators(parsed.body);
      if (!body) continue;

      const nativeType = parsed.meta["metadata.type"] ?? parsed.meta["type"];
      const originSessionId = parsed.meta["metadata.originSessionId"] ?? parsed.meta["originSessionId"];
      const tags = nativeType ? [`native-type:${nativeType.toLowerCase()}`] : [];

      items.push({
        harness: "claude-code",
        sourceRef: `${NATIVE_MIRROR_PREFIX}claude-code:${encodedProject}/${rel}`,
        title: parsed.meta["name"] ?? basename(rel, ".md"),
        description: parsed.meta["description"] ?? null,
        body,
        type: mapNativeTypeToMemoryType(nativeType),
        scope,
        tags,
        sourcePath: `${encodedProject}/memory/${rel}`,
        ...(originSessionId ? { originSessionId } : {}),
      });
    }
  }

  return { scanned: true, items };
}

function discoverCodexMemories(homeDir: string, warnings: string[]): { scanned: boolean; items: NativeMemoryCandidate[] } {
  const codexRoot = join(homeDir, ".codex");
  if (!existsSync(codexRoot)) return { scanned: false, items: [] };

  const items: NativeMemoryCandidate[] = [];
  let scannedAny = false;

  // 1. Markdown files under ~/.codex/memories/
  const memoriesDir = join(codexRoot, "memories");
  if (existsSync(memoriesDir)) {
    scannedAny = true;
    const files = collectMarkdownFiles(memoriesDir, 3);
    for (const file of files) {
      const rel = relative(memoriesDir, file).replace(/\\/g, "/");
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        warnings.push(`codex: failed reading ${file}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const parsed = parseNativeFrontmatter(raw);
      const body = stripTrailingSeparators(parsed.body);
      if (!body) continue;

      const projectId = parsed.meta["project"] ?? parsed.meta["metadata.project"];
      const scope: ScopeRef = projectId ? { kind: "project", id: projectId } : { kind: "global", id: null };
      const nativeType = parsed.meta["metadata.type"] ?? parsed.meta["type"];

      items.push({
        harness: "codex",
        sourceRef: `${NATIVE_MIRROR_PREFIX}codex:file:${rel}`,
        title: parsed.meta["name"] ?? parsed.meta["title"] ?? basename(rel, ".md"),
        description: parsed.meta["description"] ?? null,
        body,
        type: mapNativeTypeToMemoryType(nativeType),
        scope,
        tags: nativeType ? [`native-type:${nativeType.toLowerCase()}`] : [],
        sourcePath: `.codex/memories/${rel}`,
      });
    }
  }

  // 2. Read-only inspection of ~/.codex/memories_1.sqlite stage1_outputs
  const sqlitePath = join(codexRoot, "memories_1.sqlite");
  if (existsSync(sqlitePath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stage1_outputs'").get();
      if (hasTable) {
        scannedAny = true;
        const rows = db
          .prepare(
            "SELECT thread_id, rollout_slug, raw_memory, rollout_summary FROM stage1_outputs WHERE trim(raw_memory) != '' ORDER BY thread_id",
          )
          .all() as { thread_id: string; rollout_slug: string | null; raw_memory: string; rollout_summary: string }[];

        for (const row of rows) {
          const body = row.raw_memory.trim();
          if (!body) continue;
          const slug = row.rollout_slug?.trim() || row.thread_id;
          items.push({
            harness: "codex",
            sourceRef: `${NATIVE_MIRROR_PREFIX}codex:stage1:${row.thread_id}`,
            title: slug,
            description: row.rollout_summary?.trim() ? row.rollout_summary.trim().slice(0, 240) : null,
            body,
            type: "experience",
            scope: { kind: "global", id: null },
            tags: ["native-type:stage1"],
            sourcePath: `.codex/memories_1.sqlite#${slug}`,
            originSessionId: row.thread_id,
          });
        }
      }
    } catch (error) {
      warnings.push(`codex: unable to read ${sqlitePath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db?.close();
    }
  }

  return { scanned: scannedAny, items };
}

function discoverAntigravityMemories(homeDir: string, warnings: string[]): { scanned: boolean; items: NativeMemoryCandidate[] } {
  const knowledgeDir = join(homeDir, ".gemini", "antigravity", "knowledge");
  const configMemoriesDir = join(homeDir, ".gemini", "config", "memories");
  const hasKnowledge = existsSync(knowledgeDir);
  const hasConfigMemories = existsSync(configMemoriesDir);
  if (!hasKnowledge && !hasConfigMemories) return { scanned: false, items: [] };

  const items: NativeMemoryCandidate[] = [];

  if (hasKnowledge) {
    let topics: string[];
    try {
      topics = readdirSync(knowledgeDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      warnings.push(`antigravity: unable to list ${knowledgeDir}: ${error instanceof Error ? error.message : String(error)}`);
      topics = [];
    }

    for (const topic of topics) {
      const topicDir = join(knowledgeDir, topic);
      let topicTitle = topic;
      let topicSummary: string | null = null;
      let scope: ScopeRef = { kind: "global", id: null };

      const metadataPath = join(topicDir, "metadata.json");
      if (existsSync(metadataPath)) {
        try {
          const meta = JSON.parse(readFileSync(metadataPath, "utf8")) as {
            title?: string;
            summary?: string;
            project?: string;
            projectId?: string;
          };
          if (meta.title) topicTitle = meta.title;
          if (meta.summary) topicSummary = meta.summary;
          const projectId = meta.projectId ?? meta.project;
          if (projectId) scope = { kind: "project", id: projectId };
        } catch (error) {
          warnings.push(`antigravity: malformed metadata.json in ${topic}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const artifactsDir = join(topicDir, "artifacts");
      const files = collectMarkdownFiles(existsSync(artifactsDir) ? artifactsDir : topicDir, 3);
      for (const file of files) {
        const rel = relative(topicDir, file).replace(/\\/g, "/");
        let raw: string;
        try {
          raw = readFileSync(file, "utf8");
        } catch (error) {
          warnings.push(`antigravity: failed reading ${file}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const parsed = parseNativeFrontmatter(raw);
        const body = stripTrailingSeparators(parsed.body);
        if (!body) continue;

        const projectFromFrontmatter = parsed.meta["project"] ?? parsed.meta["metadata.project"];
        const resolvedScope: ScopeRef = projectFromFrontmatter ? { kind: "project", id: projectFromFrontmatter } : scope;
        const nativeType = parsed.meta["metadata.type"] ?? parsed.meta["type"];

        items.push({
          harness: "antigravity",
          sourceRef: `${NATIVE_MIRROR_PREFIX}antigravity:knowledge:${topic}/${rel}`,
          title: parsed.meta["name"] ?? parsed.meta["title"] ?? `${topicTitle} — ${basename(rel, ".md")}`,
          description: parsed.meta["description"] ?? topicSummary,
          body,
          type: mapNativeTypeToMemoryType(nativeType),
          scope: resolvedScope,
          tags: ["native-type:knowledge"],
          sourcePath: `knowledge/${topic}/${rel}`,
        });
      }
    }
  }

  if (hasConfigMemories) {
    const files = collectMarkdownFiles(configMemoriesDir, 3);
    for (const file of files) {
      const rel = relative(configMemoriesDir, file).replace(/\\/g, "/");
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        warnings.push(`antigravity: failed reading ${file}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const parsed = parseNativeFrontmatter(raw);
      const body = stripTrailingSeparators(parsed.body);
      if (!body) continue;

      const projectId = parsed.meta["project"] ?? parsed.meta["metadata.project"];
      const scope: ScopeRef = projectId ? { kind: "project", id: projectId } : { kind: "global", id: null };
      const nativeType = parsed.meta["metadata.type"] ?? parsed.meta["type"];

      items.push({
        harness: "antigravity",
        sourceRef: `${NATIVE_MIRROR_PREFIX}antigravity:memory:${rel}`,
        title: parsed.meta["name"] ?? parsed.meta["title"] ?? basename(rel, ".md"),
        description: parsed.meta["description"] ?? null,
        body,
        type: mapNativeTypeToMemoryType(nativeType),
        scope,
        tags: nativeType ? [`native-type:${nativeType.toLowerCase()}`] : [],
        sourcePath: `.gemini/config/memories/${rel}`,
      });
    }
  }

  return { scanned: true, items };
}

function discoverCustomSource(source: CustomNativeSource, warnings: string[]): { scanned: boolean; items: NativeMemoryCandidate[] } {
  const root = resolve(source.path);
  if (!existsSync(root)) {
    warnings.push(`${source.harness}: custom source path does not exist: ${root}`);
    return { scanned: false, items: [] };
  }

  const stat = statSync(root);
  const files = stat.isDirectory() ? collectMarkdownFiles(root, 4) : [root];
  const items: NativeMemoryCandidate[] = [];

  for (const file of files) {
    const rel = stat.isDirectory() ? relative(root, file).replace(/\\/g, "/") : basename(file);
    if (rel.toLowerCase() === "memory.md") continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      warnings.push(`${source.harness}: failed reading ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parseNativeFrontmatter(raw);
    const body = stripTrailingSeparators(parsed.body);
    if (!body) continue;

    const projectId = parsed.meta["project"] ?? parsed.meta["metadata.project"];
    const scope: ScopeRef = source.scope ?? (projectId ? { kind: "project", id: projectId } : { kind: "global", id: null });
    const nativeType = parsed.meta["metadata.type"] ?? parsed.meta["type"];

    items.push({
      harness: source.harness,
      sourceRef: `${NATIVE_MIRROR_PREFIX}${source.harness}:custom:${rel}`,
      title: parsed.meta["name"] ?? parsed.meta["title"] ?? basename(rel, ".md"),
      description: parsed.meta["description"] ?? null,
      body,
      type: mapNativeTypeToMemoryType(nativeType),
      scope,
      tags: nativeType ? [`native-type:${nativeType.toLowerCase()}`] : [],
      sourcePath: rel,
    });
  }

  return { scanned: true, items };
}

export function formatMirroredNativeContent(candidate: NativeMemoryCandidate): string {
  const headerLines = [
    `[Native Memory (${candidate.harness}) — authoritative source: ${candidate.sourcePath}]`,
  ];
  if (candidate.title) headerLines.push(`Title: ${candidate.title}`);
  if (candidate.description) headerLines.push(`Summary: ${candidate.description}`);
  return `${headerLines.join("\n")}\n\n${candidate.body.trim()}`;
}

function mirrorTags(candidate: NativeMemoryCandidate): string[] {
  return [...new Set(["native-mirror", `native-source:${candidate.harness}`, "native-authoritative", ...candidate.tags])].sort();
}

function sameScope(a: ScopeRef, b: ScopeRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, idx) => value === sortedB[idx]);
}

function harnessFromSourceRef(sourceRef: string): string | null {
  if (!sourceRef.startsWith(NATIVE_MIRROR_PREFIX)) return null;
  const rest = sourceRef.slice(NATIVE_MIRROR_PREFIX.length);
  const colon = rest.indexOf(":");
  return colon === -1 ? null : rest.slice(0, colon);
}

/**
 * Mirrors native harness memories (Claude Code, Codex, Antigravity, and optional
 * custom sources) into the shared Memory Atlas SQLite database as dedicated,
 * clearly attributed `native-mirror:*` entries.
 *
 * Guarantees:
 * - Strictly read-only on all native harness files/databases.
 * - Never modifies, overwrites, or deletes non-mirror Memory Atlas records.
 * - Native source has priority: edits at the native source update/supersede the
 *   mirrored row; deletions at the native source soft-archive the mirrored row.
 * - Idempotent: repeated runs with unchanged native sources perform zero writes.
 * - Takes an automatic WAL-consistent backup before applying any changes on disk.
 */
export async function syncNativeMemories(options: NativeSyncOptions): Promise<NativeSyncResult> {
  const homeDir = options.homeDir ?? homedir();
  const dryRun = options.dryRun ?? false;
  const shouldBackup = options.backup ?? true;
  const filterSet = options.harnesses?.length ? new Set(options.harnesses.map((h) => h.toLowerCase())) : null;
  const warnings: string[] = [];
  const scannedHarnesses: string[] = [];
  const discovered: NativeMemoryCandidate[] = [];

  const allow = (harness: string) => !filterSet || filterSet.has(harness.toLowerCase());

  if (allow("claude-code")) {
    const res = discoverClaudeCodeMemories(homeDir, warnings);
    if (res.scanned) scannedHarnesses.push("claude-code");
    discovered.push(...res.items);
  }
  if (allow("codex")) {
    const res = discoverCodexMemories(homeDir, warnings);
    if (res.scanned) scannedHarnesses.push("codex");
    discovered.push(...res.items);
  }
  if (allow("antigravity")) {
    const res = discoverAntigravityMemories(homeDir, warnings);
    if (res.scanned) scannedHarnesses.push("antigravity");
    discovered.push(...res.items);
  }
  for (const custom of options.customSources ?? []) {
    if (!allow(custom.harness)) continue;
    const res = discoverCustomSource(custom, warnings);
    if (res.scanned && !scannedHarnesses.includes(custom.harness)) scannedHarnesses.push(custom.harness);
    discovered.push(...res.items);
  }

  // Deduplicate candidates by sourceRef (first wins) so duplicate custom configs never collide.
  const byRef = new Map<string, NativeMemoryCandidate>();
  for (const item of discovered) {
    if (!byRef.has(item.sourceRef)) byRef.set(item.sourceRef, item);
  }
  const uniqueDiscovered = [...byRef.values()];

  const db = openDatabase(options.dbPath, dryRun ? { readonly: true } : undefined);
  try {
    if (!dryRun) {
      db.raw.pragma("busy_timeout = 5000");
    }

    const existingRows = (
      db.raw
        .prepare("SELECT * FROM memories WHERE status = 'active' AND source_origin = 'import' AND source_ref LIKE 'native-mirror:%'")
        .all() as Parameters<typeof rowToRecord>[0][]
    ).map(rowToRecord);

    const activeByRef = new Map<string, MemoryRecord>();
    for (const row of existingRows) {
      if (row.source.sourceRef) activeByRef.set(row.source.sourceRef, row);
    }

    const changes: NativeSyncChange[] = [];
    const toAdd: { id: string; candidate: NativeMemoryCandidate; content: string; tags: string[]; supersedes: string | null }[] = [];
    const toUpdate: { existing: MemoryRecord; candidate: NativeMemoryCandidate; content: string; tags: string[] }[] = [];
    const toArchive: { existing: MemoryRecord; harness: string; reason: string }[] = [];

    for (const candidate of uniqueDiscovered) {
      const content = formatMirroredNativeContent(candidate);
      const tags = mirrorTags(candidate);
      const existing = activeByRef.get(candidate.sourceRef);

      if (!existing) {
        const id = randomUUID();
        toAdd.push({ id, candidate, content, tags, supersedes: null });
        changes.push({
          action: "add",
          harness: candidate.harness,
          sourceRef: candidate.sourceRef,
          scope: candidate.scope,
          type: candidate.type,
          memoryId: id,
        });
        continue;
      }

      if (
        existing.content === content &&
        existing.type === candidate.type &&
        sameScope(existing.scope, candidate.scope) &&
        sameTags(existing.tags, tags) &&
        existing.confidence === NATIVE_MIRROR_CONFIDENCE
      ) {
        changes.push({
          action: "unchanged",
          harness: candidate.harness,
          sourceRef: candidate.sourceRef,
          scope: candidate.scope,
          type: candidate.type,
          memoryId: existing.id,
        });
        continue;
      }

      if (existing.type === candidate.type && sameScope(existing.scope, candidate.scope)) {
        toUpdate.push({ existing, candidate, content, tags });
        changes.push({
          action: "update",
          harness: candidate.harness,
          sourceRef: candidate.sourceRef,
          scope: candidate.scope,
          type: candidate.type,
          memoryId: existing.id,
        });
      } else {
        // Scope or type changed at the authoritative native source: preserve immutability via archive + supersedes.
        const id = randomUUID();
        toArchive.push({ existing, harness: candidate.harness, reason: "superseded by updated native memory scope/type" });
        toAdd.push({ id, candidate, content, tags, supersedes: existing.id });
        changes.push({
          action: "supersede",
          harness: candidate.harness,
          sourceRef: candidate.sourceRef,
          scope: candidate.scope,
          type: candidate.type,
          memoryId: id,
        });
      }
    }

    // Soft-archive mirrors whose authoritative native source file was removed (only for harnesses scanned cleanly).
    const scannedSet = new Set(scannedHarnesses);
    for (const [ref, existing] of activeByRef) {
      if (byRef.has(ref)) continue;
      const harness = harnessFromSourceRef(ref);
      if (!harness || !scannedSet.has(harness)) continue;
      toArchive.push({ existing, harness, reason: "authoritative native memory removed at source" });
      changes.push({
        action: "archive",
        harness,
        sourceRef: ref,
        scope: existing.scope,
        type: existing.type,
        memoryId: existing.id,
      });
    }

    const addedCount = changes.filter((c) => c.action === "add").length;
    const updatedCount = changes.filter((c) => c.action === "update").length;
    const supersededCount = changes.filter((c) => c.action === "supersede").length;
    const archivedCount = changes.filter((c) => c.action === "archive").length;
    const unchangedCount = changes.filter((c) => c.action === "unchanged").length;

    const hasMutations = toAdd.length > 0 || toUpdate.length > 0 || toArchive.length > 0;
    let backupPath: string | null = null;
    const idsToEmbed: { id: string; content: string }[] = [];

    if (!dryRun && hasMutations) {
      if (shouldBackup && options.dbPath !== ":memory:") {
        backupPath = backupDatabase(db.raw, options.dbPath, "native-sync");
      }

      const now = new Date().toISOString();
      const insertStmt = db.raw.prepare(
        `INSERT INTO memories (
          id, type, content, domain, scope_kind, scope_id,
          source_origin, source_agent_id, source_session_id, source_task_id, source_ref,
          confidence, status, tags, supersedes, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const updateStmt = db.raw.prepare(
        `UPDATE memories SET content = ?, tags = ?, confidence = ?, updated_at = ? WHERE id = ?`,
      );
      const archiveStmt = db.raw.prepare(`UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`);

      db.raw
        .transaction(() => {
          for (const item of toArchive) {
            archiveStmt.run(now, item.existing.id);
            insertMutationEventRow(db.raw, {
              id: randomUUID(),
              timestamp: now,
              memoryId: item.existing.id,
              mutationType: "archive",
              actor: { origin: "import", agentId: item.harness },
              summary: item.reason,
            });
          }

          for (const item of toAdd) {
            insertStmt.run(
              item.id,
              item.candidate.type,
              item.content,
              "native-memory",
              item.candidate.scope.kind,
              item.candidate.scope.id,
              "import",
              item.candidate.harness,
              item.candidate.originSessionId ?? null,
              null,
              item.candidate.sourceRef,
              NATIVE_MIRROR_CONFIDENCE,
              "active",
              JSON.stringify(item.tags),
              item.supersedes,
              now,
              now,
            );
            insertMutationEventRow(db.raw, {
              id: randomUUID(),
              timestamp: now,
              memoryId: item.id,
              mutationType: "create",
              actor: { origin: "import", agentId: item.candidate.harness },
              summary: item.supersedes
                ? `superseded native mirror ${item.candidate.sourceRef}`
                : `mirrored native memory ${item.candidate.sourceRef}`,
            });
            idsToEmbed.push({ id: item.id, content: item.content });
          }

          for (const item of toUpdate) {
            updateStmt.run(item.content, JSON.stringify(item.tags), NATIVE_MIRROR_CONFIDENCE, now, item.existing.id);
            insertMutationEventRow(db.raw, {
              id: randomUUID(),
              timestamp: now,
              memoryId: item.existing.id,
              mutationType: "update",
              actor: { origin: "import", agentId: item.candidate.harness },
              summary: `synced native memory update ${item.candidate.sourceRef}`,
            });
            idsToEmbed.push({ id: item.existing.id, content: item.content });
          }
        })
        .immediate();
    }

    let embedded = 0;
    let embeddingFailed = 0;
    if (!dryRun && options.embeddings && db.vectorSearchAvailable && idsToEmbed.length > 0) {
      for (const item of idsToEmbed) {
        try {
          const vector = JSON.stringify(await options.embeddings.embed(item.content));
          db.raw
            .transaction(() => {
              const exists = db.raw.prepare("SELECT 1 FROM memory_vectors WHERE memory_id = ?").get(item.id);
              if (exists) {
                db.raw.prepare("UPDATE memory_vectors SET embedding = ? WHERE memory_id = ?").run(vector, item.id);
              } else {
                db.raw.prepare("INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)").run(item.id, vector);
              }
            })
            .immediate();
          embedded++;
        } catch {
          embeddingFailed++;
        }
      }
    }

    return {
      dryRun,
      dbPath: options.dbPath,
      backup: backupPath,
      scannedHarnesses,
      discovered: uniqueDiscovered.length,
      added: addedCount,
      updated: updatedCount,
      superseded: supersededCount,
      archived: archivedCount,
      unchanged: unchangedCount,
      embedded,
      embeddingFailed,
      warnings,
      changes,
    };
  } finally {
    db.close();
  }
}

export interface NativeWatchHandle {
  watchedPaths: string[];
  close(): void;
}

/**
 * Watches native harness memory roots (read-only) and automatically re-runs
 * `syncNativeMemories` after a debounce window whenever a native memory file changes.
 */
export function watchNativeMemories(
  options: NativeSyncOptions,
  onSync?: (result: NativeSyncResult) => void,
  onError?: (error: unknown) => void,
  debounceMs = 1500,
): NativeWatchHandle {
  const homeDir = options.homeDir ?? homedir();
  const candidateDirs = [
    join(homeDir, ".claude", "projects"),
    join(homeDir, ".codex"),
    join(homeDir, ".gemini", "antigravity", "knowledge"),
    join(homeDir, ".gemini", "config", "memories"),
    ...(options.customSources ?? []).map((s) => resolve(s.path)),
  ];

  const watchedPaths: string[] = [];
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        // Watch-triggered incremental syncs skip repeated snapshot spam (initial sync already backed up).
        const result = await syncNativeMemories({ ...options, backup: false });
        onSync?.(result);
      } catch (error) {
        onError?.(error);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          trigger();
        }
      }
    }, debounceMs);
  };

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const name = String(filename).toLowerCase();
        // Only react to memory markdown files or Codex's memories SQLite store.
        if (name.endsWith(".md") || name.includes("memories_1.sqlite") || name.endsWith("metadata.json")) {
          trigger();
        }
      });
      watchers.push(watcher);
      watchedPaths.push(dir);
    } catch (error) {
      onError?.(error);
    }
  }

  return {
    watchedPaths,
    close: () => {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
