import { dirname, join } from "@std/path";
import { logInfo } from "../logger.ts";
import { DAEMON_ROOT, ORCHESTRATION_DIR } from "./paths.ts";

export const ORCHESTRATION_BUNDLE_NAME = "orchestration.tar.zst";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Bundled with release tarballs under `<daemon>/dist/`. */
export function resolveOrchestrationBundlePath(): string {
  return join(DAEMON_ROOT, "dist", ORCHESTRATION_BUNDLE_NAME);
}

async function bundleNeedsExtract(bundlePath: string): Promise<boolean> {
  const ansibleCfg = join(ORCHESTRATION_DIR, "ansible.cfg");
  if (!(await fileExists(ansibleCfg))) return true;

  try {
    const bundleStat = await Deno.stat(bundlePath);
    const cfgStat = await Deno.stat(ansibleCfg);
    if (bundleStat.mtime === null || cfgStat.mtime === null) return false;
    return bundleStat.mtime > cfgStat.mtime;
  } catch {
    return false;
  }
}

/**
 * Materialize `orchestration/` from the release bundle when missing or stale.
 * Git checkouts and co-located dev hosts skip when `ansible.cfg` is already present
 * and the bundle is absent or not newer.
 */
export async function ensureOrchestrationTree(): Promise<void> {
  const bundlePath = resolveOrchestrationBundlePath();
  if (!(await fileExists(bundlePath))) {
    if (await fileExists(join(ORCHESTRATION_DIR, "ansible.cfg"))) return;
    throw new Error(
      `orchestration tree missing and no bundle at ${bundlePath}`,
    );
  }

  if (!(await bundleNeedsExtract(bundlePath))) return;

  logInfo("orchestration", `extracting bundled tree from ${bundlePath}`);
  if (await fileExists(ORCHESTRATION_DIR)) {
    await Deno.remove(ORCHESTRATION_DIR, { recursive: true });
  }
  await Deno.mkdir(dirname(ORCHESTRATION_DIR), { recursive: true });

  const command = new Deno.Command("tar", {
    args: ["-I", "zstd", "-xf", bundlePath, "-C", DAEMON_ROOT],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await command.output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(
      stderr || `failed to extract orchestration bundle from ${bundlePath}`,
    );
  }
}
