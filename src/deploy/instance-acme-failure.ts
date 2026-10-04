import { INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX } from "./instance-acme-http01.ts";
import { instanceAcmeProblem } from "./instance-acme-issuer.ts";
import type { InstanceAcmeProblem } from "./instance-acme-issuer.ts";
import { logWarn } from "../util/logger.ts";

const PLAIN: Record<InstanceAcmeProblem, string> = {
  "rate-limited":
    "Let's Encrypt is limiting requests for this name; try again later (about an hour for failed validations, a week for repeated certificates)",
  "caa":
    "a CAA record in this name's DNS does not allow Let's Encrypt to issue; check that your DNS CAA records allow letsencrypt.org, then try again",
  "rejected-identifier":
    "Let's Encrypt will not issue a certificate for this name; check that the name is a public domain you own",
  "invalid-contact":
    "Let's Encrypt rejected the contact email; fix it under the certificate settings and try again",
  "dns":
    "this name's DNS does not point at this server; fix the DNS record and try again",
  "unauthorized":
    "Let's Encrypt could not validate this name over port 80; check that the DNS record points here and that port 80 is open, then try again",
  "network":
    "a network connection to or from Let's Encrypt failed; check that this server can reach the internet and that port 80 is open, then try again",
  "timeout":
    "the certificate request did not finish in time on this server; check that this server can reach the internet and that port 80 is open, then try again",
};
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

const GENERIC =
  "Let's Encrypt could not issue a certificate; see the control plane log for details";

/** Fixed window and Caddy messages this module knows how to say in plain words. */
const WINDOW_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [
    /^hosting Caddy (reload|enable|disable) failed/,
    "the web server needed to answer Let's Encrypt could not be started on this server; check the hosting web server service and try again",
  ],
  [
    /^hosting Caddy is not listening on port 80/,
    "the web server needed to answer Let's Encrypt did not start listening on port 80; check the hosting web server service and try again",
  ],
  [
    /^port 80 inspection failed/,
    "this server could not check what is using port 80; make sure the ss command is installed and try again",
  ],
];

/** Plain words for one raw issuer or window error. Never returns the raw text. */
export function plainInstanceAcmeFailure(raw: string): string {
  const held = /port 80 is held by (.*)$/m.exec(raw);
  if (held) {
    return `port 80 is held by ${
      held[1]
    }; stop it or free port 80 and try again`;
  }
  const problem = instanceAcmeProblem(raw);
  if (problem) return PLAIN[problem];
  for (const [pattern, message] of WINDOW_MESSAGES) {
    if (pattern.test(raw)) return message;
  }
  return GENERIC;
}

function rowFailure(raw: string, host: string): Error {
  return new Error(
    `${INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX}${host}: ${
      plainInstanceAcmeFailure(raw)
    }`,
  );
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
  const raw = errorText(err);
  if (raw.startsWith(INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX) || !host) {
    return err instanceof Error ? err : new Error(raw);
  }
  logWarn("deploy", "instance ACME issuance failed:", raw);
  return rowFailure(raw, host);
}

/** Window-open errors: the port 80 holder and the fixed local failures. */
export function instanceAcmeWindowFailure(
  err: unknown,
  host: string | undefined,
): Error {
  const raw = errorText(err);
  const known = raw.startsWith("port 80 is held by") ||
    WINDOW_MESSAGES.some(([pattern]) => pattern.test(raw));
  if (!known) return err instanceof Error ? err : new Error(raw);
  return instanceAcmeRowFailure(err, host);
}

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const cooldowns = new Map<string, number>();

function cooldownKey(host: string, issuerKey: string): string {
  return `${issuerKey}/${host}`;
}

/** Start the cooldown for each host when the failure was a rate limit. */
export function noteInstanceAcmeFailure(
  err: unknown,
  hosts: readonly string[],
  issuerKey: string,
  nowMs: number,
): void {
  const raw = errorText(err);
  if (instanceAcmeProblem(raw) !== "rate-limited") return;
  for (const host of hosts) {
    cooldowns.set(cooldownKey(host, issuerKey), nowMs + RATE_LIMIT_COOLDOWN_MS);
  }
}

/**
 * After a rate limit, another Save & Apply inside the hour would only spend
 * more of Let's Encrypt's allowance: refuse it here and say when to retry.
 */
export function instanceAcmeCooldownError(
  hosts: readonly string[],
  issuerKey: string,
  nowMs: number,
): Error | null {
  for (const host of hosts) {
    const until = cooldowns.get(cooldownKey(host, issuerKey));
    if (until === undefined) continue;
    if (until <= nowMs) {
      cooldowns.delete(cooldownKey(host, issuerKey));
      continue;
    }
    const at = new Date(until).toISOString().slice(11, 16);
    return new Error(
      `${INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX}${host}: Let's Encrypt is limiting requests for this name; not asking again until ${at} UTC`,
    );
  }
  return null;
}

export function resetInstanceAcmeCooldownsForTest(): void {
  cooldowns.clear();
}
