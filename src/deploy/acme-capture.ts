/**
 * Send the certificate and key Caddy issued for one hostname to the control
 * plane, which stores them sealed. Used by the issuance observer on a first
 * sighting and on every renewal.
 *
 * Nothing here logs the pair: failures are reported as a short reason only.
 */

import {
  exportIssuedCertificate,
  type IssuedCertificate,
} from "./acme-export.ts";

/**
 * `done`: the control plane has the pair (or already had this very one).
 * `retry`: not yet — the pair is not on disk, the control plane has not
 * advertised the feature, or the call failed; the observer asks again later.
 */
/** 4xx answers that say nothing about the pair itself. */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([
  401,
  403,
  408,
  429,
]);

export type CertificateCaptureOutcome = "done" | "retry";

export type CertificateCaptureDeps = {
  /** True once the attached control plane lists `tls-capture-v1`. */
  supported: () => boolean;
  /** `POST /api/daemon/v1/tls/issued`. */
  report: (
    input: IssuedCertificate & { hostname: string },
  ) => Promise<{ stored: boolean }>;
  /** Test seam — defaults to the `tp-host cert-export` read. */
  exportPair?: (hostname: string) => Promise<IssuedCertificate | null>;
  /** Called with a short reason (never the pair) when the report fails. */
  onFailure?: (hostname: string, reason: string) => void;
};

export function createCertificateCapture(
  deps: CertificateCaptureDeps,
): (hostname: string) => Promise<CertificateCaptureOutcome> {
  const exportPair = deps.exportPair ?? exportIssuedCertificate;
  return async (hostname) => {
    if (!deps.supported()) return "retry";
    const pair = await exportPair(hostname);
    if (pair === null) return "retry";
    try {
      await deps.report({ hostname, ...pair });
      return "done";
    } catch (err) {
      // The status line only: the request body (the pair) is never part of
      // an error, and nothing from it is echoed here either.
      const status = typeof err === "object" && err !== null &&
          "status" in err && typeof err.status === "number"
        ? err.status
        : undefined;
      deps.onFailure?.(
        hostname,
        status === undefined ? "request failed" : `status ${status}`,
      );
      // A 4xx means the control plane looked at the pair and refused it
      // (not placed here, names do not match): asking again changes nothing
      // until the next renewal, so it counts as handled. The statuses that
      // describe the moment and not the pair (401 and 403 while the token or
      // the server's placement settles, 408, 429) and every 5xx retry.
      return status !== undefined && status >= 400 && status < 500 &&
          !RETRYABLE_CLIENT_STATUSES.has(status)
        ? "done"
        : "retry";
    }
  };
}
