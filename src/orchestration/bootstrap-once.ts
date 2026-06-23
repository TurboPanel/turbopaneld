import { bootstrapOrchestrationRuntime } from "./ansible.ts";
import { ensureOrchestrationTree } from "./bundle-extract.ts";
import { ensurePython } from "./python.ts";
import { ensureUv } from "./uv.ts";

/** One-shot uv/Python/Ansible bootstrap used at install and from `turbopaneld bootstrap-orchestration`. */
export async function runBootstrapOrchestration(): Promise<void> {
  await ensureOrchestrationTree();
  await ensureUv();
  await ensurePython();
  await bootstrapOrchestrationRuntime();
}
