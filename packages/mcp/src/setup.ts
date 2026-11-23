import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type Json = Record<string, unknown>;
export type McpConfigFormat = "json" | "toml";
export type HarnessKind = "antigravity" | "claude-code" | "codex";

export interface DiscoveredHarnessEntry {
  harness: HarnessKind;
  configPath: string;
  format: McpConfigFormat;
  exists: boolean;
  parseError?: string;
  serverKey: string | null;
  entry: Json | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  scriptPath: string | null;
  dbPath: string | null;
  harnessId: string | null;
  modelCacheDir: string | null;
}

/** Expands a leading `~` against `homeDir` and resolves to an absolute path. */
export function resolveUserPath(inputPath: string, homeDir: string = homedir()): string {
  if (inputPath === "~") return resolve(homeDir);
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return resolve(homeDir, inputPath.slice(2));
  }
  return resolve(inputPath);
}

function isPlainObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Json {
  if (!isPlainObject(value)) throw new Error("Expected a JSON object");
  return value;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualJson(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const objA = a as Json;
    const objB = b as Json;
    const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
    const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(objB, key) && deepEqualJson(objA[key], objB[key]));
  }
  return false;
}

/**
 * Resolves the active Node executable through directory junctions or symlinks
 * (such as `nvm-windows`'s `C:\nvm4w\nodejs\node.exe`) so `command` and
 * `args[0]` stay pinned to the same Node installation and native ABI.
 */
export function resolveNodeCommand(execPath: string = process.execPath): string {
  if (!execPath) return process.execPath;
  try {
    if (existsSync(execPath)) {
      return realpathSync(execPath);
    }
  } catch {
    // Fall back to the provided path if realpath cannot inspect it.
  }
  return execPath;
}

/**
 * Merges a new `ai-brain` launcher entry into an existing entry while
 * preserving harness-specific fields (`type`, `disabled`, timeouts, etc.) and
 * merging existing `env` variables.
 */
export function mergeServerEntry(previous: unknown, incoming: Json): Json {
  if (!isPlainObject(previous)) return { ...incoming };
  const merged: Json = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "env" || value === undefined) continue;
    merged[key] = value;
  }
  const prevEnv = isPlainObject(previous.env) ? previous.env : undefined;
  const nextEnv = isPlainObject(incoming.env) ? incoming.env : undefined;
  if (prevEnv && nextEnv) {
    merged.env = { ...prevEnv, ...nextEnv };
  } else if (nextEnv) {
    merged.env = { ...nextEnv };
  } else if (prevEnv) {
    merged.env = { ...prevEnv };
  }
  return merged;
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => formatTomlValue(item)).join(", ")}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${formatTomlKey(k)} = ${formatTomlValue(v)}`);
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error(`Unsupported TOML value type: ${typeof value}`);
}

function formatTomlServerBlocks(serverKey: string, entry: Json): string {
  const headerKey = formatTomlKey(serverKey);
  const lines: string[] = [`[mcp_servers.${headerKey}]`];

  const orderedKeys = [
    ...(Object.prototype.hasOwnProperty.call(entry, "command") ? ["command"] : []),
    ...(Object.prototype.hasOwnProperty.call(entry, "args") ? ["args"] : []),
    ...Object.keys(entry).filter((key) => key !== "command" && key !== "args" && key !== "env"),
  ];

  for (const key of orderedKeys) {
    const value = entry[key];
    if (value === undefined) continue;
    lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
  }

  if (isPlainObject(entry.env)) {
    const envEntries = Object.entries(entry.env).filter(([, value]) => value !== undefined);
    if (envEntries.length > 0) {
      lines.push("", `[mcp_servers.${headerKey}.env]`);
      for (const [key, value] of envEntries) {
        lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
      }
    }
  }

  return lines.join("\n");
}

/** Formats a single `ai-brain` MCP entry as JSON (`mcpServers`) or Codex TOML (`[mcp_servers.ai-brain]`). */
export function formatMcpConfig(entry: Json, format: McpConfigFormat = "json"): string {
  if (format === "toml") {
    return formatTomlServerBlocks("ai-brain", entry);
  }
  return JSON.stringify({ mcpServers: { "ai-brain": entry } }, null, 2);
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#") return line.slice(0, i);
    }
  }
  return line;
}

function unescapeTomlBasicString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "b") out += "\b";
    else if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "f") out += "\f";
    else if (next === "r") out += "\r";
    else if (next === '"') out += '"';
    else if (next === "\\") out += "\\";
    else if (next === "u" && i + 4 < raw.length) {
      out += String.fromCodePoint(Number.parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === "U" && i + 8 < raw.length) {
      out += String.fromCodePoint(Number.parseInt(raw.slice(i + 1, i + 9), 16));
      i += 8;
    } else {
      out += next;
    }
  }
  return out;
}

function parseTomlKeyToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeTomlBasicString(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlSectionParts(headerBody: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < headerBody.length; i++) {
    const ch = headerBody[i]!;
    if (quote === '"') {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ".") {
      parts.push(parseTomlKeyToken(current));
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    parts.push(parseTomlKeyToken(current));
  }
  return parts;
}

function splitTopLevelAssignment(statement: string): { key: string; rawValue: string } | null {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]!;
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "=") {
        return {
          key: parseTomlKeyToken(statement.slice(0, i)),
          rawValue: statement.slice(i + 1).trim(),
        };
      }
    }
  }
  return null;
}

function isTomlValueComplete(raw: string): boolean {
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
  }
  return quote === null && bracketDepth === 0 && braceDepth === 0;
}

function splitTopLevelComma(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote === '"') {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === "[") {
        bracketDepth++;
        current += ch;
      } else if (ch === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
        current += ch;
      } else if (ch === "{") {
        braceDepth++;
        current += ch;
      } else if (ch === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
        current += ch;
      } else if (ch === "," && bracketDepth === 0 && braceDepth === 0) {
        if (current.trim().length > 0) items.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  if (current.trim().length > 0) items.push(current.trim());
  return items;
}

function parseTomlValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeTomlBasicString(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^[+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?$/.test(trimmed)) {
    return Number(trimmed.replace(/_/g, ""));
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    return splitTopLevelComma(inner).map((item) => parseTomlValue(item));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1);
    const result: Json = {};
    for (const part of splitTopLevelComma(inner)) {
      const assignment = splitTopLevelAssignment(part);
      if (assignment) result[assignment.key] = parseTomlValue(assignment.rawValue);
    }
    return result;
  }
  return trimmed;
}

interface TomlSectionSpan {
  parts: string[];
  startLine: number;
  endLine: number;
  rawLines: string[];
}

function scanTomlSections(content: string): { lines: string[]; newline: string; sections: TomlSectionSpan[] } {
  const cleaned = content.replace(/^\uFEFF/, "");
  const newline = cleaned.includes("\r\n") ? "\r\n" : "\n";
  const lines = cleaned.length === 0 ? [] : cleaned.split(/\r?\n/);
  const sections: TomlSectionSpan[] = [];
  let current: TomlSectionSpan | null = null;
  let pendingMultiline = false;
  let pendingRaw = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (pendingMultiline) {
      pendingRaw += "\n" + stripTomlComment(line);
      if (isTomlValueComplete(pendingRaw)) {
        pendingMultiline = false;
        pendingRaw = "";
      }
      continue;
    }

    const stripped = stripTomlComment(line).trim();
    if (!stripped) continue;

    if (stripped.startsWith("[") && !stripped.startsWith("[[") && stripped.endsWith("]")) {
      if (current) {
        current.endLine = i;
        current.rawLines = lines.slice(current.startLine, current.endLine);
      }
      current = {
        parts: parseTomlSectionParts(stripped.slice(1, -1).trim()),
        startLine: i,
        endLine: lines.length,
        rawLines: [],
      };
      sections.push(current);
      continue;
    }

    const assignment = splitTopLevelAssignment(stripped);
    if (assignment && !isTomlValueComplete(assignment.rawValue)) {
      pendingMultiline = true;
      pendingRaw = assignment.rawValue;
    }
  }

  if (current) {
    current.endLine = lines.length;
    current.rawLines = lines.slice(current.startLine, current.endLine);
  }

  return { lines, newline, sections };
}

/** Parses `[mcp_servers.<name>]` and `[mcp_servers.<name>.env]` sections from a Codex TOML file. */
export function parseTomlMcpServers(tomlContent: string): Record<string, Json> {
  const { lines, sections } = scanTomlSections(tomlContent);
  const servers: Record<string, Json> = {};

  for (const section of sections) {
    if (section.parts[0] !== "mcp_servers") continue;
    if (section.parts.length !== 2 && !(section.parts.length === 3 && section.parts[2] === "env")) continue;
    const serverName = section.parts[1];
    if (!serverName) continue;
    const target = (servers[serverName] ??= {});
    const container =
      section.parts.length === 3
        ? (isPlainObject(target.env) ? target.env : ((target.env = {}) as Json))
        : target;

    let i = section.startLine + 1;
    while (i < section.endLine) {
      const stripped = stripTomlComment(lines[i]!).trim();
      i++;
      if (!stripped) continue;
      const assignment = splitTopLevelAssignment(stripped);
      if (!assignment) continue;
      let rawValue = assignment.rawValue;
      while (!isTomlValueComplete(rawValue) && i < section.endLine) {
        rawValue += "\n" + stripTomlComment(lines[i]!).trim();
        i++;
      }
      container[assignment.key] = parseTomlValue(rawValue);
    }
  }

  return servers;
}

function replaceTomlServerSections(content: string, serverName: string, replacementBlock: string | null): string {
  const { lines, newline, sections } = scanTomlSections(content);
  const matching = sections.filter(
    (s) =>
      s.parts[0] === "mcp_servers" &&
      s.parts[1] === serverName &&
      (s.parts.length === 2 || (s.parts.length === 3 && s.parts[2] === "env")),
  );

  if (matching.length === 0) {
    if (replacementBlock === null) return content;
    const trimmed = content.replace(/^\uFEFF/, "").trimEnd();
    if (!trimmed) return replacementBlock.replace(/\r?\n/g, newline) + newline;
    return trimmed + newline + newline + replacementBlock.replace(/\r?\n/g, newline) + newline;
  }

  const removeMask = new Array<boolean>(lines.length).fill(false);
  const insertAt = matching[0]!.startLine;
  for (const span of matching) {
    for (let idx = span.startLine; idx < span.endLine; idx++) {
      removeMask[idx] = true;
    }
  }

  const before = lines.slice(0, insertAt).filter((_, idx) => !removeMask[idx]);
  const after = lines.slice(insertAt).filter((_, idx) => !removeMask[insertAt + idx]);

  while (before.length > 0 && before[before.length - 1]!.trim() === "") before.pop();
  while (after.length > 0 && after[0]!.trim() === "") after.shift();
  while (after.length > 0 && after[after.length - 1]!.trim() === "") after.pop();

  const chunks: string[] = [];
  if (before.length > 0) chunks.push(before.join(newline));
  if (replacementBlock !== null) chunks.push(replacementBlock.replace(/\r?\n/g, newline));
  if (after.length > 0) chunks.push(after.join(newline));

  if (chunks.length === 0) return "";
  return chunks.join(newline + newline) + newline;
}

function readBackupRecord(backupPath: string): Json {
  return object(JSON.parse(readFileSync(backupPath, "utf8")));
}

function writeAtomic(targetPath: string, body: string, backupPath?: string, previousBackupRaw?: string | null): void {
  const temporary = `${targetPath}.brain-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, body, { flag: "wx" });
    renameSync(temporary, targetPath);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (backupPath) {
      if (previousBackupRaw !== undefined) {
        if (previousBackupRaw === null) {
          if (existsSync(backupPath)) unlinkSync(backupPath);
        } else {
          writeFileSync(backupPath, previousBackupRaw, "utf8");
        }
      } else if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
    }
    throw new Error(`Could not update config in ${dirname(targetPath)}`, { cause: error });
  }
}

/** Updates a JSON (`mcpServers`) or Codex TOML (`[mcp_servers.ai-brain]`) MCP config safely with undo support. */
export function setupMcp(
  configPath: string,
  entry: Json,
  undo = false,
  replace = false,
  format?: McpConfigFormat,
): void {
  const path = resolve(configPath);
  const effectiveFormat: McpConfigFormat = format ?? (path.toLowerCase().endsWith(".toml") ? "toml" : "json");
  const backup = `${path}.brain-setup.json`;
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing to replace a symlink config");

  if (effectiveFormat === "toml") {
    const existingRaw = existsSync(path) ? readFileSync(path, "utf8") : "";
    const servers = parseTomlMcpServers(existingRaw);
    const previous = servers["ai-brain"];

    if (undo) {
      const saved = readBackupRecord(backup);
      if (!deepEqualJson(previous, saved.installed)) {
        throw new Error("Brain entry changed since setup; refusing to overwrite it");
      }
      const restoredBlock =
        saved.previous === undefined
          ? null
          : typeof saved.previousRaw === "string"
            ? saved.previousRaw
            : formatTomlServerBlocks("ai-brain", object(saved.previous));
      const updatedToml = replaceTomlServerSections(existingRaw, "ai-brain", restoredBlock);
      writeAtomic(path, updatedToml);
      unlinkSync(backup);
      return;
    }

    const effectiveEntry = replace && previous !== undefined ? mergeServerEntry(previous, entry) : entry;
    if (previous !== undefined && deepEqualJson(previous, effectiveEntry)) return;
    if (previous !== undefined && !replace) {
      throw new Error("An ai-brain entry already exists; preserve it or undo its earlier setup first");
    }

    const previousBackupRaw = existsSync(backup) ? readFileSync(backup, "utf8") : null;
    let preservedPrevious = previous;
    let preservedPreviousRaw: string | undefined;
    if (previous === undefined) {
      preservedPrevious = undefined;
    } else {
      const { lines, sections } = scanTomlSections(existingRaw);
      const oldBlocks = sections
        .filter(
          (s) =>
            s.parts[0] === "mcp_servers" &&
            s.parts[1] === "ai-brain" &&
            (s.parts.length === 2 || (s.parts.length === 3 && s.parts[2] === "env")),
        )
        .map((s) => lines.slice(s.startLine, s.endLine).join("\n").trimEnd());
      if (oldBlocks.length > 0) preservedPreviousRaw = oldBlocks.join("\n\n");
    }

    if (replace && previousBackupRaw !== null) {
      const priorSaved = object(JSON.parse(previousBackupRaw));
      if (deepEqualJson(previous, priorSaved.installed)) {
        preservedPrevious = priorSaved.previous as Json | undefined;
        preservedPreviousRaw = typeof priorSaved.previousRaw === "string" ? priorSaved.previousRaw : undefined;
      }
    }

    const backupPayload = JSON.stringify(
      {
        format: "toml",
        installed: effectiveEntry,
        ...(preservedPrevious === undefined ? {} : { previous: preservedPrevious }),
        ...(preservedPreviousRaw === undefined ? {} : { previousRaw: preservedPreviousRaw }),
      },
      null,
      2,
    );

    if (replace && previousBackupRaw !== null) {
      writeFileSync(backup, backupPayload, "utf8");
    } else {
      writeFileSync(backup, backupPayload, { flag: "wx" });
    }

    const nextToml = replaceTomlServerSections(existingRaw, "ai-brain", formatTomlServerBlocks("ai-brain", effectiveEntry));
    writeAtomic(path, nextToml, backup, previousBackupRaw);
    return;
  }

  const config = existsSync(path) ? object(JSON.parse(readFileSync(path, "utf8"))) : {};
  const servers = config.mcpServers === undefined ? {} : object(config.mcpServers);
  const previous = servers["ai-brain"];
  if (undo) {
    const saved = readBackupRecord(backup);
    if (!deepEqualJson(previous, saved.installed)) {
      throw new Error("Brain entry changed since setup; refusing to overwrite it");
    }
    if (saved.previous === undefined) delete servers["ai-brain"];
    else servers["ai-brain"] = saved.previous;
    config.mcpServers = servers;
    writeAtomic(path, JSON.stringify(config, null, 2) + "\n");
    unlinkSync(backup);
    return;
  }

  const effectiveEntry = replace && previous !== undefined ? mergeServerEntry(previous, entry) : entry;
  if (previous !== undefined && deepEqualJson(previous, effectiveEntry)) return;
  if (previous !== undefined && !replace) {
    throw new Error("An ai-brain entry already exists; preserve it or undo its earlier setup first");
  }

  const previousBackupRaw = existsSync(backup) ? readFileSync(backup, "utf8") : null;
  let preservedPrevious = previous;
  if (replace && previousBackupRaw !== null) {
    const priorSaved = object(JSON.parse(previousBackupRaw));
    if (deepEqualJson(previous, priorSaved.installed)) {
      preservedPrevious = priorSaved.previous;
    }
  }

  const backupPayload = JSON.stringify(
    { installed: effectiveEntry, ...(preservedPrevious === undefined ? {} : { previous: preservedPrevious }) },
    null,
    2,
  );
  if (replace && previousBackupRaw !== null) {
    writeFileSync(backup, backupPayload, "utf8");
  } else {
    writeFileSync(backup, backupPayload, { flag: "wx" });
  }

  servers["ai-brain"] = effectiveEntry;
  config.mcpServers = servers;
  writeAtomic(path, JSON.stringify(config, null, 2) + "\n", backup, previousBackupRaw);
}


function findBrainServerEntry(servers: Record<string, unknown>): { key: string; value: Json } | null {
  for (const preferred of ["ai-brain", "brain", "brainded"]) {
    const candidate = servers[preferred];
    if (isPlainObject(candidate)) return { key: preferred, value: candidate };
  }
  for (const [key, candidate] of Object.entries(servers)) {
    if (!isPlainObject(candidate)) continue;
    const cmd = typeof candidate.command === "string" ? candidate.command : "";
    const args = Array.isArray(candidate.args) ? candidate.args.filter((v): v is string => typeof v === "string") : [];
    const combined = [cmd, ...args].join(" ").toLowerCase();
    if (
      combined.includes("brain-mcp") ||
      combined.includes("memory-atlas") ||
      combined.includes("ai-brain") ||
      combined.includes("brainded")
    ) {
      return { key, value: candidate };
    }
  }
  return null;
}

function isNodeBinaryCommand(command: string | null): boolean {
  if (!command) return false;
  const base = basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  return base === "node" || base === "nodejs";
}

function parseEntryDetails(
  entry: Json,
  homeDir: string,
): Pick<DiscoveredHarnessEntry, "command" | "args" | "env" | "scriptPath" | "dbPath" | "harnessId" | "modelCacheDir"> {
  const command = typeof entry.command === "string" ? entry.command : null;
  const args = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === "string") : [];
  const env: Record<string, string> = {};
  if (isPlainObject(entry.env)) {
    for (const [key, value] of Object.entries(entry.env)) {
      if (value !== undefined && value !== null) env[key] = String(value);
    }
  }

  let harnessId: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("--harness-id=")) {
      harnessId = token.slice(13);
    } else if (token === "--harness-id" && args[i + 1]) {
      harnessId = args[++i]!;
    } else if (!token.startsWith("-")) {
      positionals.push(token);
    }
  }

  let scriptPath: string | null = null;
  let dbArg: string | null = null;
  if (isNodeBinaryCommand(command)) {
    if (positionals[0]) scriptPath = resolveUserPath(positionals[0], homeDir);
    if (positionals[1]) dbArg = positionals[1];
  } else {
    let idx = 0;
    if (command && /^npx(?:\.cmd|\.exe)?$/i.test(basename(command)) && positionals[0]?.includes("memory-atlas")) {
      idx = 1;
    }
    if (positionals[idx] && /\.(?:[cm]?js)$/i.test(positionals[idx]!)) {
      scriptPath = resolveUserPath(positionals[idx]!, homeDir);
      idx++;
    }
    if (positionals[idx]) dbArg = positionals[idx]!;
  }

  const dbPath = dbArg
    ? resolveUserPath(dbArg, homeDir)
    : env.BRAIN_DB_PATH
      ? resolveUserPath(env.BRAIN_DB_PATH, homeDir)
      : join(homeDir, ".brainded", "brain.db");

  const modelCacheDir = env.BRAIN_MODEL_CACHE_DIR ? resolveUserPath(env.BRAIN_MODEL_CACHE_DIR, homeDir) : null;

  return {
    command,
    args,
    env,
    scriptPath,
    dbPath,
    harnessId,
    modelCacheDir,
  };
}

/** Reads known Antigravity, Claude Code, and Codex MCP config files and extracts any Memory Atlas launcher entries. */
export function discoverHarnessConfigEntries(homeDir: string = homedir()): DiscoveredHarnessEntry[] {
  const candidates: Array<{ harness: HarnessKind; paths: { configPath: string; format: McpConfigFormat }[] }> = [
    {
      harness: "antigravity",
      paths: [
        { configPath: join(homeDir, ".gemini", "config", "mcp_config.json"), format: "json" },
        { configPath: join(homeDir, ".gemini", "antigravity", "mcp_config.json"), format: "json" },
      ],
    },
    {
      harness: "claude-code",
      paths: [
        { configPath: join(homeDir, ".claude.json"), format: "json" },
        { configPath: join(homeDir, ".claude", "mcp.json"), format: "json" },
      ],
    },
    {
      harness: "codex",
      paths: [{ configPath: join(homeDir, ".codex", "config.toml"), format: "toml" }],
    },
  ];

  const results: DiscoveredHarnessEntry[] = [];
  for (const group of candidates) {
    const existing = group.paths.filter((item) => existsSync(item.configPath));
    const targets = existing.length > 0 ? existing : [group.paths[0]!];

    for (const target of targets) {
      if (!existsSync(target.configPath)) {
        results.push({
          harness: group.harness,
          configPath: target.configPath,
          format: target.format,
          exists: false,
          serverKey: null,
          entry: null,
          command: null,
          args: [],
          env: {},
          scriptPath: null,
          dbPath: null,
          harnessId: null,
          modelCacheDir: null,
        });
        continue;
      }

      try {
        const raw = readFileSync(target.configPath, "utf8");
        const servers =
          target.format === "toml"
            ? parseTomlMcpServers(raw)
            : (() => {
                const parsed = object(JSON.parse(raw));
                return parsed.mcpServers === undefined ? {} : object(parsed.mcpServers);
              })();
        const found = findBrainServerEntry(servers);
        if (!found) {
          results.push({
            harness: group.harness,
            configPath: target.configPath,
            format: target.format,
            exists: true,
            serverKey: null,
            entry: null,
            command: null,
            args: [],
            env: {},
            scriptPath: null,
            dbPath: null,
            harnessId: null,
            modelCacheDir: null,
          });
          continue;
        }
        results.push({
          harness: group.harness,
          configPath: target.configPath,
          format: target.format,
          exists: true,
          serverKey: found.key,
          entry: found.value,
          ...parseEntryDetails(found.value, homeDir),
        });
      } catch (error) {
        results.push({
          harness: group.harness,
          configPath: target.configPath,
          format: target.format,
          exists: true,
          parseError: error instanceof Error ? error.message : String(error),
          serverKey: null,
          entry: null,
          command: null,
          args: [],
          env: {},
          scriptPath: null,
          dbPath: null,
          harnessId: null,
          modelCacheDir: null,
        });
      }
    }
  }

  return results;
}
