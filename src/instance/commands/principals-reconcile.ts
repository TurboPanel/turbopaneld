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
 * It subsumes more than keys. Shell changes and runtime entitlement grants also
 * stop requiring a redeploy, which fixes a real defect: granting a principal
 * PHP 8.4 currently means deploying one of its environments.
 */

import { logInfo } from "../../logger.ts";
import { type LayoutPaths, resolveLayout } from "../../paths/layout.ts";
import {
  ensureSystemPrincipals,
  type PrincipalEnsureSpec,
} from "../../deploy/ensure-principal.ts";
import {
  applySshAccess,
  type PrincipalSshSpec,
  type SshApplyPaths,
  type SshApplyResult,
} from "../../deploy/ssh/apply.ts";
import type {
  PrincipalsReconcilePayload,
  PrincipalsReconcileResult,
} from "./contracts.ts";

export type PrincipalsReconcileDeps = {
  resolveLayout?: () => LayoutPaths;
  ensureSystemPrincipals?: (
    layout: LayoutPaths,
    principals: PrincipalEnsureSpec[],
  ) => Promise<void>;
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

  // Accounts, shells, and group membership first. `applySshAccess` writes files
  // keyed by username, so the account has to exist before its key file does —
  // and the access groups have to exist before `sshd` is asked to match on
  // them.
  await (deps.ensureSystemPrincipals ?? ensureSystemPrincipals)(
    layout,
    payload.principals.map((principal) => ({
      principalId: principal.principalId,
      username: principal.username,
      ...(principal.uid === undefined ? {} : { uid: principal.uid }),
      ...(principal.gid === undefined ? {} : { gid: principal.gid }),
      ...(principal.home === undefined ? {} : { home: principal.home }),
      ...(principal.shell === undefined ? {} : { shell: principal.shell }),
      ...(principal.runtimes === undefined
        ? {}
        : { runtimes: principal.runtimes }),
      ...(principal.accessGroups === undefined
        ? {}
        : { accessGroups: principal.accessGroups }),
      ...(principal.passwordHash === undefined
        ? {}
        : { passwordHash: principal.passwordHash }),
    })),
  );

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
    { prune: true },
  );

  logInfo(
    "command",
    `principals reconciled: ${payload.principals.length} accounts, ${ssh.changedPrincipals.length} key files updated, ${ssh.removedPrincipals.length} removed`,
  );

  return {
    principalsApplied: payload.principals.length,
    keysChanged: ssh.changedPrincipals,
    keysRemoved: ssh.removedPrincipals,
    sshdReloaded: ssh.sshdReloaded,
    warnings: ssh.warnings,
  };
}
