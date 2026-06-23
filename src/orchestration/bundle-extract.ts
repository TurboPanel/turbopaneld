import { join } from "@std/path";
import { EMBEDDED_ORCHESTRATION_BUNDLE } from "../../embedded-orchestration.ts";
import { logInfo } from "../logger.ts";
import { DAEMON_ROOT, ORCHESTRATION_DIR } from "./paths.ts";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function embeddedBundleReadable(): Promise<boolean> {
  try {
    const stat = await Deno.stat(EMBEDDED_ORCHESTRATION_BUNDLE);
    return stat.isFile && stat.size > 0;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Materialize `orchestration/` under the daemon root when missing.
 * Git checkouts already have the tree on disk; release installs extract the
 * bundle embedded in the compiled binary at build time.
 */
export async function ensureOrchestrationTree(): Promise<void> {
  const ansibleCfg = join(ORCHESTRATION_DIR, "ansible.cfg");
  if (await fileExists(ansibleCfg)) return;

  if (!(await embeddedBundleReadable())) {
    throw new Error(
      "orchestration tree missing and no embedded bundle in this binary (dev checkout should already have orchestration/)",
    );
  }

  logInfo(
    "orchestration",
    `extracting embedded orchestration tree to ${ORCHESTRATION_DIR}`,
  );
  await Deno.mkdir(DAEMON_ROOT, { recursive: true });
  if (await fileExists(ORCHESTRATION_DIR)) {
    await Deno.remove(ORCHESTRATION_DIR, { recursive: true });
  }

  const bundleBytes = await Deno.readFile(EMBEDDED_ORCHESTRATION_BUNDLE);
  const command = new Deno.Command("tar", {
    args: ["-I", "zstd", "-xf", "-", "-C", DAEMON_ROOT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(bundleBytes);
  await writer.close();
  const out = await child.output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(
      stderr || "failed to extract embedded orchestration bundle",
    );
  }
}
