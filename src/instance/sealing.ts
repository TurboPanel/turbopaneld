import { openFromSender } from "../crypto/hpke.ts";
import { signChallenge } from "../crypto/keys.ts";
import {
  buildSealingKeyPayload,
  type LoadedSealingKey,
  loadOrCreateSealingKey,
} from "../crypto/sealing-key.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { DaemonApiError, type DaemonSealingContext } from "./api-client.ts";

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
  };
}

/**
 * Tell the control plane which key to seal to, signed with the Ed25519 server
 * key. Best effort: until the key is on file the control plane refuses to
 * answer a decrypt (`sealing_key_required`). Returns true once the key is
 * registered.
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
    logWarn(
      "instance",
      "could not register the sealing key; will retry on the next connect or refused decrypt",
      sanitizeForLog(err instanceof DaemonApiError ? err.status : "error"),
    );
    return false;
  }
}

/** Wait at least this long between registration retries on an open socket. */
export const SEALING_RETRY_INTERVAL_MS = 10 * 60 * 1000;

/**
 * After a registration that worked, wait at least this long before a refused
 * decrypt registers the key again: that bounds the posts something
 * refusing over and over can cause.
 */
export const SEALING_REREGISTER_INTERVAL_MS = 60 * 1000;

/**
 * When to register the sealing key: at every connect until it is on file, and
 * again when a decrypt is refused with `sealing_key_required`. The control
 * plane refuses only when it has no key on file for this server, so the
 * refusal means the key is not there, whatever this process registered
 * before (for instance a control plane restored from an older backup). After
 * a failed attempt the next one waits {@link SEALING_RETRY_INTERVAL_MS};
 * after one that worked, {@link SEALING_REREGISTER_INTERVAL_MS}. One attempt
 * at a time; a caller that arrives during one waits for it.
 * `afterKeyRequired` resolves true only when an attempt it started or joined
 * put the key on file.
 */
export function createSealingRegistration(params: {
  register: () => Promise<boolean>;
  now?: () => number;
  retryIntervalMs?: number;
  reregisterIntervalMs?: number;
}): {
  isRegistered(): boolean;
  atConnect(): Promise<void>;
  afterKeyRequired(): Promise<boolean>;
} {
  const now = params.now ?? Date.now;
  const retryIntervalMs = params.retryIntervalMs ?? SEALING_RETRY_INTERVAL_MS;
  const reregisterIntervalMs = params.reregisterIntervalMs ??
    SEALING_REREGISTER_INTERVAL_MS;
  let registered = false;
  let lastAttemptAt: number | null = null;
  let running: Promise<void> | null = null;
  const attempt = (): Promise<void> => {
    if (running !== null) return running;
    lastAttemptAt = now();
    running = params.register().then(
      (ok) => {
        registered = ok;
      },
      // `registerSealingKey` never rejects; this keeps a future caller that
      // does from leaving an unhandled rejection behind the `void` call site.
      () => {
        registered = false;
      },
    ).finally(() => {
      running = null;
    });
    return running;
  };
  const waitedLongEnough = (): boolean => {
    if (lastAttemptAt === null) return true;
    const interval = registered ? reregisterIntervalMs : retryIntervalMs;
    return now() - lastAttemptAt >= interval;
  };
  return {
    isRegistered: () => registered,
    atConnect: () => registered ? Promise.resolve() : attempt(),
    afterKeyRequired: async () => {
      if (running === null) {
        if (!waitedLongEnough()) return false;
        // The refusal says the key is not on file: a failed attempt now
        // leaves the next connect to try again.
        registered = false;
      }
      await attempt();
      return registered;
    },
  };
}
