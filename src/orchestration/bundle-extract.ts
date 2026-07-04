import { join } from "@std/path";
import { detectInstallMode, readEnv, resolveLayout } from "../paths/layout.ts";
import { ORCHESTRATION_DIR } from "./paths.ts";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Ensure the orchestration tree is available on disk.
 *
 * Development checkouts ship `orchestration/` in the git tree. Production releases
 * install Ansible assets under `share/orchestration` (see `TURBOPANEL_ORCHESTRATION_DIR`).
 */
export async function ensureOrchestrationTree(): Promise<void> {
  const ansibleCfg = join(ORCHESTRATION_DIR, "ansible.cfg");
  if (await fileExists(ansibleCfg)) return;

  const mode = detectInstallMode({
    TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
    TURBOPANEL_ORCHESTRATION_DIR: readEnv("TURBOPANEL_ORCHESTRATION_DIR"),
  });

  if (mode === "development") {
    throw new Error(
      `orchestration tree missing at ${ORCHESTRATION_DIR} (dev checkout should include orchestration/)`,
    );
  }

  const layout = resolveLayout({
    TURBOPANEL_ORCHESTRATION_DIR: readEnv("TURBOPANEL_ORCHESTRATION_DIR"),
  }, { forceMode: "production" });

  throw new Error(
    `orchestration tree missing at ${layout.orchestrationDir} (release install must ship share/orchestration)`,
  );
}
