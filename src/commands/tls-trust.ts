/**
 * Apply a platform CA bundle over the already-authenticated WSS session
 * (`server.tls.trust.reconcile`).
 *
 * Writes the same path {@link resolveInstanceCaPath} uses for reconnect trust
 * (env override when that file exists, else the canonical layout path), then
 * invalidates the cached HTTP client so the next reconnect trusts the new
 * (possibly overlapping) bundle.
 *
 * When this host carries a pinned CA list (`TURBOPANEL_INSTANCE_CA_FINGERPRINT`),
 * the new bundle is recorded as expected in the same step
 * (`<state>/tls/instance-ca-pin`, see `instance/ca-pin.ts`). That is allowed here
 * because the payload arrived over a session already verified against the
 * pinned CA and authenticated with this server's key; nothing unauthenticated
 * can change the list.
 */

import { resolveLayout } from "../paths/layout.ts";
import { writeDaemonFile } from "../permissions/daemon-files.ts";
import {
  fingerprintPemCertificate,
  invalidatePlatformCaHttpClient,
  normalizeCaFingerprint,
  resolveInstanceCaPath,
  splitPemBundle,
} from "../instance/sockets.ts";
import type {
  TlsTrustReconcilePayload,
  TlsTrustReconcileResult,
} from "../contracts/commands-contracts.ts";
import { parseTlsTrustReconcilePayload } from "../contracts/commands-contracts.ts";
import { repinAfterReconcile } from "../instance/ca-pin.ts";

const CA_FILE_MODE = 0o640;

export type TlsTrustHandlerDeps = {
  caPath?: string;
  readTextFile?: (path: string) => Promise<string>;
  writeAtomic?: (path: string, contents: string) => Promise<void>;
  invalidate?: () => void;
  /** Record `bundlePem` (plus `keepPem`, when given) as expected CA certificates. */
  repin?: (bundlePem: string, keepPem?: string) => Promise<unknown>;
};

async function defaultReadTextFile(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

async function atomicWritePem(path: string, contents: string): Promise<void> {
  await writeDaemonFile(
    path,
    contents.endsWith("\n") ? contents : `${contents}\n`,
    CA_FILE_MODE,
  );
}

async function fingerprintsInPem(pem: string): Promise<string[]> {
  const blocks = splitPemBundle(pem);
  if (blocks.length === 0) {
    throw new Error("bundlePem contains no certificates");
  }
  return await Promise.all(
    blocks.map(async (block) =>
      normalizeCaFingerprint(await fingerprintPemCertificate(block))
    ),
  );
}

async function readCurrentBundle(
  caPath: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readTextFile(caPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

export async function handleTlsTrust(
  payload: TlsTrustReconcilePayload,
  _daemonReceivedAt: string,
  deps: TlsTrustHandlerDeps = {},
): Promise<TlsTrustReconcileResult> {
  parseTlsTrustReconcilePayload(payload);

  const incomingFingerprints = await fingerprintsInPem(payload.bundlePem);
  const declared = normalizeCaFingerprint(payload.fingerprint);
  const computedCurrent = incomingFingerprints[0];
  if (!computedCurrent) {
    throw new Error("bundlePem contains no certificates");
  }
  if (declared !== computedCurrent) {
    throw new Error(
      `payload fingerprint ${declared} does not match the first certificate in the bundle (${computedCurrent})`,
    );
  }

  const caPath = deps.caPath ??
    resolveInstanceCaPath(Deno.env.toObject()) ??
    resolveLayout().instanceCaPath;
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const currentPem = await readCurrentBundle(caPath, readTextFile);
  const current = currentPem === null
    ? []
    : await fingerprintsInPem(currentPem);
  const currentAnchor = current[0];
  if (
    currentAnchor &&
    !incomingFingerprints.includes(currentAnchor) &&
    payload.allowRemoval !== true
  ) {
    throw new Error(
      `incoming bundle drops the currently-trusted platform CA (${currentAnchor}); set allowRemoval to replace it`,
    );
  }

  const writeAtomic = deps.writeAtomic ?? atomicWritePem;
  const repin = deps.repin ??
    ((bundlePem: string, keepPem?: string) =>
      repinAfterReconcile(bundlePem, {}, keepPem));
  // The expected list moves first and covers both the old and the new file,
  // so a failure at any step never leaves a CA on disk that the list does
  // not name (which would park the daemon). If this throws, nothing changed.
  await repin(payload.bundlePem, currentPem ?? undefined);
  await writeAtomic(caPath, payload.bundlePem);
  // Narrow to the new bundle; if this fails the list is only wider.
  await repin(payload.bundlePem);

  const invalidate = deps.invalidate ?? invalidatePlatformCaHttpClient;
  invalidate();

  return { applied: true, fingerprint: computedCurrent };
}
