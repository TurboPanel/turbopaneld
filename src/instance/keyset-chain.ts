/**
 * Follow the control plane's key-set chain (`panel-keyset-statements-v1`).
 *
 * After a key rotation, a revoke or a change of rotation passkeys, a pinned
 * server meets a key it does not hold (a hello, an identity document or a
 * signed answer), or a document with a higher key set. It then fetches the
 * public chain (`GET /api/daemon/v1/instance/identity/statements?after=<n>`)
 * from the address it was talking to and hands every statement that follows
 * its pin, in order, to `tp-host panel-identity-write statement`, which checks
 * the passkey approvals itself before it rewrites the pin. A server that was
 * offline for weeks catches up the same way. Nothing here is believed by root;
 * this only decides which statements are worth handing over.
 */
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import {
  type PanelIdentityPin,
  type RotationPasskey,
  rotationPasskeysLine,
} from "./panel-identity-pin.ts";

/** The chain route; deliberately not a signed-response route (see the module doc). */
export const KEYSET_STATEMENTS_PATH =
  "/api/daemon/v1/instance/identity/statements";
/** At most one chain fetch per address in this window. */
export const KEYSET_CHAIN_MIN_INTERVAL_MS = 60_000;
/** Most statements in one answer and applied in one catch-up; the next catch-up continues. */
export const MAX_STATEMENTS_PER_PASS = 100;
/** Largest envelope root accepts (`tp-host panel-identity-write statement`). */
export const KEYSET_ENVELOPE_MAX_BYTES = 16 * 1024;
/** Largest honest chain answer: a full page of full envelopes plus the JSON around them. */
export const KEYSET_CHAIN_MAX_BYTES = MAX_STATEMENTS_PER_PASS *
    KEYSET_ENVELOPE_MAX_BYTES + 1024;

export type KeysetEnvelope = {
  statement: string;
  approvals: unknown[];
};

export type KeysetChainDeps = {
  /** Fetch envelopes above `after`, ascending. */
  fetchStatements: (after: number) => Promise<KeysetEnvelope[]>;
  /** Hand one envelope to tp-host; throws with tp-host's refusal. */
  apply: (envelope: KeysetEnvelope) => Promise<void>;
  /** Re-read the pin after a write. */
  readPin: () => Promise<PanelIdentityPin | null>;
  log?: (line: string) => void;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The chain answer's envelopes; anything out of shape is dropped. */
export function parseKeysetStatements(body: string): KeysetEnvelope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = record(parsed)?.statements;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const envelope = record(entry);
    return envelope && typeof envelope.statement === "string" &&
        Array.isArray(envelope.approvals)
      ? [{ statement: envelope.statement, approvals: envelope.approvals }]
      : [];
  });
}

/** `prev` and `keyset` of a statement, unverified (tp-host verifies). */
export function statementHead(
  envelope: KeysetEnvelope,
): { prev: string; keyset: number } | null {
  try {
    const doc = record(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(envelope.statement))),
    );
    if (typeof doc?.prev !== "string" || typeof doc.keyset !== "number") {
      return null;
    }
    return { prev: doc.prev, keyset: doc.keyset };
  } catch {
    return null;
  }
}

/**
 * Apply every statement that follows the pin. Returns how many applied; a
 * refusal stops the walk (the chain from that point does not follow this pin).
 */
export async function followKeysetChain(
  pin: PanelIdentityPin,
  deps: KeysetChainDeps,
): Promise<number> {
  if (pin.passkeys.length === 0) return 0;
  let current = pin;
  let applied = 0;
  const envelopes = await deps.fetchStatements(current.keyset);
  for (const envelope of envelopes.slice(0, MAX_STATEMENTS_PER_PASS)) {
    const head = statementHead(envelope);
    if (!head || head.keyset <= current.keyset) continue;
    if (head.prev !== current.current) continue;
    try {
      await deps.apply(envelope);
    } catch (err) {
      deps.log?.(
        `panel-identity: key set ${head.keyset} refused: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      break;
    }
    applied += 1;
    const next = await deps.readPin();
    if (!next) break;
    current = next;
    deps.log?.(
      `panel-identity: followed key set ${current.keyset} (key ${current.current})`,
    );
  }
  return applied;
}

/**
 * Once-a-minute gate per address, so a control plane that keeps failing is not
 * hammered. `release` reopens it after a fetch that applied a statement: each
 * one is approved by pinned passkeys and raises the key set, so progress
 * cannot loop.
 */
export function createKeysetChainGate(now: () => number = Date.now) {
  const last = new Map<string, number>();
  return {
    release(address: string): void {
      last.delete(address);
    },
    tryEnter(address: string): boolean {
      const at = now();
      const before = last.get(address);
      if (before !== undefined && at - before < KEYSET_CHAIN_MIN_INTERVAL_MS) {
        return false;
      }
      last.set(address, at);
      return true;
    },
  };
}

/** What the pin report carries: base64url SHA-256 of the pin's `passkeys=` line, "" with none. */
export async function rotationPasskeysHash(
  passkeys: readonly RotationPasskey[],
): Promise<string> {
  if (passkeys.length === 0) return "";
  const line = new TextEncoder().encode(rotationPasskeysLine(passkeys));
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", line)),
  );
}
