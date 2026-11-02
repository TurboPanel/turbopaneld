/**
 * Reconcile every principal TurboPanel manages on this server
 * (`server.principals.reconcile`).
 *
 * **Why this is a command rather than a field on `environment.deploy`.**
 * Adding a key on deploy would be tolerable; requiring a deploy to *revoke* one
 * is not — the whole point of panel-managed keys is that revocation is
 * immediate and does not wait for something unrelated to be deployed. And a
 * deploy payload describes one environment, so it can never carry the complete
 * set that safe removal requires.
 *
 * It sits beside `server.fabric.reconcile` and `server.tls.trust.reconcile` and
 * follows their shape: server-scoped, carries the full desired state, daemon
 * reconciles to it, no reply channel needed. That is exactly what the downward
 * command rail is for — unlike a repository read, which is an operator request
 * *with* an answer and therefore rides the cell request channel instead.
 *
 * It subsumes more than keys: shell and SSH access changes also stop requiring
 * a redeploy.
 */

import { logInfo } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  ensureSystemPrincipals,
  type PrincipalEnsureSpec,
  reportPrincipalIds,
  type RunFn,
} from "../deploy/ensure-principal.ts";
import {
  applySshAccess,
  type PrincipalSshSpec,
  type SshApplyPaths,
  type SshApplyResult,
} from "../deploy/ssh/apply.ts";
import {
  retirePrincipals as retirePrincipalsOnHost,
  type RetirePrincipalsResult,
} from "../deploy/retire-principals.ts";
import { runPrivileged } from "../deploy/release/release-layout.ts";
import { listAssetFolders } from "../deploy/asset-folders.ts";
import type {
  PrincipalIdReport,
  PrincipalsReconcilePayload,
  PrincipalsReconcileResult,
  ReportedFolder,
} from "../contracts/commands-contracts.ts";

export type PrincipalsReconcileDeps = {
  resolveLayout?: () => LayoutPaths;
  /** Privileged runner for `tp-host principal-remove`; test seam. */
  runPrivileged?: RunFn;
  retirePrincipals?: (
    usernames: readonly string[],
    runFn: RunFn,
  ) => Promise<RetirePrincipalsResult>;
  reportPrincipalIds?: (
    principals: ReadonlyArray<{ principalId: string; username: string }>,
    runFn?: RunFn,
    homeRoot?: string,
  ) => Promise<PrincipalIdReport[]>;
  /** Every asset folder on the host, or `null` when it cannot be listed; test seam. */
  listAssetFolders?: (runFn: RunFn) => Promise<ReportedFolder[] | null>;
  ensureSystemPrincipals?: (
    layout: LayoutPaths,
    principals: PrincipalEnsureSpec[],
  ) => Promise<string[] | void>;
  applySshAccess?: (
    principals: readonly PrincipalSshSpec[],
    paths?: SshApplyPaths,
  ) => Promise<SshApplyResult>;
};

export async function handlePrincipalsReconcile(
  payload: PrincipalsReconcilePayload,
  _daemonReceivedAt: string,
  deps: PrincipalsReconcileDeps = {},
): Promise<PrincipalsReconcileResult> {
  const layout = (deps.resolveLayout ?? resolveLayout)();
  if (payload.principals.some((p) => p.passwordHashEnvelope !== undefined)) {
    // The control plane never seals a hash here; an entry with only an
    // envelope would read as "no password" and lock the account.
    throw new Error("principals reconcile cannot carry a sealed password hash");
  }

  // Accounts, shells, and group membership first. `applySshAccess` writes files
  // keyed by username, so the account has to exist before its key file does —
  // and the access groups have to exist before `sshd` is asked to match on
  // them.
  const groupWarnings = await (deps.ensureSystemPrincipals ??
    ensureSystemPrincipals)(
      layout,
      payload.principals.map((principal) => ({
        principalId: principal.principalId,
        username: principal.username,
        ...(principal.uid === undefined ? {} : { uid: principal.uid }),
        ...(principal.gid === undefined ? {} : { gid: principal.gid }),
        ...(principal.idSource === undefined
          ? {}
          : { idSource: principal.idSource }),
        ...(principal.home === undefined ? {} : { home: principal.home }),
        ...(principal.shell === undefined ? {} : { shell: principal.shell }),
        ...(principal.accessGroups === undefined
          ? {}
          : { accessGroups: principal.accessGroups }),
        ...(principal.passwordHash === undefined
          ? {}
          : { passwordHash: principal.passwordHash }),
      })),
    );

  const idReports = await (deps.reportPrincipalIds ?? reportPrincipalIds)(
    payload.principals,
    undefined,
    layout.principalHomeRoot,
  );

  // An empty set is almost always a control plane that lost track of this
  // server, not a host that really manages nobody. Pruning on it would delete
  // every key file at once, so that needs saying explicitly (`allowEmpty`).
  const prune = payload.principals.length > 0 || payload.allowEmpty === true;
  const ssh = await (deps.applySshAccess ?? applySshAccess)(
    payload.principals.map((principal) => ({
      username: principal.username,
      // Absent means **none** here, unlike on a deploy payload where it means
      // "says nothing". This command carries complete state, so that is what
      // absent has to mean — and of the two ways to be wrong, failing to revoke
      // is the security failure while over-revoking is a visible, fixable
      // availability one.
      keys: principal.sshKeys ?? [],
    })),
    // The one caller that holds the whole server, and therefore the only one
    // allowed to delete a key file. See `SshApplyPaths.prune`.
    { prune },
  );

  // Deleted accounts go last, once the surviving set is in place: tp-host
  // refuses an account the host still references. The parser keeps a retiree
  // out of `principals`, so a prune above already dropped its key file; the
  // retire removes it again regardless, which is why an un-pruned empty set
  // still loses exactly the retired accounts' files and nothing else.
  const retireNames = (payload.retirePrincipals ?? []).map((entry) =>
    entry.username
  );
  const retirement = retireNames.length > 0
    ? await (deps.retirePrincipals ?? defaultRetirePrincipals)(
      retireNames,
      deps.runPrivileged ?? runPrivileged,
    )
    : undefined;

  // What is on disk, so the panel can notice a folder it expects is gone or one
  // it does not know about. Never deletes anything, and a listing that could
  // not be completed is left out rather than reported short.
  const folders = await (deps.listAssetFolders ?? listAssetFolders)(
    deps.runPrivileged ?? runPrivileged,
  );

  logInfo(
    "command",
    `principals reconciled: ${payload.principals.length} accounts, ${ssh.changedPrincipals.length} key files updated, ${ssh.removedPrincipals.length} removed, ${
      retirement?.retired.length ?? 0
    } retired`,
  );

  return {
    principalsApplied: payload.principals.length,
    keysChanged: ssh.changedPrincipals,
    keysRemoved: ssh.removedPrincipals,
    sshdReloaded: ssh.sshdReloaded,
    sftpChroot: ssh.sftpChroot,
    ...(retirement === undefined
      ? {}
      : { principalsRetired: retirement.retired }),
    ...(idReports.length === 0 ? {} : { principals: idReports }),
    ...(folders === null ? {} : { folders }),
    warnings: [
      ...(groupWarnings ?? []),
      ...(folders === null ? [FOLDER_LIST_UNAVAILABLE_WARNING] : []),
      ...ssh.warnings,
      ...(prune ? [] : [EMPTY_SET_KEPT_WARNING]),
      ...(retirement?.failed ?? []).map((entry) =>
        `principal ${entry.username} kept: ${entry.error}`
      ),
    ],
  };
}

/** Surfaced when the folder listing could not be completed (the result then carries no `folders`). */
export const FOLDER_LIST_UNAVAILABLE_WARNING =
  "the folders on this server could not be listed this time; nothing was concluded about them";

/** Surfaced in the command result so the panel can see nothing was pruned. */
export const EMPTY_SET_KEPT_WARNING =
  "principals is empty without allowEmpty: no key file was pruned (only retired accounts lose theirs)";

function defaultRetirePrincipals(
  usernames: readonly string[],
  runFn: RunFn,
): Promise<RetirePrincipalsResult> {
  return retirePrincipalsOnHost(usernames, { runFn });
}
