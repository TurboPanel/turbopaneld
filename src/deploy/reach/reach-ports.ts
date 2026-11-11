/**
 * The loopback ports a project's helper containers publish, opened to that
 * project's Hosting Account only.
 *
 * A helper container publishes one port on `127.0.0.1` from the listen band.
 * `lib/tp-php-loopback` (the account walls) refuses that port to every other
 * account, the web servers, the daemon and builds, and opens it to the
 * accounts named in the root-written list for the environment:
 *
 *   staged (daemon's, 0600)  <stateDir>/reach/.stage/<environment id>.list
 *   copy   (root's,  0600)   <configDir>/reach-ports/<environment id>.list
 *
 * Each line is `<linux user> <port>`. `tp-host reach-ports-install` checks the
 * staged file and makes the copy; `reach-ports-remove` deletes it. Both are
 * followed by `php-loopback-sync`, which must succeed: a published port that is
 * not yet guarded would be open to every account on the host.
 */

import { join } from "node:path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { writePrivateFileAtomic } from "../../permissions/host-unit-files.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn } from "../ensure-principal.ts";

/** Folder of the root-owned lists, under the config root. */
export const REACH_PORTS_DIRNAME = "reach-ports";

/** The listen band helper and cache ports come from (tp-host's TP_LISTEN_PORT_MIN/MAX). */
export const REACH_PORT_MIN = 18080;
export const REACH_PORT_MAX = 18999;

/** Most lines tp-host accepts in one list (TP_REACH_MAX_LINES). */
export const REACH_LIST_MAX_LINES = 64;

const USERNAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
/** The daemon's environment id rule, as tp-host's `tp_appenv_id_ok` takes it. */
const ENVIRONMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type ReachPort = { username: string; port: number };

/** The daemon's staging folder for the lists `reach-ports-install` copies. */
export function reachStageDir(layout: Pick<LayoutPaths, "stateDir">): string {
  return join(layout.stateDir, "reach", ".stage");
}

/** Where the root-owned list for an environment lives. */
export function reachListPath(
  layout: Pick<LayoutPaths, "configDir">,
  environmentId: string,
): string {
  return join(layout.configDir, REACH_PORTS_DIRNAME, `${environmentId}.list`);
}

function assertEnvironmentId(environmentId: string): void {
  if (!ENVIRONMENT_ID_RE.test(environmentId)) {
    throw new Error("helper ports: the environment id is not usable");
  }
}

/**
 * The list text for `entries`: sorted, one line per pair, a pair named twice
 * kept once. Throws for an entry tp-host would refuse, so a bad value fails
 * here with a sentence and not in the root check.
 */
export function renderReachList(entries: readonly ReachPort[]): string {
  const lines = new Set<string>();
  for (const { username, port } of entries) {
    if (!USERNAME_RE.test(username)) {
      throw new Error("helper ports: a Linux user name is not usable");
    }
    if (
      !Number.isInteger(port) || port < REACH_PORT_MIN || port > REACH_PORT_MAX
    ) {
      throw new Error(
        `helper ports: port ${port} is outside ${REACH_PORT_MIN}-${REACH_PORT_MAX}`,
      );
    }
    lines.add(`${username} ${port}`);
  }
  if (lines.size > REACH_LIST_MAX_LINES) {
    throw new Error(
      `helper ports: more than ${REACH_LIST_MAX_LINES} ports in one environment`,
    );
  }
  return [...lines].sort().map((line) => `${line}\n`).join("");
}

/** `tp-host php-loopback-sync`; a failure throws (the guard must be in force). */
async function syncWalls(run: RunFn): Promise<void> {
  const result = await run("sudo", hostSudoArgs(["-n", "php-loopback-sync"]));
  if (!result.success) {
    throw new Error(
      `helper ports: the account loopback rules were not reloaded: ${
        result.stderr.trim() || "tp-host refused it"
      }`,
    );
  }
}

/** Stage the list (`0600` in a `0700` folder), ask tp-host to copy it, delete it. */
async function installList(
  layout: Pick<LayoutPaths, "stateDir">,
  run: RunFn,
  environmentId: string,
  text: string,
): Promise<void> {
  const dir = reachStageDir(layout);
  const name = `${environmentId}.list`;
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.chmod(dir, 0o700);
  try {
    await writePrivateFileAtomic(dir, name, text);
    const result = await run(
      "sudo",
      hostSudoArgs(["-n", "reach-ports-install", environmentId]),
    );
    if (!result.success) {
      throw new Error(
        `helper ports: installing the list failed: ${
          result.stderr.trim() || "tp-host refused it"
        }`,
      );
    }
  } finally {
    await Deno.remove(join(dir, name)).catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
  }
}

/**
 * Open the helper ports of one environment to their accounts: write the list,
 * then rebuild the account walls. No entries removes the list instead.
 */
export async function installReachPorts(
  layout: Pick<LayoutPaths, "stateDir">,
  run: RunFn,
  environmentId: string,
  entries: readonly ReachPort[],
): Promise<void> {
  assertEnvironmentId(environmentId);
  if (entries.length === 0) {
    await removeReachPorts(run, environmentId);
    return;
  }
  await installList(layout, run, environmentId, renderReachList(entries));
  await syncWalls(run);
}

/** Close the helper ports of one environment: delete its list, rebuild the walls. */
export async function removeReachPorts(
  run: RunFn,
  environmentId: string,
): Promise<void> {
  assertEnvironmentId(environmentId);
  const result = await run(
    "sudo",
    hostSudoArgs(["-n", "reach-ports-remove", environmentId]),
  );
  if (!result.success) {
    throw new Error(
      `helper ports: removing the list failed: ${
        result.stderr.trim() || "tp-host refused it"
      }`,
    );
  }
  await syncWalls(run);
}
