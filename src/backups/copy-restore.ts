/**
 * `storage.restore`: replace one storage copy's contents with an archive this
 * host made (`storage.backup` or a scheduled run).
 *
 * Order, and what each step may touch:
 *
 * 1. Before anything stops: the artifact's sha256 must equal the payload's
 *    (the control plane's `archive` row), the copy must resolve inside the
 *    allowed roots exactly as a backup does, the pinned helper image must be
 *    present (pulled if missing), and the volume or directory must exist.
 *    Any failure here leaves every container running and the copy untouched.
 * 2. Under the copy's lock (shared with backups of it): find the **running**
 *    containers whose mounts are the copy — the named volume, or a bind
 *    source at or under the copy's directory — and stop them one by one. If
 *    one refuses to stop, the ones already stopped are started again and
 *    nothing is extracted.
 * 3. The helper container (no network, read-only root, no-new-privileges,
 *    `--pull never`) mounts the copy read-write at `/dst` and the artifact
 *    read-only, extracts into `/dst/.tp-restore-stage`, then swaps: the
 *    current entries move to `/dst/.tp-restore-old`, the staged ones move up,
 *    the old ones are deleted. A failed extract leaves the copy as it was; a
 *    failed swap puts the old entries back.
 * 4. Always, whatever happened in 3: every container stopped in 2 is started
 *    again. Ones that will not start are reported.
 *
 * Crash safety: before stopping anything an intent file (container ids, helper
 * name) is written under `<backupDir>/restore-intents/`, and removed once the
 * containers are running again. A daemon that starts with an intent left over
 * ({@link recoverInterruptedRestores}) starts those containers again, unless
 * the helper is still running. The swap script never deletes `.tp-restore-old`
 * from an earlier run unless that run marked itself complete
 * (`.tp-restore-done`): otherwise it stops with exit 6 and the previous
 * contents stay there for repair.
 *
 * The daemon never reads or writes the copy's files itself, and never touches
 * `/var/lib/docker/volumes`.
 */

import { helperLabelArgs } from "../deploy/labels.ts";
import type {
  StorageRestorePayload,
  StorageRestoreResult,
} from "../contracts/commands-contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
} from "../deploy/docker-cli.ts";
import { digestFileSha256 } from "../managed/backup.ts";
import { join } from "@std/path";
import { logInfo, logWarn } from "../util/logger.ts";
import { withCopyTargetLock } from "../managed/target-lock.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { directoryExists } from "../permissions/privileged-read.ts";
import {
  assertCopyMountSafe,
  type CopyGuardDeps,
} from "./copy-source-guard.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { mapSequential } from "../util/sequential.ts";
import {
  COPY_BACKUP_HELPER_IMAGE,
  copyBackupArtifactPath,
  type CopyMount,
  copyMountArg,
  ensureCopyBackupImage,
  resolveCopyMount,
} from "./copy-backup.ts";

type RunDocker = (args: string[]) => Promise<DockerCliResult>;

export type StorageRestoreHandlerDeps = {
  layout?: LayoutPaths;
  now?: () => Date;
  runDocker?: RunDocker;
  digest?: (path: string) => Promise<string>;
  /** tp-host-backed answer for a directory the daemon may not traverse. */
  directoryExists?: (path: string) => Promise<boolean>;
  /** Filesystem seams of the source check (tests). */
  guard?: Omit<CopyGuardDeps, "runDocker" | "privilegedDirectoryExists">;
  /** Where site owners' homes live; tests only. */
  principalRoot?: string;
};

/** Where the artifact appears inside the helper. */
const ARCHIVE_IN_HELPER = "/archive.tar.gz";

/**
 * Extract, then swap. Fixed text: nothing from the payload is interpolated.
 * Exit 3: the archive could not be extracted (copy unchanged). Exit 4: the
 * swap failed and the previous contents were put back. Exit 5: the swap
 * failed and putting them back failed too.
 */
export const RESTORE_SCRIPT = `set -u
stage=/dst/.tp-restore-stage
old=/dst/.tp-restore-old
done=/dst/.tp-restore-done
present() { [ -e "$1" ] || [ -L "$1" ]; }
ours() { [ "$1" = "$stage" ] || [ "$1" = "$old" ] || [ "$1" = "$done" ] || [ "$1" = "$done.tmp" ]; }
undo_aside() {
  for e in "$old"/* "$old"/.[!.]* "$old"/..?*; do
    present "$e" || continue
    mv "$e" /dst/ || return 1
  done
  rm -rf "$stage" "$old"
}
undo_swap() {
  for e in /dst/* /dst/.[!.]* /dst/..?*; do
    present "$e" || continue
    ours "$e" && continue
    rm -rf "$e" || return 1
  done
  undo_aside
}
if present "$old"; then
  if present "$done"; then rm -rf "$old" || exit 6; else exit 6; fi
fi
rm -rf "$stage" "$done" "$done.tmp"
mkdir "$stage" || exit 3
if ! tar -xzf ${ARCHIVE_IN_HELPER} -C "$stage"; then rm -rf "$stage"; exit 3; fi
mkdir "$old" || { rm -rf "$stage"; exit 3; }
for e in /dst/* /dst/.[!.]* /dst/..?*; do
  present "$e" || continue
  ours "$e" && continue
  mv "$e" "$old"/ || { undo_aside || exit 5; exit 4; }
done
for e in "$stage"/* "$stage"/.[!.]* "$stage"/..?*; do
  present "$e" || continue
  mv "$e" /dst/ || { undo_swap || exit 5; exit 4; }
done
: > "$done.tmp" && mv "$done.tmp" "$done" || { undo_swap || exit 5; exit 4; }
rm -rf "$old" "$stage"
rm -f "$done"
`;

/** The helper invocation that swaps the archive into the copy. */
export function restoreArgv(
  mount: CopyMount,
  artifactPath: string,
  helperName?: string,
): string[] {
  return [
    "run",
    "--rm",
    ...helperLabelArgs("backup-restore"),
    ...(helperName ? ["--name", helperName] : []),
    "--network",
    "none",
    "--pull",
    "never",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    copyMountArg(mount, "/dst", false),
    "--mount",
    copyMountArg(
      { type: "bind", path: artifactPath },
      ARCHIVE_IN_HELPER,
      true,
    ),
    COPY_BACKUP_HELPER_IMAGE,
    "sh",
    "-c",
    RESTORE_SCRIPT,
  ];
}

type DockerMount = { Type?: unknown; Name?: unknown; Source?: unknown };
type DockerInspect = { Id?: unknown; Mounts?: unknown };

/** Whether one container mount is the copy (or, for a directory, inside it). */
export function mountUsesCopy(mount: DockerMount, copy: CopyMount): boolean {
  if (copy.type === "volume") {
    return mount.Type === "volume" && mount.Name === copy.name;
  }
  if (mount.Type !== "bind" || typeof mount.Source !== "string") return false;
  return mount.Source === copy.path ||
    mount.Source.startsWith(`${copy.path}/`);
}

function usesCopy(container: DockerInspect, copy: CopyMount): boolean {
  if (!Array.isArray(container.Mounts)) return false;
  return container.Mounts.some((mount: DockerMount) =>
    mountUsesCopy(mount, copy)
  );
}

/** Running containers whose mounts are the copy, in `docker ps` order. */
export async function findContainersUsingCopy(
  copy: CopyMount,
  runDocker: RunDocker,
): Promise<string[]> {
  const ps = await runDocker(["ps", "-q", "--no-trunc"]);
  if (!ps.success) {
    throw new Error(
      `could not list running containers: ${sanitizeForLog(ps.stderr)}`,
    );
  }
  const ids = ps.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  const inspect = await runDocker(["inspect", ...ids]);
  if (!inspect.success) {
    throw new Error(
      `could not inspect running containers: ${sanitizeForLog(inspect.stderr)}`,
    );
  }
  const containers = JSON.parse(inspect.stdout) as DockerInspect[];
  return containers.flatMap((container) =>
    typeof container.Id === "string" && usesCopy(container, copy)
      ? [container.Id]
      : []
  );
}

/** Start each container; returns the ones that would not start. */
async function startAll(
  ids: string[],
  runDocker: RunDocker,
): Promise<string[]> {
  const outcomes = await mapSequential(ids, async (id) => ({
    id,
    started: (await runDocker(["start", id])).success,
  }));
  return outcomes.filter((outcome) => !outcome.started).map((o) => o.id);
}

/**
 * Stop each container in order. On the first refusal, start the ones already
 * stopped again and throw: nothing is extracted into a copy that is in use.
 */
async function stopAll(ids: string[], runDocker: RunDocker): Promise<void> {
  const stopped: string[] = [];
  let refused: { id: string; stderr: string } | undefined;
  await mapSequential(ids, async (id) => {
    if (refused) return;
    const stop = await runDocker(["stop", id]);
    if (stop.success) stopped.push(id);
    else refused = { id, stderr: stop.stderr };
  });
  if (!refused) return;
  const notRestarted = await startAll(stopped, runDocker);
  const tail = notRestarted.length > 0
    ? `; could not restart ${notRestarted.join(", ")}`
    : "";
  throw new Error(
    `container ${refused.id} would not stop (${
      sanitizeForLog(refused.stderr)
    }); nothing was restored${tail}`,
  );
}

const RESTORE_EXIT_MESSAGES: Record<number, string> = {
  3: "the archive could not be extracted; the copy was not changed",
  4: "the swap failed; the previous contents were put back",
  5: "the swap failed and the previous contents could not all be put back",
  6: "an earlier restore did not finish; the previous contents are kept in .tp-restore-old and nothing was changed",
};

function restoreFailure(result: DockerCliResult): string {
  const known = RESTORE_EXIT_MESSAGES[result.code];
  if (known) return known;
  return `the restore helper failed: ${
    sanitizeForLog(result.stderr || `exit ${result.code}`)
  }`;
}

/** Step 1: everything that can fail before a single container is stopped. */
async function preflight(
  layout: LayoutPaths,
  payload: StorageRestorePayload,
  deps: RestoreDeps,
): Promise<{ mount: CopyMount; artifactPath: string }> {
  const artifactPath = copyBackupArtifactPath(
    layout,
    payload.copyId,
    payload.backupId,
    payload.policyId,
  );
  const mount = resolveCopyMount(layout, payload, deps.principalRoot);
  let checksum: string;
  try {
    checksum = await deps.digest(artifactPath);
  } catch {
    throw new Error(`backup ${payload.backupId} is not on this host`);
  }
  if (checksum !== payload.checksum) {
    throw new Error(
      `backup ${payload.backupId} does not match its recorded checksum; nothing was stopped`,
    );
  }
  const imageIssue = await ensureCopyBackupImage({ runDocker: deps.runDocker });
  if (imageIssue) throw new Error(imageIssue);
  await assertCopyMountSafe(
    layout,
    payload,
    mount,
    guardDeps(deps),
    deps.principalRoot,
  );
  return { mount, artifactPath };
}

type RestoreDeps =
  & Required<
    Pick<StorageRestoreHandlerDeps, "runDocker" | "digest" | "directoryExists">
  >
  & Pick<StorageRestoreHandlerDeps, "guard" | "principalRoot">;

function guardDeps(deps: RestoreDeps): CopyGuardDeps {
  return {
    ...deps.guard,
    runDocker: deps.runDocker,
    privilegedDirectoryExists: deps.directoryExists,
  };
}

type RestoreIntent = { copyId: string; helper: string; containers: string[] };

export function restoreIntentDir(
  layout: Pick<LayoutPaths, "backupDir">,
): string {
  return join(layout.backupDir, "restore-intents");
}

function restoreHelperName(copyId: string): string {
  return `tp-restore-${copyId}`;
}

async function writeIntent(
  layout: LayoutPaths,
  intent: RestoreIntent,
): Promise<void> {
  const dir = restoreIntentDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${intent.copyId}.json`);
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(intent), { mode: 0o600 });
  await Deno.rename(tmp, path);
}

async function clearIntent(layout: LayoutPaths, copyId: string): Promise<void> {
  try {
    await Deno.remove(join(restoreIntentDir(layout), `${copyId}.json`));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function helperRunning(
  helper: string,
  runDocker: RunDocker,
): Promise<boolean> {
  const ps = await runDocker([
    "ps",
    "-q",
    "--filter",
    `name=^${helper}$`,
  ]);
  if (!ps.success) throw new Error("could not list running containers");
  return ps.stdout.trim().length > 0;
}

/**
 * Finish what a restore that died mid-way left undone for one copy: if its
 * helper is gone, start the containers it stopped and drop the intent.
 * Returns false when the helper is still running (nothing was touched).
 */
async function recoverIntent(
  layout: LayoutPaths,
  intent: RestoreIntent,
  runDocker: RunDocker,
): Promise<boolean> {
  if (await helperRunning(intent.helper, runDocker)) return false;
  const failed = await startAll(intent.containers, runDocker);
  if (failed.length > 0) {
    await writeIntent(layout, { ...intent, containers: failed });
    logWarn(
      "backup",
      `restore recovery: could not start ${
        failed.join(", ")
      } for copy ${intent.copyId}`,
    );
    return true;
  }
  await clearIntent(layout, intent.copyId);
  logInfo(
    "backup",
    `restore recovery: started ${intent.containers.length} container(s) for copy ${intent.copyId}`,
  );
  return true;
}

function parseIntent(text: string): RestoreIntent | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof raw.copyId === "string" && typeof raw.helper === "string" &&
      Array.isArray(raw.containers) &&
      raw.containers.every((id) =>
        typeof id === "string" && /^[0-9a-f]+$/.test(id)
      )
    ) {
      return {
        copyId: raw.copyId,
        helper: raw.helper,
        containers: raw.containers as string[],
      };
    }
  } catch { /* unreadable intent */ }
  return undefined;
}

async function readIntent(
  layout: LayoutPaths,
  copyId: string,
): Promise<RestoreIntent | undefined> {
  try {
    return parseIntent(
      await Deno.readTextFile(join(restoreIntentDir(layout), `${copyId}.json`)),
    );
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/**
 * At daemon start: for every restore intent left behind, start the containers
 * it stopped (unless its helper is still running).
 */
export async function recoverInterruptedRestores(
  layout: LayoutPaths = resolveLayout(Deno.env.toObject()),
  runDocker: RunDocker = defaultRunDocker,
): Promise<number> {
  let recovered = 0;
  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(restoreIntentDir(layout))) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        ids.push(entry.name.slice(0, -".json".length));
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return 0;
    throw err;
  }
  await mapSequential(ids, async (copyId) => {
    const intent = await readIntent(layout, copyId);
    if (!intent || intent.copyId !== copyId) {
      logWarn("backup", `restore recovery: unreadable intent for ${copyId}`);
      return;
    }
    if (await recoverIntent(layout, intent, runDocker)) recovered += 1;
  });
  return recovered;
}

/** Steps 2–4, under the copy's lock. */
async function swapWithServicesStopped(
  layout: LayoutPaths,
  payload: StorageRestorePayload,
  mount: CopyMount,
  artifactPath: string,
  deps: RestoreDeps,
): Promise<{ stopped: string[]; notRestarted: string[] }> {
  const { runDocker } = deps;
  // The source is looked at again now that nobody else can be restoring it.
  await assertCopyMountSafe(
    layout,
    payload,
    mount,
    guardDeps(deps),
    deps.principalRoot,
  );
  const leftover = await readIntent(layout, payload.copyId);
  if (leftover && !(await recoverIntent(layout, leftover, runDocker))) {
    throw new Error("an earlier restore of this copy is still running");
  }
  const stopped = await findContainersUsingCopy(mount, runDocker);
  const helper = restoreHelperName(payload.copyId);
  await writeIntent(layout, {
    copyId: payload.copyId,
    helper,
    containers: stopped,
  });
  try {
    await stopAll(stopped, runDocker);
  } catch (err) {
    await clearIntent(layout, payload.copyId);
    throw err;
  }
  const extracted = await runDocker(
    restoreArgv(mount, artifactPath, helper),
  ).catch(
    (err: unknown): DockerCliResult => ({
      success: false,
      code: -1,
      stdout: "",
      stderr: err instanceof Error
        ? err.message
        : "the helper could not be started",
    }),
  );
  // Whatever the helper did, every container stopped above starts again.
  const notRestarted = await startAll(stopped, runDocker);
  if (notRestarted.length === 0) await clearIntent(layout, payload.copyId);
  else {
    await writeIntent(layout, {
      copyId: payload.copyId,
      helper,
      containers: notRestarted,
    });
  }
  if (!extracted.success) {
    const tail = notRestarted.length > 0
      ? `; could not restart ${notRestarted.join(", ")}`
      : "";
    throw new Error(`${restoreFailure(extracted)}${tail}`);
  }
  return { stopped, notRestarted };
}

export async function handleStorageRestore(
  payload: StorageRestorePayload,
  daemonReceivedAt: string,
  deps: StorageRestoreHandlerDeps = {},
): Promise<StorageRestoreResult> {
  const layout = deps.layout ?? resolveLayout(Deno.env.toObject());
  const now = deps.now ?? (() => new Date());
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const restoreDeps: RestoreDeps = {
    runDocker,
    digest: deps.digest ?? digestFileSha256,
    // A copy under a principal home the daemon cannot enter is checked
    // through tp-host instead of reading as "not on this host".
    directoryExists: deps.directoryExists ?? ((path) => directoryExists(path)),
    guard: deps.guard,
    principalRoot: deps.principalRoot,
  };
  const { mount, artifactPath } = await preflight(layout, payload, restoreDeps);

  const { stopped, notRestarted } = await withCopyTargetLock(
    layout,
    payload.copyId,
    () =>
      swapWithServicesStopped(
        layout,
        payload,
        mount,
        artifactPath,
        restoreDeps,
      ),
  );
  if (notRestarted.length > 0) {
    throw new Error(
      `restored backup ${payload.backupId}, but could not restart ${
        notRestarted.join(", ")
      }`,
    );
  }
  return {
    backupId: payload.backupId,
    restoredAt: now().toISOString(),
    stopped,
    restarted: stopped,
    notRestarted: [],
    summary:
      `storage.restore completed for ${payload.copyId}: ${stopped.length} container(s) stopped and restarted (received ${daemonReceivedAt})`,
  };
}
