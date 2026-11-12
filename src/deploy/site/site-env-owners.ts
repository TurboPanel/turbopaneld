/**
 * Which Linux user owns each site's root-side environment file.
 *
 * The root copy lives at `<config>/site-env/<user>/<site id>.env`, in a folder
 * only root can list, so a site that has left (or an environment that is
 * stopped) cannot be traced back to its user from the payload. The daemon
 * records it when it installs the file, in its own state:
 *
 *   `<stateDir>/sites/.env-owners/<environmentId>/<service>.json`
 *
 * and the removal paths read it back to ask `tp-host site-env-remove`. A site
 * installed before this record existed has none: nothing is removed for it,
 * one line is logged, and `tp-host principal-remove` still takes the whole
 * account folder when the account is retired. Values are never recorded, only
 * the user and the site id.
 */

import { join } from "node:path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { logInfo, logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { RunFn } from "../ensure-principal.ts";

export type SiteEnvOwner = { username: string; siteId: string };

const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,27}$/;
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The daemon's own environment id rule (`site.ts` SAFE_ID_RE): no dots at all. */
const ENVIRONMENT_ID_RE = /^[A-Za-z0-9_-]+$/;
/** A compose service name as one file name: no leading dot, so never `.` or `..`. */
const FILE_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function ownersDir(
  layout: Pick<LayoutPaths, "stateDir">,
  environmentId: string,
): string {
  return join(layout.stateDir, "sites", ".env-owners", environmentId);
}

function isOwner(value: unknown): value is SiteEnvOwner {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.username === "string" &&
    USERNAME_RE.test(record.username) &&
    typeof record.siteId === "string" && SITE_ID_RE.test(record.siteId);
}

/** Record the user a site's environment file was installed for. */
export async function recordSiteEnvOwner(
  layout: Pick<LayoutPaths, "stateDir">,
  environmentId: string,
  composeServiceName: string,
  owner: SiteEnvOwner,
): Promise<void> {
  if (
    !ENVIRONMENT_ID_RE.test(environmentId) ||
    !FILE_SAFE_RE.test(composeServiceName)
  ) {
    throw new Error(
      `site ${composeServiceName}: cannot record its environment file owner`,
    );
  }
  const dir = ownersDir(layout, environmentId);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    join(dir, `${composeServiceName}.json`),
    `${JSON.stringify(owner)}\n`,
    { mode: 0o600 },
  );
}

/** The recorded owner of one site's environment file, if any. */
export function readSiteEnvOwner(
  layout: Pick<LayoutPaths, "stateDir">,
  environmentId: string,
  composeServiceName: string,
): Promise<SiteEnvOwner | undefined> {
  if (
    !ENVIRONMENT_ID_RE.test(environmentId) ||
    !FILE_SAFE_RE.test(composeServiceName)
  ) return Promise.resolve(undefined);
  return readOwner(
    join(ownersDir(layout, environmentId), `${composeServiceName}.json`),
  );
}

async function readOwner(path: string): Promise<SiteEnvOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    return isOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove the root copy of a site's variables. A refusal is an error the caller
 * turns into a warning: the next deploy or stop tries again.
 */
export async function removeSiteEnvFile(
  run: RunFn,
  username: string,
  siteId: string,
): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs(["-n", "site-env-remove", username, siteId]),
  );
  if (!result.success) {
    throw new Error(
      `site ${siteId}: removing its environment file failed: ${
        result.stderr.trim() || "tp-host refused it"
      }`,
    );
  }
}

/**
 * Remove the root copies for the named services of one environment (all of
 * them when `services` is absent), then their records. Call it once every unit
 * that loads a file is gone. Never throws: a refusal keeps the record, so the
 * next deploy or stop tries again. Returns the services whose file was removed.
 */
export async function removeRecordedSiteEnvFiles(
  run: RunFn,
  layout: Pick<LayoutPaths, "stateDir">,
  environmentId: string,
  services?: readonly string[],
): Promise<string[]> {
  if (!ENVIRONMENT_ID_RE.test(environmentId)) return [];
  const dir = ownersDir(layout, environmentId);
  let names: string[];
  if (services !== undefined) {
    names = [...services];
  } else {
    try {
      names = (await Array.fromAsync(Deno.readDir(dir)))
        .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }
  const removed: string[] = [];
  await forEachSequential(names, async (service) => {
    if (!FILE_SAFE_RE.test(service)) return;
    const path = join(dir, `${service}.json`);
    const owner = await readOwner(path);
    if (owner === undefined) {
      logInfo(
        "deploy",
        `site ${service} of ${environmentId} has no record of its environment file's owner; nothing removed`,
      );
      return;
    }
    try {
      await removeSiteEnvFile(run, owner.username, owner.siteId);
      await Deno.remove(path).catch((err) => {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      });
      removed.push(service);
    } catch (err) {
      logWarn(
        "deploy",
        `site ${service} of ${environmentId}: ${
          err instanceof Error ? err.message : String(err)
        }; the next deploy or stop tries again`,
      );
    }
  });
  // An environment with nothing left drops its folder (not recursive).
  if (services === undefined) await Deno.remove(dir).catch(() => undefined);
  return removed;
}
