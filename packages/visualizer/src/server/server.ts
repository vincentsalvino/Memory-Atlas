import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createVisualizerBrain } from "./bootstrap.js";
import { createApiHandler } from "./router.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export async function main(): Promise<void> {
  const repoDefaultDbPath = resolve(__dirname, "..", "..", "..", "..", "data", "brain.db");
  const defaultDbPath = existsSync(repoDefaultDbPath) ? repoDefaultDbPath : join(homedir(), ".brainded", "brain.db");
  const dbPath = process.env.BRAIN_DB_PATH ?? process.argv[2] ?? defaultDbPath;
  const brain = createVisualizerBrain(dbPath);
  const handleApi = createApiHandler(brain.queryService);
  const uiRoot = process.env.BRAIN_VISUALIZER_UI_DIR
    ? resolve(process.env.BRAIN_VISUALIZER_UI_DIR)
    : existsSync(resolve(__dirname, "..", "ui", "index.html"))
      ? resolve(__dirname, "..", "ui")
      : resolve(__dirname, "ui");

  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      void handleApi(req, res);
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // Resolve against uiRoot and reject anything that escapes it (e.g. "/../../etc/passwd").
    const requested = resolve(uiRoot, "." + pathname);
    const safePath = requested === uiRoot || requested.startsWith(uiRoot + sep) ? requested : uiRoot;
    const filePath = safePath === uiRoot || safePath.endsWith(sep) ? join(uiRoot, "index.html") : safePath;

    readFile(filePath)
      .then((body) => {
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404);
        res.end("not found");
      });
  });

  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, () => console.log(`brain-visualizer listening on http://localhost:${port}`));
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("visualizer-server.js")) {
  main().catch((error: unknown) => {
    console.error("brain-visualizer failed to start:", error);
    process.exit(1);
  });
}
