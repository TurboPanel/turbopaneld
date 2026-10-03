/**
 * Retire principals no project, site or app on this host uses any more.
 *
 * A delete drops the panel's rows, and `environment.stop` reclaims the
 * containers, sites, units and release trees — but the account itself, its
 * group, its home (`/srv/users/<p>`) and its slice (`turbopanel-<p>.slice`)
 * outlived every delete. The panel decides *which* accounts are unreferenced
 * (it alone sees every project on the server) and names them on the delete's
 * stop; this module hands each to `tp-host principal-remove`, which owns every
 * root step and re-checks on the host that nothing still references the
 * account and that its ids sit in the principal band.
 *
 * Best effort, like the rest of a teardown stop: a refusal (the account is
 * still referenced here, or is not a TurboPanel principal) is logged and the
 * account stays; the stop itself never fails over it.
 */

import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { RunFn } from "./ensure-principal.ts";
import { applySshAccess, type SshApplyResult } from "./ssh/apply.ts";

export type RetirePrincipalsDeps = {
  /** Privileged runner (`sudo -n …`). */
  runFn: RunFn;
  /** Test seam — defaults to {@link applySshAccess}. */
  applySshAccess?: () => Promise<SshApplyResult>;
};

export type RetirePrincipalsResult = {
  retired: string[];
  failed: Array<{ username: string; error: string }>;
};

async function retireOne(runFn: RunFn, username: string): Promise<string> {
  try {
    const result = await runFn(
      "sudo",
      hostSudoArgs(["-n", "principal-remove", username]),
    );
    return result.success ? "" : result.stderr || "principal-remove failed";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Re-render the `sshd` drop-in once accounts are gone, so the SFTP chroot
 * check and `sshd -t` run against the host as it now is. No principals and no
 * prune: this caller holds no key set, it only refreshes the shared file.
 */
async function rerenderSshd(
  apply: () => Promise<SshApplyResult>,
): Promise<void> {
  try {
    await apply();
  } catch (err) {
    logWarn(
      "deploy",
      `sshd drop-in re-render after principal retirement failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function retirePrincipals(
  usernames: readonly string[],
  deps: RetirePrincipalsDeps,
): Promise<RetirePrincipalsResult> {
  const retired: string[] = [];
  const failed: RetirePrincipalsResult["failed"] = [];
  await forEachSequential([...new Set(usernames)], async (username) => {
    const error = await retireOne(deps.runFn, username);
    if (error === "") {
      retired.push(username);
      return;
    }
    failed.push({ username, error });
    logWarn("deploy", `principal ${username} kept: ${error}`);
  });
  if (retired.length > 0) {
    await rerenderSshd(deps.applySshAccess ?? (() => applySshAccess([])));
    logInfo("deploy", `principals retired: ${retired.join(", ")}`);
  }
  return { retired, failed };
}
