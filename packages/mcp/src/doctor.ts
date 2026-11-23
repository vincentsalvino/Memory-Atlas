import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMemoryDatabase, type MemoryDatabaseInspection } from "./bootstrap.js";
import {
  discoverHarnessConfigEntries,
  resolveNodeCommand,
  resolveUserPath,
  type HarnessKind,
  type McpConfigFormat,
} from "./setup.js";
import { inspectGlobalSkills, type GlobalSkillStatus } from "./skills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

export type DoctorIssueSeverity = "error" | "warning";

export interface DoctorIssue {
  code: string;
  severity: DoctorIssueSeverity;
  message: string;
  harness?: HarnessKind;
}

export interface DoctorHarnessReport {
  harness: HarnessKind;
  configPath: string;
  format: McpConfigFormat;
  exists: boolean;
  configured: boolean;
  serverKey: string | null;
  command: string | null;
  resolvedCommand: string | null;
  scriptPath: string | null;
  dbPath: string | null;
  harnessId: string | null;
  modelCacheDir: string | null;
  issues: DoctorIssue[];
}

export interface DoctorOptions {
  dbPath?: string;
  homeDir?: string;
  cwd?: string;
  execPath?: string;
  cliPath?: string;
}

export interface DoctorReport {
  ok: boolean;
  targetDbPath: string;
  runtime: {
    execPath: string;
    resolvedExecPath: string;
    nodeVersion: string;
    abi: string;
    cliPath: string;
  };
  harnesses: DoctorHarnessReport[];
  databases: MemoryDatabaseInspection[];
  globalSkills: GlobalSkillStatus[];
  issues: DoctorIssue[];
  recommendations: string[];
}

function canonicalPathKey(targetPath: string): string {
  const resolved = resolve(targetPath);
  let normalized = resolved;
  try {
    if (existsSync(resolved)) {
      normalized = realpathSync(resolved);
    }
  } catch {
    normalized = resolved;
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isBareCommand(command: string): boolean {
  return !isAbsolute(command) && !command.includes("/") && !command.includes("\\");
}

function inferNodePrefixFromScript(scriptPath: string): string | null {
  const normalized = scriptPath.replace(/\\/g, "/");
  const idx = normalized.toLowerCase().lastIndexOf("/node_modules/");
  if (idx <= 0) return null;
  const parent = scriptPath.slice(0, idx);
  if (/[/\\]lib$/i.test(parent)) {
    return dirname(parent);
  }
  return parent;
}

function inferNodePrefixFromBinary(resolvedBinary: string): string {
  const dir = dirname(resolvedBinary);
  if (/[/\\]bin$/i.test(dir)) {
    return dirname(dir);
  }
  return dir;
}

function isSymlinkOrJunction(targetPath: string): boolean {
  try {
    let current = resolve(targetPath);
    if (!existsSync(current)) return false;
    while (true) {
      if (lstatSync(current).isSymbolicLink()) return true;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Audits known MCP harness configurations (Antigravity, Claude Code, Codex),
 * global skills, Node/ABI path consistency, and SQLite database convergence.
 */
export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const execPath = options.execPath ?? process.execPath;
  const resolvedExecPath = resolveNodeCommand(execPath);
  const cliPath = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  const defaultCacheDir = join(homeDir, ".brainded", "models");

  const entries = discoverHarnessConfigEntries(homeDir);
  const harnessReports: DoctorHarnessReport[] = [];
  const allIssues: DoctorIssue[] = [];

  for (const entry of entries) {
    const harnessIssues: DoctorIssue[] = [];
    const configured = Boolean(entry.entry);
    let resolvedCommand: string | null = null;

    if (entry.parseError) {
      harnessIssues.push({
        code: "config_parse_error",
        severity: "error",
        harness: entry.harness,
        message: `Failed to parse ${entry.configPath}: ${entry.parseError}`,
      });
    } else if (configured) {
      if (entry.serverKey && entry.serverKey !== "ai-brain") {
        harnessIssues.push({
          code: "non_canonical_server_key",
          severity: "error",
          harness: entry.harness,
          message: `Configured under legacy key "${entry.serverKey}" instead of "ai-brain" in ${entry.configPath}`,
        });
      }

      if (!entry.harnessId) {
        harnessIssues.push({
          code: "missing_harness_id",
          severity: "error",
          harness: entry.harness,
          message: `Missing --harness-id=${entry.harness} argument in ${entry.configPath}`,
        });
      } else if (entry.harnessId !== entry.harness) {
        harnessIssues.push({
          code: "mismatched_harness_id",
          severity: "error",
          harness: entry.harness,
          message: `Configured --harness-id=${entry.harnessId} does not match expected harness "${entry.harness}"`,
        });
      }

      if (entry.scriptPath) {
        const lowerScript = entry.scriptPath.toLowerCase();
        if (lowerScript.endsWith("server.js")) {
          harnessIssues.push({
            code: "legacy_server_entrypoint",
            severity: "error",
            harness: entry.harness,
            message: `Points to legacy entrypoint ${entry.scriptPath} instead of cli.js`,
          });
        }
        if (!existsSync(entry.scriptPath)) {
          harnessIssues.push({
            code: "missing_script_path",
            severity: "error",
            harness: entry.harness,
            message: `Configured script path does not exist: ${entry.scriptPath}`,
          });
        }
      }

      if (entry.command) {
        if (isBareCommand(entry.command)) {
          harnessIssues.push({
            code: "bare_node_command",
            severity: "error",
            harness: entry.harness,
            message: `Uses bare "${entry.command}" command instead of a version-pinned absolute Node path`,
          });
        } else {
          resolvedCommand = resolveNodeCommand(entry.command);
          if (!existsSync(entry.command)) {
            harnessIssues.push({
              code: "node_runtime_path_mismatch",
              severity: "error",
              harness: entry.harness,
              message: `Configured Node command does not exist: ${entry.command}`,
            });
          } else {
            const symlinkCommand = isSymlinkOrJunction(entry.command);
            const scriptNodePrefix = entry.scriptPath ? inferNodePrefixFromScript(entry.scriptPath) : null;
            if (symlinkCommand) {
              harnessIssues.push({
                code: "nvm_symlink_command",
                severity: "error",
                harness: entry.harness,
                message: `Node command ${entry.command} resolves through a symlink/junction to ${resolvedCommand}`,
              });
            }
            if (scriptNodePrefix) {
              const commandPrefix = inferNodePrefixFromBinary(resolvedCommand);
              if (canonicalPathKey(commandPrefix) !== canonicalPathKey(scriptNodePrefix)) {
                harnessIssues.push({
                  code: "node_runtime_path_mismatch",
                  severity: "error",
                  harness: entry.harness,
                  message: `Node runtime (${resolvedCommand}) differs from the global package installation prefix (${scriptNodePrefix})`,
                });
              }
            } else if (
              entry.scriptPath &&
              canonicalPathKey(entry.scriptPath) === canonicalPathKey(cliPath) &&
              canonicalPathKey(resolvedCommand) !== canonicalPathKey(resolvedExecPath)
            ) {
              harnessIssues.push({
                code: "node_runtime_path_mismatch",
                severity: "error",
                harness: entry.harness,
                message: `Configured Node runtime (${resolvedCommand}) differs from the active CLI Node runtime (${resolvedExecPath})`,
              });
            }
          }
        }
      }

      if (!entry.modelCacheDir) {
        harnessIssues.push({
          code: "missing_model_cache_dir",
          severity: "warning",
          harness: entry.harness,
          message: `BRAIN_MODEL_CACHE_DIR is not set in ${entry.configPath}; embedding cache will fall back to default`,
        });
      }
    }

    allIssues.push(...harnessIssues);
    harnessReports.push({
      harness: entry.harness,
      configPath: entry.configPath,
      format: entry.format,
      exists: entry.exists,
      configured,
      serverKey: entry.serverKey,
      command: entry.command,
      resolvedCommand,
      scriptPath: entry.scriptPath,
      dbPath: entry.dbPath,
      harnessId: entry.harnessId,
      modelCacheDir: entry.modelCacheDir,
      issues: harnessIssues,
    });
  }

  // Determine the target shared database path.
  const configuredDbPaths = harnessReports.filter((h) => h.configured && h.dbPath).map((h) => h.dbPath!);
  const explicitTarget = options.dbPath ? resolveUserPath(options.dbPath, homeDir) : null;
  const fallbackEnvDb = process.env.BRAIN_DB_PATH ? resolveUserPath(process.env.BRAIN_DB_PATH, homeDir) : null;
  const targetDbPath =
    explicitTarget ??
    configuredDbPaths.find((p) => existsSync(p)) ??
    configuredDbPaths[0] ??
    fallbackEnvDb ??
    join(homeDir, ".brainded", "brain.db");

  // Check whether all configured harnesses target the same canonical DB path.
  const distinctConfiguredDbKeys = new Set(configuredDbPaths.map(canonicalPathKey));
  if (
    distinctConfiguredDbKeys.size > 1 ||
    (explicitTarget &&
      configuredDbPaths.some((p) => canonicalPathKey(p) !== canonicalPathKey(explicitTarget)))
  ) {
    allIssues.push({
      code: "split_configured_databases",
      severity: "error",
      message: `Configured harnesses do not all target the same database (${[...new Set(configuredDbPaths)].join(", ")})`,
    });
  }

  // Discover candidate Brain SQLite databases on disk.
  const candidateDbPaths: string[] = [
    ...(explicitTarget ? [explicitTarget] : []),
    ...configuredDbPaths,
    ...(fallbackEnvDb ? [fallbackEnvDb] : []),
    join(homeDir, ".brainded", "brain.db"),
    join(cwd, "data", "brain.db"),
    join(homeDir, "Desktop", "Brainded", "data", "brain.db"),
    join(homeDir, "OneDrive", "Desktop", "Brainded", "data", "brain.db"),
    join(homeDir, "Desktop", "ai-brain", "data", "brain.db"),
    join(homeDir, "OneDrive", "Desktop", "ai-brain", "data", "brain.db"),
  ];
  const relRepo = relative(resolve(homeDir), resolve(repoRoot));
  const repoUnderHome = relRepo === "" || (!relRepo.startsWith("..") && !isAbsolute(relRepo));
  const includeRepoCheckoutDb =
    options.homeDir === undefined ||
    repoUnderHome ||
    canonicalPathKey(repoRoot) === canonicalPathKey(cwd);
  if (includeRepoCheckoutDb) {
    candidateDbPaths.push(join(repoRoot, "data", "brain.db"));
  }

  const seenDbKeys = new Set<string>();
  const databases: MemoryDatabaseInspection[] = [];
  for (const candidate of candidateDbPaths) {
    if (!existsSync(candidate)) continue;
    const key = canonicalPathKey(candidate);
    if (seenDbKeys.has(key)) continue;
    seenDbKeys.add(key);
    databases.push(inspectMemoryDatabase(realpathSync(candidate)));
  }

  if (databases.length > 1) {
    allIssues.push({
      code: "legacy_or_split_databases_detected",
      severity: "error",
      message: `Found ${databases.length} distinct Brain databases on disk: ${databases.map((d) => d.path).join(", ")}`,
    });
  }

  const globalSkills = inspectGlobalSkills(homeDir);
  const missingSkillHarnesses = globalSkills
    .filter((s) => !s.visualizeInstalled || !s.mergeInstalled)
    .map((s) => s.harness);
  if (missingSkillHarnesses.length > 0) {
    allIssues.push({
      code: "missing_global_skills",
      severity: "warning",
      message: `Global /brain-visualize or /brain-merge skills missing for: ${missingSkillHarnesses.join(", ")}`,
    });
  }

  const recommendations: string[] = [];
  for (const report of harnessReports) {
    if (report.issues.length === 0) continue;
    const formatFlag = report.format === "toml" ? " --format=toml" : "";
    const cachePath = report.modelCacheDir ?? defaultCacheDir;
    recommendations.push(
      `brain-mcp --setup "${report.configPath}" --harness-id=${report.harness} --database="${targetDbPath}" --model-cache="${cachePath}"${formatFlag} --replace`,
    );
    if (report.serverKey && report.serverKey !== "ai-brain") {
      recommendations.push(
        `Remove legacy "${report.serverKey}" server entry from ${report.configPath} after verifying "ai-brain" connects`,
      );
    }
  }

  if (missingSkillHarnesses.length > 0) {
    recommendations.push(
      `brain-mcp --install-skills --harness=${missingSkillHarnesses.join(",")} --database="${targetDbPath}"`,
    );
  }

  if (databases.length > 1) {
    const targetKey = canonicalPathKey(targetDbPath);
    for (const db of databases) {
      if (canonicalPathKey(db.path) === targetKey) continue;
      recommendations.push(`brain-mcp --merge-db "${db.path}" --into "${targetDbPath}"`);
    }
  }

  const ok = !allIssues.some((issue) => issue.severity === "error");

  return {
    ok,
    targetDbPath,
    runtime: {
      execPath,
      resolvedExecPath,
      nodeVersion: process.version,
      abi: process.versions.modules,
      cliPath,
    },
    harnesses: harnessReports,
    databases,
    globalSkills,
    issues: allIssues,
    recommendations,
  };
}
