#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env
import { runBootstrapOrchestration } from "../src/orchestration/bootstrap-once.ts";
import { sanitizeForLog } from "../src/logger.ts";

try {
  await runBootstrapOrchestration();
} catch (err) {
  console.error(`[bootstrap] ${sanitizeForLog(err)}`);
  Deno.exit(1);
}
