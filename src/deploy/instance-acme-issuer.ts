/**
 * JSON config for the short-lived control-plane Let's Encrypt issuer.
 *
 * Control-plane Caddy does not speak ACME. This process is a second Caddy
 * that only obtains certificates. Its HTTP server listens on a Unix socket.
 * Hosting Caddy on port 80 forwards the challenge path there and keeps the
 * Host header. Proven on Caddy 2.11.4 against Let's Encrypt staging: the
 * process binds no TCP port when port 80 is already taken, the socket
 * returns the challenge, and a restart renews a stored leaf that is inside
 * the renewal window without binding a TCP port. Setting `challenges.bind_host`
 * to the socket path does not work — certmagic treats it as a TCP host.
 */

import { X509Certificate } from "node:crypto";
import type { InstanceAcmeWireSettings } from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { join } from "@std/path";

export const INSTANCE_ACME_SERVICE = "turbopanel-instance-acme.service";
export const HOSTING_CADDY_SERVICE = "turbopanel-hosting-caddy.service";

/** About the last third of the certificate lifetime. Set explicitly so a renewal reuses this file. */
export const INSTANCE_ACME_RENEWAL_WINDOW_RATIO = 0.33;

/**
 * How long to wait after the issuer is up, when a certificate is already
 * on disk, is outside the renewal window, and no obtain or renew line has
 * appeared, before treating that certificate as current. A certificate
 * inside the window is not accepted until a different valid leaf is written.
 */
export const INSTANCE_ACME_UNCHANGED_SETTLE_MS = 5_000;

export const INSTANCE_ACME_ISSUE_TIMEOUT_MS = 180_000;

export const LETS_ENCRYPT_DIRECTORY_URL =
  "https://acme-v02.api.letsencrypt.org/directory";

export const LETS_ENCRYPT_STAGING_DIRECTORY_URL =
  "https://acme-staging-v02.api.letsencrypt.org/directory";

/** Stable detail phrase. Keep in step with the control plane and the UI. */
export const INSTANCE_ACME_HTTP01_ISSUER_UNREACHABLE =
  "did not reach the instance ACME issuer";

export const INSTANCE_ACME_CERT_GROUP = "tp";

export function instanceAcmeSocketPath(layout: LayoutPaths): string {
  return join(layout.runDir, "instance-acme.sock");
}

export function instanceAcmeConfigPath(layout: LayoutPaths): string {
  return join(layout.configDir, "caddy", "instance-acme.json");
}

export function instanceAcmeLogPath(layout: LayoutPaths): string {
  return join(layout.logDir, "instance-acme.log");
}

export function instanceAcmeDataDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "instance-acme");
}

/** Caddy certificate storage under {@link instanceAcmeDataDir}. */
export function instanceAcmeCertificateRoot(layout: LayoutPaths): string {
  return join(instanceAcmeDataDir(layout), "caddy", "certificates");
}

export function instanceAcmeIssuerDirectory(
  settings: InstanceAcmeWireSettings,
): string {
  const directory = settings.directoryUrl.trim();
  if (settings.useStaging) {
    if (
      directory.length === 0 || directory === LETS_ENCRYPT_DIRECTORY_URL
    ) {
      return LETS_ENCRYPT_STAGING_DIRECTORY_URL;
    }
  }
  if (directory.length > 0) return directory;
  return LETS_ENCRYPT_DIRECTORY_URL;
}

export type InstanceAcmeIssuerConfigInput = {
  hosts: readonly string[];
  instanceAcme: InstanceAcmeWireSettings;
  socketPath: string;
  logFile: string;
  renewalWindowRatio?: number;
};

export function instanceAcmeIssuerConfig(
  input: InstanceAcmeIssuerConfigInput,
): Record<string, unknown> {
  if (!input.instanceAcme.tosAccepted) {
    throw new Error("Let's Encrypt terms have not been accepted");
  }
  if (!input.socketPath.startsWith("/")) {
    throw new Error("instance ACME socket path must be absolute");
  }
  const directory = instanceAcmeIssuerDirectory(input.instanceAcme);
  if (!directory.startsWith("https://")) {
    throw new Error("Let's Encrypt directory URL must be https");
  }
  const hosts = [...input.hosts].sort((a, b) => a.localeCompare(b));
  const issuer: Record<string, unknown> = {
    module: "acme",
    ca: directory,
    challenges: {
      "tls-alpn": { disabled: true },
    },
  };
  const email = input.instanceAcme.contactEmail.trim();
  if (email.length > 0) issuer.email = email;
  return {
    logging: {
      logs: {
        default: {
          level: "info",
          encoder: { format: "json" },
          writer: { output: "file", filename: input.logFile },
        },
      },
    },
    admin: { disabled: true },
    apps: {
      http: {
        servers: {
          acme: {
            listen: [`unix/${input.socketPath}`],
            automatic_https: { disable: true },
            routes: [
              {
                handle: [
                  { handler: "static_response", status_code: 404 },
                ],
              },
            ],
          },
        },
      },
      tls: {
        certificates: { automate: hosts },
        automation: {
          policies: [
            {
              subjects: hosts,
              renewal_window_ratio: input.renewalWindowRatio ??
                INSTANCE_ACME_RENEWAL_WINDOW_RATIO,
              issuers: [issuer],
            },
          ],
        },
      },
    },
  };
}

export function renderInstanceAcmeIssuerConfig(
  input: InstanceAcmeIssuerConfigInput,
): string {
  return `${JSON.stringify(instanceAcmeIssuerConfig(input), null, 2)}\n`;
}

function mentionsHost(line: string, host: string): boolean {
  return line.includes(`"${host}"`) || line.includes(`[${host}]`);
}

function lineHasMessage(line: string, message: string): boolean {
  return line.includes(`"msg":"${message}"`);
}

/** A terminal issuer error, if the log contains one. */
export function instanceAcmeIssuerFailureLine(log: string): string | null {
  for (const line of log.split("\n")) {
    if (!isIssuerFailureLine(line)) continue;
    return line.length > 500 ? `${line.slice(0, 500)}…` : line;
  }
  return null;
}

function isIssuerFailureLine(line: string): boolean {
  if (!line.includes('"level":"error"')) return false;
  return lineHasMessage(line, "could not get certificate from issuer") ||
    lineHasMessage(line, "challenge failed") ||
    lineHasMessage(line, "giving up");
}

function hostIsBusy(log: string, host: string): boolean {
  for (const line of log.split("\n")) {
    if (!mentionsHost(line, host)) continue;
    if (lineHasMessage(line, "obtaining certificate")) return true;
    if (lineHasMessage(line, "renewing certificate")) return true;
  }
  return false;
}

function hostSucceeded(log: string, host: string): boolean {
  for (const line of log.split("\n")) {
    if (!mentionsHost(line, host)) continue;
    if (lineHasMessage(line, "certificate obtained successfully")) return true;
    if (lineHasMessage(line, "certificate renewed successfully")) return true;
    if (
      lineHasMessage(line, "certificate appears to have been renewed already")
    ) {
      return true;
    }
  }
  return false;
}

/** Leaf identity and whether it must be replaced before the window closes. */
export type IssuerCertificateInspection = {
  identity: string;
  valid: boolean;
  /** Inside the renewal window, or already expired. */
  due: boolean;
  /** Leaf `notAfter` as an ISO timestamp. */
  notAfter: string;
};

/** Certificate observed before the issuer process starts. */
export type InstanceAcmeCertificateBaseline = {
  identity: string | null;
  due: boolean;
};

/**
 * Parse an issuer leaf. Returns null when the PEM is not a certificate.
 * A leaf is due when the remaining lifetime is within
 * {@link INSTANCE_ACME_RENEWAL_WINDOW_RATIO} of its validity period.
 */
export function inspectIssuerCertificatePem(
  pem: string,
  nowMs: number,
  renewalWindowRatio = INSTANCE_ACME_RENEWAL_WINDOW_RATIO,
): IssuerCertificateInspection | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return null;
  }
  const notBeforeMs = Date.parse(cert.validFrom);
  const notAfterMs = Date.parse(cert.validTo);
  const lifetimeMs = notAfterMs - notBeforeMs;
  if (!Number.isFinite(notBeforeMs) || !Number.isFinite(notAfterMs)) {
    return null;
  }
  if (lifetimeMs <= 0) return null;
  const windowMs = lifetimeMs * renewalWindowRatio;
  return {
    identity: cert.fingerprint256,
    valid: nowMs >= notBeforeMs && nowMs < notAfterMs,
    due: nowMs >= notAfterMs - windowMs,
    notAfter: new Date(notAfterMs).toISOString(),
  };
}

/** Account knobs the renewal scheduler reads back after an issue. */
export function instanceAcmeSettingsPath(layout: LayoutPaths): string {
  return join(layout.configDir, "caddy", "instance-acme-settings.json");
}

export function renderInstanceAcmeSettings(
  settings: InstanceAcmeWireSettings,
): string {
  return `${
    JSON.stringify({
      contactEmail: settings.contactEmail,
      tosAccepted: settings.tosAccepted,
      directoryUrl: settings.directoryUrl,
      useStaging: settings.useStaging,
    })
  }\n`;
}

export function parseInstanceAcmeSettings(
  raw: string,
): InstanceAcmeWireSettings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isInstanceAcmeSettings(parsed)) return null;
  return {
    contactEmail: parsed.contactEmail,
    tosAccepted: parsed.tosAccepted,
    directoryUrl: parsed.directoryUrl,
    useStaging: parsed.useStaging,
  };
}

export async function readInstanceAcmeSettings(
  layout: LayoutPaths,
): Promise<InstanceAcmeWireSettings | null> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(instanceAcmeSettingsPath(layout));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  return parseInstanceAcmeSettings(raw);
}

function isInstanceAcmeSettings(
  value: unknown,
): value is InstanceAcmeWireSettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.contactEmail === "string" &&
    typeof record.tosAccepted === "boolean" &&
    typeof record.directoryUrl === "string" &&
    typeof record.useStaging === "boolean";
}

/**
 * True when this host's leaf may be copied.
 *
 * A due certificate (inside the renewal window, or expired) stays open
 * until a different, currently valid leaf is on disk. An unchanged leaf is
 * accepted only when it is not due.
 */
export function instanceAcmeHostSettled(
  log: string,
  host: string,
  baseline: InstanceAcmeCertificateBaseline,
  elapsedMs: number,
  current: { identity: string | null; valid: boolean },
): boolean {
  if (baseline.due) return replacedValidCertificate(baseline, current);
  if (!current.valid || current.identity === null) return false;
  if (hostIsBusy(log, host) && !hostSucceeded(log, host)) return false;
  if (hostSucceeded(log, host)) return true;
  if (current.identity !== baseline.identity) return true;
  return elapsedMs >= INSTANCE_ACME_UNCHANGED_SETTLE_MS;
}

function replacedValidCertificate(
  baseline: InstanceAcmeCertificateBaseline,
  current: { identity: string | null; valid: boolean },
): boolean {
  if (!current.valid || current.identity === null) return false;
  return current.identity !== baseline.identity;
}
