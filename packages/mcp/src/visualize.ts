import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHarnessConfigEntries, resolveNodeCommand, resolveUserPath } from "./setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

export interface VisualizeOptions {
  dbPath: string;
  port: number;
  openBrowser: boolean;
  stop: boolean;
  statusOnly: boolean;
  foreground: boolean;
  help: boolean;
}

const VISUALIZE_USAGE =
  "Usage: brain-visualize [--db PATH] [--port 4173] [--no-open] [--status] [--stop] [--foreground]";

/** Resolves the default database path across configured harnesses, workspace checkouts, and `~/.brainded/brain.db`. */
export function resolveDefaultVisualizerDbPath(options: { homeDir?: string; cwd?: string } = {}): string {
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  if (process.env.BRAIN_DB_PATH) {
    return resolveUserPath(process.env.BRAIN_DB_PATH, homeDir);
  }

  for (const entry of discoverHarnessConfigEntries(homeDir)) {
    if (entry.entry && entry.dbPath && existsSync(entry.dbPath)) {
      return entry.dbPath;
    }
  }

  const cwdDb = join(cwd, "data", "brain.db");
  if (existsSync(cwdDb)) return cwdDb;

  const repoDb = join(repoRoot, "data", "brain.db");
  if (existsSync(repoDb)) return repoDb;

  return join(homeDir, ".brainded", "brain.db");
}

/** Parses CLI arguments for `brain-visualize` / `brain-mcp --visualize`. */
export function parseVisualizeArgs(
  argv: string[],
  options: { homeDir?: string; cwd?: string } = {},
): VisualizeOptions {
  const homeDir = options.homeDir ?? homedir();
  let dbPath: string | null = null;
  let port = Number(process.env.PORT ?? 4173);
  let openBrowser = true;
  let stop = false;
  let statusOnly = false;
  let foreground = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-open") openBrowser = false;
    else if (arg === "--open") openBrowser = true;
    else if (arg === "--stop") stop = true;
    else if (arg === "--status") statusOnly = true;
    else if (arg === "--foreground") foreground = true;
    else if (arg === "--db" && argv[i + 1]) dbPath = resolveUserPath(argv[++i]!, homeDir);
    else if (arg.startsWith("--db=")) dbPath = resolveUserPath(arg.slice(5), homeDir);
    else if (arg === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice(7));
    else if (arg === "--help" || arg === "-h") help = true;
    else if (!arg.startsWith("-")) dbPath = resolveUserPath(arg, homeDir);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!help && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new Error(`Invalid port: ${port}`);
  }

  return {
    dbPath: dbPath ?? resolveDefaultVisualizerDbPath(options),
    port,
    openBrowser,
    stop,
    statusOnly,
    foreground,
    help,
  };
}

function pidFileFor(port: number): string {
  return join(tmpdir(), `memory-atlas-visualizer-${port}.pid`);
}

async function fetchOverview(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function summarizeOverview(overview: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!overview || typeof overview !== "object") return null;
  const memories = overview.memories as { active?: number; total?: number } | undefined;
  const events = overview.events as { contextEvents?: number; feedbackEvents?: number; outcomeEvents?: number } | undefined;
  return {
    memoriesActive: memories?.active ?? null,
    memoriesTotal: memories?.total ?? null,
    contexts: events?.contextEvents ?? null,
    feedback: events?.feedbackEvents ?? null,
    outcomes: events?.outcomeEvents ?? null,
    runtimeInstances: overview.runtimeInstances ?? null,
    vectorSearchAvailable: overview.vectorSearchAvailable ?? null,
  };
}

function openUrlInBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return true;
    }
    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }
    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function resolveVisualizerArtifacts(): { serverEntry: string; uiDir: string; cwd: string } {
  const packagedServer = join(__dirname, "visualizer-server.js");
  const packagedUi = join(__dirname, "..", "ui", "index.html");
  if (existsSync(packagedServer) && existsSync(packagedUi)) {
    return { serverEntry: packagedServer, uiDir: dirname(packagedUi), cwd: dirname(packagedServer) };
  }

  const monorepoServer = resolve(__dirname, "..", "..", "visualizer", "dist", "server", "server.js");
  const monorepoUi = resolve(__dirname, "..", "..", "visualizer", "dist", "ui", "index.html");
  if (existsSync(monorepoServer) && existsSync(monorepoUi)) {
    return { serverEntry: monorepoServer, uiDir: dirname(monorepoUi), cwd: repoRoot };
  }

  if (existsSync(join(repoRoot, "packages", "visualizer", "package.json"))) {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const res = spawnSync(npmCmd, ["run", "build"], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`Failed to build visualizer:\n${res.stderr || res.stdout}`);
    }
    if (existsSync(monorepoServer) && existsSync(monorepoUi)) {
      return { serverEntry: monorepoServer, uiDir: dirname(monorepoUi), cwd: repoRoot };
    }
  }

  throw new Error(
    `Visualizer assets were not found (checked ${packagedServer} and ${monorepoServer}). Rebuild @brain/visualizer or reinstall @beanvincentcat/memory-atlas.`,
  );
}

async function stopManagedServer(port: number): Promise<void> {
  const pidFile = pidFileFor(port);
  if (!existsSync(pidFile)) {
    console.log(JSON.stringify({ stopped: false, port, reason: "No managed visualizer PID file found" }, null, 2));
    return;
  }
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  let stopped = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 25));
        } catch {
          break;
        }
      }
    } catch {
      stopped = false;
    }
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // ignore cleanup error
  }
  console.log(JSON.stringify({ stopped, pid: Number.isInteger(pid) ? pid : null, port }, null, 2));
}

/** Runs the Memory Atlas visualizer launcher (`--status`, `--stop`, `--foreground`, or detached). */
export async function runVisualizeCli(
  argv: string[],
  options: { homeDir?: string; cwd?: string } = {},
): Promise<void> {
  const opts = parseVisualizeArgs(argv, options);
  if (opts.help) {
    console.log(VISUALIZE_USAGE);
    return;
  }

  const url = `http://localhost:${opts.port}`;

  if (opts.stop) {
    await stopManagedServer(opts.port);
    return;
  }

  const existing = await fetchOverview(opts.port);
  if (opts.statusOnly) {
    console.log(
      JSON.stringify(
        {
          running: existing !== null,
          url,
          port: opts.port,
          overview: summarizeOverview(existing),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (existing) {
    const opened = opts.openBrowser ? openUrlInBrowser(url) : false;
    console.log(
      JSON.stringify(
        {
          url,
          port: opts.port,
          dbPath: opts.dbPath,
          alreadyRunning: true,
          opened,
          overview: summarizeOverview(existing),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!existsSync(opts.dbPath)) {
    throw new Error(`Brain database not found at ${opts.dbPath}`);
  }

  const { serverEntry, uiDir, cwd } = resolveVisualizerArtifacts();
  const nodeCommand = resolveNodeCommand(process.execPath);
  const childEnv = {
    ...process.env,
    PORT: String(opts.port),
    BRAIN_DB_PATH: opts.dbPath,
    BRAIN_VISUALIZER_UI_DIR: uiDir,
  };

  if (opts.foreground) {
    const child = spawn(nodeCommand, [serverEntry, opts.dbPath], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout?.resume();

    if (child.pid) {
      writeFileSync(pidFileFor(opts.port), String(child.pid), "utf8");
    }

    let exitedEarly = false;
    child.once("exit", () => {
      exitedEarly = true;
    });

    const shutdown = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      try {
        unlinkSync(pidFileFor(opts.port));
      } catch {
        // ignore
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    let overview: Record<string, unknown> | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !exitedEarly) {
      overview = await fetchOverview(opts.port);
      if (overview) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!overview) {
      shutdown();
      throw new Error(`Visualizer server (pid ${child.pid ?? "unknown"}) did not respond on ${url}/api/overview within 8s`);
    }

    const opened = opts.openBrowser ? openUrlInBrowser(url) : false;
    console.log(
      JSON.stringify(
        {
          url,
          port: opts.port,
          dbPath: opts.dbPath,
          pid: child.pid ?? null,
          alreadyRunning: false,
          opened,
          overview: summarizeOverview(overview),
        },
        null,
        2,
      ),
    );
    await new Promise<void>((resolveExit) => {
      if (exitedEarly) {
        resolveExit();
        return;
      }
      child.on("exit", (code) => {
        try {
          unlinkSync(pidFileFor(opts.port));
        } catch {
          // ignore
        }
        process.exitCode = code ?? 0;
        resolveExit();
      });
    });
    return;
  }

  const child = spawn(nodeCommand, [serverEntry, opts.dbPath], {
    cwd,
    env: childEnv,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  if (child.pid) {
    writeFileSync(pidFileFor(opts.port), String(child.pid), "utf8");
  }

  let overview: Record<string, unknown> | null = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    overview = await fetchOverview(opts.port);
    if (overview) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!overview) {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(pidFileFor(opts.port));
    } catch {
      // ignore
    }
    throw new Error(`Visualizer server (pid ${child.pid ?? "unknown"}) did not respond on ${url}/api/overview within 8s`);
  }

  const opened = opts.openBrowser ? openUrlInBrowser(url) : false;
  console.log(
    JSON.stringify(
      {
        url,
        port: opts.port,
        dbPath: opts.dbPath,
        pid: child.pid ?? null,
        alreadyRunning: false,
        opened,
        overview: summarizeOverview(overview),
      },
      null,
      2,
    ),
  );
}
