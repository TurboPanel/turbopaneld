import { dirname, join } from "@std/path";
import { DAEMON_ROOT } from "./orchestration/paths.ts";
import { logWarn } from "./logger.ts";

/** Accumulator for an in-flight dev-sync transfer (base64 chunks by index). */
export interface DevSyncState {
  chunks: string[];
  totalChunks: number;
}

export function newDevSyncState(totalChunks: number): DevSyncState {
  return { chunks: new Array<string>(totalChunks).fill(""), totalChunks };
}

/**
 * Host-local artifacts preserved across a source replacement.
 *
 * Everything else under {@link DAEMON_ROOT} is part of the source tree and is
 * replaced wholesale, so files removed upstream do not survive a sync. This list
 * MUST stay in sync with the preserve list in `scripts/run.sh` so the dev-sync
 * and `run.sh` reconcile paths cannot diverge.
 */
export const HOST_LOCAL_ARTIFACTS = [
  ".env",
  ".git",
  ".github",
  "state",
  "logs",
  "cloudflared",
  "server.id",
  "server-key.json",
  "server-key-id",
] as const;

export const COLOCATED_DEV_SYNC_REFUSED_REASON =
  "dev-sync refused on co-located development daemon — edit the local checkout directly";

function isColocatedDevDaemonHost(): boolean {
  const flag = Deno.env.get("TURBOPANEL_DEV_INSTANCE")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Atomically replace the daemon source tree at {@link DAEMON_ROOT} with the
 * contents of `staging`, carrying over the explicitly allowed host-local
 * artifacts so daemon identity (`state/`), config (`.env`), and tunnel state
 * survive. The whole directory is swapped via rename so removed source files do
 * not linger.
 */
async function replaceDaemonSourceTree(staging: string): Promise<void> {
  // Move preserved host-local artifacts from the live tree into staging so the
  // swapped-in directory keeps them. Host-local always wins over anything that
  // happened to ship in the archive.
  for (const name of HOST_LOCAL_ARTIFACTS) {
    const current = join(DAEMON_ROOT, name);
    if (!(await pathExists(current))) continue;
    const target = join(staging, name);
    if (await pathExists(target)) {
      await Deno.remove(target, { recursive: true });
    }
    await Deno.rename(current, target);
  }

  // Best-effort: match the live tree's directory mode on the replacement.
  try {
    const mode = (await Deno.stat(DAEMON_ROOT)).mode;
    if (mode !== null) await Deno.chmod(staging, mode);
  } catch {
    // Non-fatal — daemon-install.yml / the normalizer re-apply ownership/ACLs.
  }

  const backup = `${DAEMON_ROOT}.dev-sync-old`;
  await Deno.remove(backup, { recursive: true }).catch(() => {});
  await Deno.rename(DAEMON_ROOT, backup);
  try {
    await Deno.rename(staging, DAEMON_ROOT);
  } catch (err) {
    // Restore the previous tree if the swap-in fails.
    await Deno.rename(backup, DAEMON_ROOT).catch(() => {});
    throw err;
  }
  await Deno.remove(backup, { recursive: true }).catch(() => {});
}

/**
 * Unpack a gzipped tarball of a daemon build and atomically replace the source
 * tree.
 *
 * The archive is an explicit source allowlist built by the instance (see
 * `developer/dev-sync-archive.ts`): `main.ts`, `deno.json`, `deno.lock`,
 * `embedded-orchestration.ts`, `src`, the checked-in `orchestration` tree
 * (including `orchestration/roles`), and `scripts` — it never contains `.env`,
 * `.git`, logs, caches, `node_modules`, or tunnel state. We extract into a clean
 * staging directory, carry over the host-local artifacts in
 * {@link HOST_LOCAL_ARTIFACTS}, then swap the directory into place so stale
 * source files cannot survive the update. Requires the daemon's broad
 * `--allow-run` / `--allow-write`.
 */
export async function applyDevSyncTarball(bytes: Uint8Array): Promise<void> {
  if (isColocatedDevDaemonHost()) {
    throw new Error(COLOCATED_DEV_SYNC_REFUSED_REASON);
  }
  // replaceDaemonSourceTree() swaps DAEMON_ROOT out from under the running
  // process. If this process's cwd is inside that tree (e.g. a previous sync),
  // it now points at a removed directory and every subprocess spawn fails with
  // "failed resolving cwd". Anchor to the stable parent dir first, and pass an
  // explicit cwd to spawned commands so they never depend on the process cwd.
  const stableCwd = dirname(DAEMON_ROOT);
  try {
    Deno.chdir(stableCwd);
  } catch {
    Deno.chdir("/");
  }
  const tmp = await Deno.makeTempFile({ suffix: ".tgz" });
  const staging = join(dirname(DAEMON_ROOT), ".daemon-dev-sync-staging");
  try {
    await Deno.writeFile(tmp, bytes);

    await Deno.remove(staging, { recursive: true }).catch(() => {});
    await Deno.mkdir(staging, { recursive: true });

    const command = new Deno.Command("tar", {
      args: ["-xzf", tmp, "-C", staging],
      cwd: stableCwd,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await command.output();
    if (!out.success) {
      throw new Error(
        `tar extract failed: ${new TextDecoder().decode(out.stderr).trim()}`,
      );
    }
    if (!(await pathExists(join(staging, "main.ts")))) {
      throw new Error("dev-sync archive did not contain main.ts");
    }

    await replaceDaemonSourceTree(staging);

    // Warm Deno's module cache so the restarted process starts fast. Resolve the
    // running daemon's own Deno binary via Deno.execPath() rather than the bare
    // name "deno": on managed nodes Deno lives under
    // /opt/turbopanel/runtimes/deno/current and is not on PATH, so spawning
    // "deno" fails with "entity not found". Cache warming is only an
    // optimization — the source swap above is the real work — so any failure
    // here (including a missing binary) is logged and ignored, never aborting
    // the sync.
    try {
      const cache = new Deno.Command(Deno.execPath(), {
        args: ["cache", "main.ts"],
        cwd: DAEMON_ROOT,
        stdout: "piped",
        stderr: "piped",
      });
      const cacheOut = await cache.output();
      if (!cacheOut.success) {
        logWarn(
          "dev-sync",
          "deno cache warning:",
          new TextDecoder().decode(cacheOut.stderr).trim(),
        );
      }
    } catch (err) {
      logWarn(
        "dev-sync",
        "deno cache skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } finally {
    await Deno.remove(tmp).catch(() => {});
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}
