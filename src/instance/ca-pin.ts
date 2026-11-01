/**
 * Expected control-plane CA fingerprints (`TURBOPANEL_INSTANCE_CA_FINGERPRINT`).
 *
 * The installer writes the list into `daemon.env`: the SHA-256 of the DER of
 * every certificate in the Platform CA file and the private uploaded issuer
 * it installed (lowercase hex, comma-separated). When the install command
 * carried fingerprints, those files were checked against them first.
 *
 * At runtime a trust file holding any certificate outside the list is a hard
 * failure: the daemon refuses to connect instead of trusting it. An absent
 * list keeps the old behaviour (no check), so hosts installed without one
 * keep working.
 *
 * The one path allowed to extend the list besides the installer is
 * `server.tls.trust.reconcile`, which arrives over a session that was already
 * verified against the pinned CA and authenticated with this server's key.
 * `daemon.env` sits in the root-owned config root and is the installer's, so
 * that list lives in the daemon's own state folder
 * (`<state>/tls/instance-ca-pin`) and is accepted alongside the installer's.
 * The next installer run rewrites `daemon.env` from the files on disk.
 */

import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { writeDaemonFile } from "../permissions/daemon-files.ts";
import {
  fingerprintPemCertificate,
  normalizeCaFingerprint,
  resolveInstanceTrustPaths,
  resolveInstanceUploadedTrustPath,
  splitPemBundle,
} from "./sockets.ts";

export const CA_PIN_ENV = "TURBOPANEL_INSTANCE_CA_FINGERPRINT";

const RECONCILE_PIN_MODE = 0o640;

/** A trust file holds a certificate the pinned list does not name. */
export class CaPinMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaPinMismatchError";
  }
}

/** Parse a comma-separated list; empty entries are dropped. */
export function parseCaPin(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(normalizeCaFingerprint).filter((entry) =>
    entry.length > 0
  );
}

/** Fingerprint of every certificate in a PEM bundle, in order. */
export async function pemFingerprints(pem: string): Promise<string[]> {
  return await Promise.all(
    splitPemBundle(pem).map(async (block) =>
      normalizeCaFingerprint(await fingerprintPemCertificate(block))
    ),
  );
}

/** Where an authenticated CA reconcile records the list it moved to. */
export function reconcileCaPinPath(
  env: Record<string, string | undefined>,
): string {
  return join(resolveLayout(env).daemonStateDir, "tls", "instance-ca-pin");
}

async function readOptional(
  path: string | undefined,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | null> {
  if (!path) return null;
  try {
    return await readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Why the trust files do not match the pinned list, or null when they do,
 * when no list is configured, or when a file cannot be read (the TLS
 * handshake reports unreadable trust material on its own). A file that
 * reads but holds an undecodable certificate is a mismatch.
 */
export async function caPinMismatch(
  env: Record<string, string | undefined>,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<string | null> {
  const installed = parseCaPin(env[CA_PIN_ENV]);
  if (installed.length === 0) return null;
  let reconciled: string[] = [];
  try {
    reconciled = parseCaPin(
      (await readOptional(reconcileCaPinPath(env), readTextFile))?.trim(),
    );
  } catch {
    // An unreadable reconcile record adds nothing; the installer's list holds.
  }
  const expected = new Set([...installed, ...reconciled]);
  for (const path of resolveInstanceTrustPaths(env)) {
    let pem: string;
    try {
      pem = await readTextFile(path);
    } catch {
      // The TLS handshake reports unreadable trust material on its own.
      continue;
    }
    let fingerprints: string[];
    try {
      fingerprints = await pemFingerprints(pem);
    } catch {
      // A block that cannot be decoded is not one the list names. Failing
      // closed: skipping it would let the rest of the file through unchecked.
      return `${path} holds a certificate that cannot be read, so it cannot be matched against the expected fingerprints`;
    }
    const stray = fingerprints.find((fp) => !expected.has(fp));
    if (stray) {
      return `${path} holds CA certificate ${stray}, which is not one of the expected fingerprints (${
        [...expected].join(",")
      })`;
    }
  }
  return null;
}

export type CaPinWriteDeps = {
  env?: Record<string, string | undefined>;
  readTextFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, text: string, mode: number) => Promise<void>;
};

/**
 * After an authenticated CA reconcile wrote `bundlePem`, record the new
 * bundle plus any private uploaded issuer still on disk as expected. A host
 * with no installer list keeps having no check.
 */
export async function repinAfterReconcile(
  bundlePem: string,
  deps: CaPinWriteDeps = {},
  keepPem?: string,
): Promise<string[] | null> {
  const env = deps.env ?? Deno.env.toObject();
  if (parseCaPin(env[CA_PIN_ENV]).length === 0) return null;
  const readTextFile = deps.readTextFile ?? Deno.readTextFile;
  const uploaded = await readOptional(
    resolveInstanceUploadedTrustPath(env),
    readTextFile,
  );
  const next = [
    ...new Set([
      ...await pemFingerprints(bundlePem),
      ...(keepPem ? await pemFingerprints(keepPem) : []),
      ...(uploaded ? await pemFingerprints(uploaded) : []),
    ]),
  ];
  const writeFile = deps.writeFile ??
    ((path: string, text: string, mode: number) =>
      writeDaemonFile(path, text, mode));
  await writeFile(
    reconcileCaPinPath(env),
    `${next.join(",")}\n`,
    RECONCILE_PIN_MODE,
  );
  return next;
}
