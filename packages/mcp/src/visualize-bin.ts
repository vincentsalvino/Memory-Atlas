#!/usr/bin/env node

import { runVisualizeCli } from "./visualize.js";

runVisualizeCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
