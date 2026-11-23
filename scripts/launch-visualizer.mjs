#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mcpLauncher = join(repoRoot, "packages", "mcp", "dist", "visualize.js");
const serverEntry = join(repoRoot, "packages", "visualizer", "dist", "server", "server.js");
const uiEntry = join(repoRoot, "packages", "visualizer", "dist", "ui", "index.html");

if (!existsSync(mcpLauncher) || !existsSync(serverEntry) || !existsSync(uiEntry)) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, ["run", "build"], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`Failed to build visualizer:\n${res.stderr || res.stdout}`);
    process.exitCode = 1;
    process.exit();
  }
}

const { runVisualizeCli } = await import(pathToFileURL(mcpLauncher).href);
runVisualizeCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
