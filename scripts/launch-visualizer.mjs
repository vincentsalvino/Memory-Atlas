#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(repoRoot, "packages", "visualizer", "dist", "server", "server.js");
const uiEntry = join(repoRoot, "packages", "visualizer", "dist", "ui", "index.html");
const defaultDb = join(repoRoot, "data", "brain.db");

function parseArgs(argv) {
  let dbPath = process.env.BRAIN_DB_PATH ? resolve(process.env.BRAIN_DB_PATH) : defaultDb;
  let port = Number(process.env.PORT ?? 4173);
  let openBrowser = true;
  let stop = false;
  let statusOnly = false;
  let foreground = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") openBrowser = false;
    else if (arg === "--open") openBrowser = true;
    else if (arg === "--stop") stop = true;
    else if (arg === "--status") statusOnly = true;
    else if (arg === "--foreground") foreground = true;
    else if (arg === "--db" && argv[i + 1]) dbPath = resolve(argv[++i]);
    else if (arg.startsWith("--db=")) dbPath = resolve(arg.slice(5));
    else if (arg === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice(7));
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/launch-visualizer.mjs [--db PATH] [--port 4173] [--no-open] [--status] [--stop] [--foreground]`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      dbPath = resolve(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return { dbPath, port, openBrowser, stop, statusOnly, foreground };
}

function pidFileFor(port) {
  return join(tmpdir(), `memory-atlas-visualizer-${port}.pid`);
}

async function fetchOverview(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function summarizeOverview(overview) {
  if (!overview || typeof overview !== "object") return null;
  return {
    memoriesActive: overview.memories?.active ?? null,
    memoriesTotal: overview.memories?.total ?? null,
    contexts: overview.events?.contextEvents ?? null,
    feedback: overview.events?.feedbackEvents ?? null,
    outcomes: overview.events?.outcomeEvents ?? null,
    runtimeInstances: overview.runtimeInstances ?? null,
    vectorSearchAvailable: overview.vectorSearchAvailable ?? null,
  };
}

function openUrlInBrowser(url) {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
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

function ensureBuilt() {
  if (existsSync(serverEntry) && existsSync(uiEntry)) return;
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, ["run", "build"], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`Failed to build visualizer:\n${res.stderr || res.stdout}`);
  }
}

function stopManagedServer(port) {
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = `http://localhost:${opts.port}`;

  if (opts.stop) {
    stopManagedServer(opts.port);
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

  ensureBuilt();

  if (opts.foreground) {
    const child = spawn(process.execPath, [serverEntry, opts.dbPath], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(opts.port), BRAIN_DB_PATH: opts.dbPath },
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const child = spawn(process.execPath, [serverEntry, opts.dbPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(opts.port), BRAIN_DB_PATH: opts.dbPath },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  if (child.pid) {
    writeFileSync(pidFileFor(opts.port), String(child.pid), "utf8");
  }

  let overview = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    overview = await fetchOverview(opts.port);
    if (overview) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!overview) {
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
