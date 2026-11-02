import { decodeBase64Url } from "@std/encoding/base64url";
import { join } from "@std/path";
import {
  ensureDaemonDir,
  writeDaemonFile,
} from "../permissions/daemon-files.ts";
import { sealingKid } from "./hpke.ts";

/** The daemon's X25519 key for secrets the control plane seals to it. */
export const SEALING_KEY_FILE = "sealing-key.json";

/** What the daemon signs with its Ed25519 key when it registers the sealing key. */
export function buildSealingKeyPayload(pub: string): string {
  return `tp-sealing-key\n${pub}`;
}

export interface SealingKeyFile {
  algorithm: "X25519";
  kid: string;
  /** The Ed25519 key id this key was made under; a new identity gets a new sealing key. */
  serverKeyId: string;
  createdAt: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

export interface LoadedSealingKey {
  kid: string;
  /** base64url raw public key, as sent to the control plane. */
  pub: string;
  /** Raw 32-byte private key. Never logged. */
  privateRaw: Uint8Array;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSealingKeyFile(value: unknown): value is SealingKeyFile {
  return isObject(value) && value.algorithm === "X25519" &&
    typeof value.kid === "string" && typeof value.serverKeyId === "string" &&
    typeof value.createdAt === "string" && isObject(value.publicJwk) &&
    typeof value.publicJwk.x === "string" && isObject(value.privateJwk) &&
    typeof value.privateJwk.d === "string";
}

async function readSealingKeyFile(
  path: string,
): Promise<SealingKeyFile | null> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    return isSealingKeyFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function generateSealingKeyFile(
  serverKeyId: string,
): Promise<SealingKeyFile> {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  if (!("publicKey" in pair) || !("privateKey" in pair)) {
    throw new TypeError("Expected an X25519 CryptoKeyPair");
  }
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const kid = await sealingKid(decodeBase64Url(publicJwk.x ?? ""));
  return {
    algorithm: "X25519",
    kid,
    serverKeyId,
    createdAt: new Date().toISOString(),
    publicJwk,
    privateJwk,
  };
}

/**
 * The sealing key stored beside the server key (`sealing-key.json`, 0600),
 * created on first use and regenerated when the server key changes. Private
 * key material stays in the returned object; callers must not log it.
 */
export async function loadOrCreateSealingKey(
  stateDir: string,
  serverKeyId: string,
): Promise<LoadedSealingKey> {
  const path = join(stateDir, SEALING_KEY_FILE);
  let file = await readSealingKeyFile(path);
  if (file?.serverKeyId !== serverKeyId) {
    file = await generateSealingKeyFile(serverKeyId);
    await ensureDaemonDir(stateDir, 0o750);
    await writeDaemonFile(path, JSON.stringify(file), 0o600);
  }
  return {
    kid: file.kid,
    pub: file.publicJwk.x as string,
    privateRaw: decodeBase64Url(file.privateJwk.d as string),
  };
}
