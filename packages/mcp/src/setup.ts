import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Json;
}

/** Only edits an explicit JSON MCP config; host-specific config formats remain outside this writer. */
export function setupMcp(configPath: string, entry: Json, undo = false, replace = false): void {
  const path = resolve(configPath);
  const backup = `${path}.brain-setup.json`;
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing to replace a symlink config");
  const config = existsSync(path) ? object(JSON.parse(readFileSync(path, "utf8"))) : {};
  const servers = config.mcpServers === undefined ? {} : object(config.mcpServers);
  const previous = servers["ai-brain"];
  if (undo) {
    const saved = object(JSON.parse(readFileSync(backup, "utf8")));
    if (JSON.stringify(previous) !== JSON.stringify(saved.installed)) throw new Error("Brain entry changed since setup; refusing to overwrite it");
    if (saved.previous === undefined) delete servers["ai-brain"];
    else servers["ai-brain"] = saved.previous;
  } else {
    if (JSON.stringify(previous) === JSON.stringify(entry)) return;
    if (previous !== undefined && !replace) throw new Error("An ai-brain entry already exists; preserve it or undo its earlier setup first");
    writeFileSync(backup, JSON.stringify({ installed: entry, ...(previous === undefined ? {} : { previous }) }, null, 2), { flag: "wx" });
    servers["ai-brain"] = entry;
  }
  config.mcpServers = servers;
  // Same-directory rename keeps readers from observing partial JSON.
  const temporary = `${path}.brain-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (!undo && existsSync(backup)) unlinkSync(backup);
    throw new Error(`Could not update config in ${dirname(path)}`, { cause: error });
  }
  if (undo) unlinkSync(backup);
}
