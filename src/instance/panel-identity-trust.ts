/**
 * What a pinned server believes from the control plane. The pin file
 * (`panel-identity-pin.ts`) turns enforcement on; the unsigned feature list
 * never does. On a pinned server:
 *
 * - before the first authenticated call to a control plane, its identity
 *   document must verify against the pin (`verifyPanelIdentityDocument`);
 * - answers on `SIGNED_RESPONSE_ROUTES` must carry a valid
 *   `X-TurboPanel-Signature` (`createPanelResponseVerifier`). An unsigned
 *   error answer is treated like a network error and changes nothing (a
 *   proxy's 502 is unsigned too); a bad signature, or an unsigned success, is
 *   a `PanelIdentityError` and parks the daemon with reason `panel-identity`.
 */
import { DaemonApiError } from "./api-client.ts";
import {
  httpSignatureVerifies,
  type PanelSigningKey,
  pinAccepts,
} from "./panel-identity-frames.ts";
import {
  type PanelIdentityFetch,
  parsePanelIdentity,
} from "./panel-identity-cache.ts";
import {
  type PanelIdentityPin,
  readPanelIdentityPin,
} from "./panel-identity-pin.ts";

/** The control plane did not prove it holds the pinned key. */
export class PanelIdentityError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`panel-identity: ${reason} (${path})`);
    this.name = "PanelIdentityError";
    this.path = path;
  }
}

/** Kept equal to the control plane's `SIGNED_DAEMON_RESPONSE_PATHS`. */
export const SIGNED_RESPONSE_ROUTES: ReadonlySet<string> = new Set([
  "/api/daemon/v1/instance/ca",
  "/api/daemon/v1/instance/uploaded-trust",
  "/api/daemon/v1/jwks.json",
  "/api/daemon/v1/ping",
  "/api/daemon/v1/deployments/secrets/rehydrate",
  "/api/daemon/v1/host/docker-networking",
  "/api/daemon/v1/secrets/decrypt",
  "/api/daemon/v1/auth/challenge",
  "/api/daemon/v1/auth/session",
  "/api/daemon/v1/enroll",
]);

/** The message an unsigned error answer is reported as (classified transient). */
export const UNSIGNED_CONTROL_PLANE_ERROR = "unsigned control-plane error";

/**
 * The pin that turns enforcement on, or null. A server installed with the
 * skip flag (`pinned_by=unsafe`, empty `current`) has nothing pinned. A pin
 * file that exists but cannot be read or parsed throws `PanelIdentityError`:
 * it never falls back to the unsigned session.
 */
export async function readEnforcedPin(
  env?: Record<string, string | undefined>,
): Promise<PanelIdentityPin | null> {
  let pin: PanelIdentityPin | null;
  try {
    pin = await readPanelIdentityPin(env);
  } catch (err) {
    throw new PanelIdentityError(
      "pin file",
      `the pin file is unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return pin && pin.current !== "" ? pin : null;
}

/**
 * Check a fetched identity document against the pin: its `current` key must
 * be pinned, its header signature must verify with that key, it must not be
 * expired, and its key set must not be lower than the pinned one.
 */
export async function verifyPanelIdentityDocument(
  fetched: PanelIdentityFetch,
  pin: PanelIdentityPin,
  nowMs: number,
): Promise<PanelSigningKey> {
  const parsed = await parsePanelIdentity(
    fetched,
    nowMs,
    (kid) => pinAccepts(pin, kid),
  );
  if (!parsed) {
    throw new PanelIdentityError(
      "/api/daemon/v1/instance/identity",
      "identity document is unsigned, expired or not signed by a pinned key",
    );
  }
  if (parsed.keyset < pin.keyset) {
    throw new PanelIdentityError(
      "/api/daemon/v1/instance/identity",
      `keyset ${parsed.keyset} is lower than the pinned ${pin.keyset}`,
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    parsed.signing.pub as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return { kid: parsed.signing.kid, key, keyset: parsed.keyset };
}

/** The `verifyResponse` hook `DaemonApiClient` calls for answers it must check. */
export interface PanelResponseVerifier {
  /** True when answers on `path` must be signed right now (pinned, listed route). */
  covers(path: string): boolean;
  verify(
    path: string,
    status: number,
    header: string | null,
    body: string,
  ): Promise<void>;
}

/**
 * `signing` returns the verified key while the server is pinned and
 * undefined otherwise (nothing is checked then).
 */
export function createPanelResponseVerifier(
  signing: () => PanelSigningKey | undefined,
): PanelResponseVerifier {
  return {
    covers: (path) =>
      signing() !== undefined && SIGNED_RESPONSE_ROUTES.has(path),
    async verify(path, status, header, body) {
      const key = signing();
      if (!key) return;
      if (await httpSignatureVerifies(key, path, header, body)) return;
      if (header === null && (status < 200 || status >= 300)) {
        throw new DaemonApiError(status, UNSIGNED_CONTROL_PLANE_ERROR);
      }
      throw new PanelIdentityError(
        path,
        header === null
          ? "answer is not signed"
          : "answer signature does not verify",
      );
    },
  };
}
