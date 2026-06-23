import "./embedded-orchestration.ts";
import { runBootstrapOrchestration } from "./src/orchestration/bootstrap-once.ts";

if (Deno.args[0] === "bootstrap-orchestration") {
  try {
    await runBootstrapOrchestration();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] ${message}`);
    Deno.exit(1);
  }
  Deno.exit(0);
}

await import("./src/daemon-run.ts");
