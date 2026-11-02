import { openFromSender } from "../crypto/hpke.ts";
import { signChallenge } from "../crypto/keys.ts";
import {
  buildSealingKeyPayload,
  type LoadedSealingKey,
  loadOrCreateSealingKey,
} from "../crypto/sealing-key.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { DaemonApiError, type DaemonSealingContext } from "./api-client.ts";
import {
  isSecretsTrustSealed,
  markSecretsTrustSealed,
} from "./trust-level-file.ts";

const textDecoder = new TextDecoder();

export interface SealingIdentity {
  stateDir: string;
  serverId: string;
  /** The Ed25519 key id; a new one regenerates the sealing key. */
  serverKeyId: string;
}

/**
 * The daemon's side of sealed secrets: the key is loaded (or created) on first
 * use, and `open` uses the server id as the HPKE aad. Nothing here logs
 * plaintext or key material.
 */
export function createSealingContext(
  identity: SealingIdentity,
): DaemonSealingContext & { key(): Promise<LoadedSealingKey> } {
  let loaded: Promise<LoadedSealingKey> | undefined;
  const key = () =>
    loaded ??= loadOrCreateSealingKey(identity.stateDir, identity.serverKeyId);
  return {
    key,
    open: async (envelope) => {
      const { privateRaw } = await key();
      return textDecoder.decode(
        await openFromSender(privateRaw, identity.serverId, envelope),
      );
    },
    isTrustSealed: () => isSecretsTrustSealed(identity.stateDir),
    markTrustSealed: () => markSecretsTrustSealed(identity.stateDir),
  };
}

/**
 * Tell the control plane which key to seal to, signed with the Ed25519 server
 * key. Best effort: an older control plane answers 404 and keeps sending
 * plaintext, which the daemon still accepts until it has seen a sealed answer.
 * Returns true once the key is registered.
 * Only the key id is ever logged.
 */
export async function registerSealingKey(params: {
  sealing: { key(): Promise<LoadedSealingKey> };
  privateJwk: JsonWebKey;
  register: (
    body: { kid: string; pub: string; sig: string },
  ) => Promise<void>;
}): Promise<boolean> {
  try {
    const { kid, pub } = await params.sealing.key();
    const sig = await signChallenge(
      params.privateJwk,
      buildSealingKeyPayload(pub),
    );
    await params.register({ kid, pub, sig });
    logInfo("instance", "registered sealing key", sanitizeForLog(kid));
    return true;
  } catch (err) {
    if (err instanceof DaemonApiError && err.status === 404) {
      logInfo(
        "instance",
        "control plane does not take sealing keys yet; secrets stay as they are",
      );
      return false;
    }
    logWarn(
      "instance",
      "could not register the sealing key; will retry on the next connect",
      sanitizeForLog(err instanceof DaemonApiError ? err.status : "error"),
    );
    return false;
  }
}

/** Wait at least this long between registration retries on an open socket. */
export const SEALING_RETRY_INTERVAL_MS = 10 * 60 * 1000;

/**
 * When to register the sealing key: at every connect until it is on file, and
 * again (at most every {@link SEALING_RETRY_INTERVAL_MS}) when a decrypt answer
 * arrives in plaintext while it is still not on file. The second case is a
 * control plane upgraded while this socket stayed open: the older one answered
 * the connect-time registration with 404, and without a retry this server
 * would keep getting plaintext until it reconnected. One attempt at a time.
 */
export function createSealingRegistration(params: {
  register: () => Promise<boolean>;
  now?: () => number;
  retryIntervalMs?: number;
}): {
  isRegistered(): boolean;
  atConnect(): Promise<void>;
  afterPlaintextAnswer(): Promise<void>;
} {
  const now = params.now ?? Date.now;
  const retryIntervalMs = params.retryIntervalMs ?? SEALING_RETRY_INTERVAL_MS;
  let registered = false;
  let lastAttemptAt: number | null = null;
  let running: Promise<void> | null = null;
  const attempt = (): Promise<void> => {
    if (running) return running;
    lastAttemptAt = now();
    running = params.register().then((ok) => {
      registered = ok;
    }).finally(() => {
      running = null;
    });
    return running;
  };
  return {
    isRegistered: () => registered,
    atConnect: () => registered ? Promise.resolve() : attempt(),
    afterPlaintextAnswer: () => {
      if (registered || running) return Promise.resolve();
      if (lastAttemptAt !== null && now() - lastAttemptAt < retryIntervalMs) {
        return Promise.resolve();
      }
      return attempt();
    },
  };
}
