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
  | { hostname: string; ok: true; notAfter?: string }
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
  opts?: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** When omitted, a production probe reads the leaf with openssl. Injected fetches skip that. */
    readNotAfter?: (hostname: string) => Promise<string | null>;
  },
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
  } catch (err) {
    return { hostname, ok: false, errorMessage: summarizeError(err) };
  }
  const reader = opts?.readNotAfter ??
    (opts?.fetchImpl ? undefined : readCertificateNotAfter);
  return await withObservedExpiry(hostname, reader);
}

async function withObservedExpiry(
  hostname: string,
  reader: ((hostname: string) => Promise<string | null>) | undefined,
): Promise<AcmeProbeResult> {
  if (!reader) return { hostname, ok: true };
  try {
    const notAfter = await reader(hostname);
    if (notAfter) return { hostname, ok: true, notAfter };
  } catch {
    // The handshake already succeeded. Expiry is optional on the event.
  }
  return { hostname, ok: true };
}

const OPENSSL_ENDDATE_RE = /^notAfter=(.+)$/m;
const DNS_HOSTNAME_RE = /^[A-Za-z0-9.-]+$/;

/** `openssl x509 -noout -enddate` text → ISO-8601, or null when it does not parse. */
export function certificateNotAfterFromOpenssl(text: string): string | null {
  const match = OPENSSL_ENDDATE_RE.exec(text);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

type OpensslRun = {
  code: number;
  stdout: string;
};

async function runOpenssl(
  args: readonly string[],
  input?: Uint8Array,
): Promise<OpensslRun> {
  const cmd = new Deno.Command("openssl", {
    args: [...args],
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const child = cmd.spawn();
  if (input) {
    const stdin = child.stdin;
    if (!stdin) throw new TypeError("openssl stdin was not piped");
    const writer = stdin.getWriter();
    await writer.write(input);
    await writer.close();
  }
  const result = await child.output();
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout) };
}

/**
 * Read the presented leaf's notAfter. A missing openssl or a handshake
 * that does not yield a certificate returns null; the probe stays ok.
 */
export async function readCertificateNotAfter(
  hostname: string,
  run: (
    args: readonly string[],
    input?: Uint8Array,
  ) => Promise<OpensslRun> = runOpenssl,
): Promise<string | null> {
  if (!DNS_HOSTNAME_RE.test(hostname) || hostname.includes("..")) return null;
  const handshake = await run([
    "s_client",
    "-connect",
    `${hostname}:443`,
    "-servername",
    hostname,
    "-showcerts",
  ]);
  const pem = firstCertificatePem(handshake.stdout);
  if (!pem) return null;
  const end = await run(
    ["x509", "-noout", "-enddate"],
    new TextEncoder().encode(pem),
  );
  if (end.code !== 0) return null;
  return certificateNotAfterFromOpenssl(end.stdout);
}

function firstCertificatePem(text: string): string | null {
  const start = text.indexOf("-----BEGIN CERTIFICATE-----");
  const end = text.indexOf("-----END CERTIFICATE-----");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + "-----END CERTIFICATE-----".length);
}
