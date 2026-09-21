/**
 * Live TLS-handshake probe for a `tlsMode: 'acme'` hostname.
 *
 * Caddy's admin API has no "list issuance errors" endpoint to poll — verified
 * empirically against a real `caddy:2` container (no such surface under
 * `/config/` or anywhere else). The signal this uses instead: `fetch()`
 * validates the server certificate against the system trust store by
 * default, and a hostname whose automatic-HTTPS certificate Caddy has not
 * (yet, or ever) obtained answers with either a raw TLS alert (no
 * certificate to present) or a self-signed/internal-CA certificate `fetch`
 * rejects as `UnknownIssuer` — both surface as a thrown error. A hostname
 * Caddy *has* successfully issued for answers with a real HTTP response
 * (whatever status the backend returns), because reaching the HTTP layer at
 * all means the TLS handshake against a publicly-trusted certificate already
 * succeeded.
 *
 * `Deno.connectTls` was tried first and rejected: verified empirically that
 * it does **not** validate the peer certificate by default (a hand-rolled
 * self-signed cert test connected with zero complaint) — only `fetch()`
 * does, so this module deliberately never touches the lower-level API.
 */

import { errorText } from "../util/logger.ts";

export type AcmeProbeResult =
  | { hostname: string; ok: true }
  | { hostname: string; ok: false; errorMessage: string };

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ERROR_MESSAGE_CHARS = 500;

function summarizeError(err: unknown): string {
  const top = errorText(err);
  const cause = err instanceof Error && err.cause instanceof Error
    ? err.cause.message
    : undefined;
  const combined = cause && cause !== top ? `${top}: ${cause}` : top;
  return combined.length > MAX_ERROR_MESSAGE_CHARS
    ? `${combined.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : combined;
}

/**
 * Probe one hostname. `HEAD` + `redirect: "manual"` so this never downloads
 * a body or follows a hostname off the one being checked — any HTTP
 * response at all (2xx through 5xx) is a pass, since only a validated,
 * publicly-trusted certificate would let `fetch` get that far.
 */
export async function probeAcmeHostname(
  hostname: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<AcmeProbeResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetchImpl(`https://${hostname}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return { hostname, ok: true };
  } catch (err) {
    return { hostname, ok: false, errorMessage: summarizeError(err) };
  }
}
