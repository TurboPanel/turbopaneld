/**
 * Apply a platform CA bundle over the already-authenticated WSS session
 * (`server.tls.trust.reconcile`).
 *
 * Writes the same path {@link resolveInstanceCaPath} uses for reconnect trust
 * (env override when that file exists, else the canonical layout path), then
 * invalidates the cached HTTP client so the next reconnect trusts the new
 * (possibly overlapping) bundle.
 */

import { resolveLayout } from "../../paths/layout.ts";
import {
  fingerprintPemCertificate,
  invalidatePlatformCaHttpClient,
  normalizeCaFingerprint,
  resolveInstanceCaPath,
  splitPemBundle,
} from "../paths.ts";
import type {
  TlsTrustReconcilePayload,
  TlsTrustReconcileResult,
} from "./contracts.ts";
import { parseTlsTrustReconcilePayload } from "./contracts.ts";

const CA_FILE_MODE = 0o640;

export type TlsTrustHandlerDeps = {
  caPath?: string;
  readTextFile?: (path: string) => Promise<string>;
  writeAtomic?: (path: string, contents: string) => Promise<void>;
  invalidate?: () => void;
};

async function defaultReadTextFile(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

async function atomicWritePem(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp.${Deno.pid}`;
  await Deno.writeTextFile(
    tmp,
    contents.endsWith("\n") ? contents : `${contents}\n`,
  );
  await Deno.chmod(tmp, CA_FILE_MODE);
  await Deno.rename(tmp, path);
}

async function fingerprintsInPem(pem: string): Promise<string[]> {
  const blocks = splitPemBundle(pem);
  if (blocks.length === 0) {
    throw new Error("bundlePem contains no certificates");
  }
  const fingerprints: string[] = [];
  for (const block of blocks) {
    fingerprints.push(
      normalizeCaFingerprint(await fingerprintPemCertificate(block)),
    );
  }
  return fingerprints;
}

async function currentAnchorFingerprints(
  caPath: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string[]> {
  try {
    const pem = await readTextFile(caPath);
    return await fingerprintsInPem(pem);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
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
  const current = await currentAnchorFingerprints(caPath, readTextFile);
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
  await writeAtomic(caPath, payload.bundlePem);

  const invalidate = deps.invalidate ?? invalidatePlatformCaHttpClient;
  invalidate();

  return { applied: true, fingerprint: computedCurrent };
}
