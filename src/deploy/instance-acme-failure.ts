import { INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX } from "./instance-acme-http01.ts";

import { logWarn } from "../util/logger.ts";

const RATE_LIMITED =
  "Let's Encrypt is limiting requests for this name; try again later (about an hour for failed validations, a week for repeated certificates)";
const DNS_WRONG =
  "this name's DNS does not point at this server; fix the DNS record and try again";
const UNAUTHORIZED =
  "Let's Encrypt could not validate this name over port 80; check that the DNS record points here and that port 80 is open, then try again";
const GENERIC =
  "Let's Encrypt could not issue a certificate; see the control plane log for details";

/** Plain words for one raw issuer or window error. Never returns the raw text. */
export function plainInstanceAcmeFailure(raw: string): string {
  const text = raw.toLowerCase();
  const held = /port 80 is held by [^\s"]+/.exec(raw);
  if (held) return `${held[0]}; stop it or free port 80 and try again`;
  if (text.includes("ratelimited") || text.includes("rate limit")) {
    return RATE_LIMITED;
  }
  if (
    text.includes("nxdomain") || text.includes("no valid a records") ||
    text.includes("dns problem")
  ) return DNS_WRONG;
  if (
    text.includes("unauthorized") || text.includes("challenge failed") ||
    text.includes("validation failed") || text.includes("connection refused") ||
    text.includes("timeout during connect")
  ) return UNAUTHORIZED;
  if (text.includes("timed out")) {
    return "Let's Encrypt did not answer in time; try again in a few minutes";
  }
  return GENERIC;
}

/**
 * The row-stored form: it carries the prefix the panel already recognises for
 * the preflight message, so the hostname row shows it. Preflight errors are
 * already in plain words and pass through unchanged.
 */
export function instanceAcmeRowFailure(
  err: unknown,
  host: string | undefined,
): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.startsWith(INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX) || !host) {
    return err instanceof Error ? err : new Error(raw);
  }
  logWarn("deploy", "instance ACME issuance failed:", raw);
  return new Error(
    `${INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX}${host}: ${
      plainInstanceAcmeFailure(raw)
    }`,
  );
}

/** Window-open errors: only the port 80 holder is a user-fixable message. */
export function instanceAcmeWindowFailure(
  err: unknown,
  host: string | undefined,
): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw.startsWith("port 80 is held by")) {
    return err instanceof Error ? err : new Error(raw);
  }
  return instanceAcmeRowFailure(err, host);
}
