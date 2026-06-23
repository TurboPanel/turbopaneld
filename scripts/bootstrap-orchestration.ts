#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env
import { runBootstrapOrchestration } from "../src/orchestration/bootstrap-once.ts";

try {
  await runBootstrapOrchestration();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[bootstrap] ${message}`);
  Deno.exit(1);
}
