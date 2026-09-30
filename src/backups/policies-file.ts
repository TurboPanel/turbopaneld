/**
 * The host's copy of its scheduled backup policies:
 * `<daemonStateDir>/backup/policies.json`, the last set applied by
 * `server.backups.reconcile`. The scheduled `backup-run` one-shot reads its
 * policy from here, so a run never asks the control plane anything.
 *
 * File format (version 1):
 *
 * ```json
 * { "version": 1, "appliedAt": "<ISO-8601>", "policies": [<BackupPolicyWireEntry>, …] }
 * ```
 *
 * `policies` is exactly the reconcile payload's list and is re-validated with
 * the same contract parser on every read, so a hand-edited or truncated file
 * is refused, never half-trusted.
 */

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import {
  type BackupPolicyWireEntry,
  type BackupsReconcilePayload,
  parseBackupsReconcilePayload,
} from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";

const POLICIES_FILE_VERSION = 1;

/** `<daemonStateDir>/backup`: the policies file and the run-result spool. */
export function backupStateDir(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(layout.daemonStateDir, "backup");
}

export function backupPoliciesPath(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(backupStateDir(layout), "policies.json");
}

/**
 * Atomically replace the policies file with `payload` (tmp file, then rename;
 * mode 0640). Validates first, so an invalid set never lands on disk.
 */
export async function writeBackupPoliciesFile(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  payload: BackupsReconcilePayload,
  now: () => Date = () => new Date(),
): Promise<void> {
  const { policies } = parseBackupsReconcilePayload(payload);
  const dir = backupStateDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const body = JSON.stringify({
    version: POLICIES_FILE_VERSION,
    appliedAt: now().toISOString(),
    policies,
  });
  const tmp = join(dir, `.policies.json.${randomHex()}.tmp`);
  try {
    await Deno.writeTextFile(tmp, `${body}\n`, {
      createNew: true,
      mode: 0o640,
    });
    await Deno.chmod(tmp, 0o640);
    await Deno.rename(tmp, backupPoliciesPath(layout));
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Read and validate the whole policies file. A missing file is an empty set;
 * anything malformed throws.
 */
export async function readBackupPoliciesFile(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): Promise<BackupPolicyWireEntry[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(backupPoliciesPath(layout));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const raw: unknown = JSON.parse(text);
  if (
    typeof raw !== "object" || raw === null ||
    (raw as { version?: unknown }).version !== POLICIES_FILE_VERSION
  ) {
    throw new Error(
      `backup policies file is not version ${POLICIES_FILE_VERSION}`,
    );
  }
  return parseBackupsReconcilePayload({
    policies: (raw as { policies?: unknown }).policies,
  }).policies;
}

function randomHex(): string {
  return encodeHex(crypto.getRandomValues(new Uint8Array(8)));
}
