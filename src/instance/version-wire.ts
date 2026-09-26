/**
 * Daemon-side twin of `turbopanel/src/lib/version-wire.ts`.
 *
 * The two repos cannot share a module across the Deno/Workers boundary, so
 * `parseSemver` / `compareSemver` are duplicated here the same way
 * `DAEMON_CELL_PING` is duplicated in `idle-presence.ts`. Keep the precedence
 * rules identical. `MIN_SUPPORTED_INSTANCE_VERSION` is the mirror of the
 * instance's `MIN_SUPPORTED_DAEMON_VERSION`: bump them together, with a reason
 * in both Versions-on-the-wires notes, never silently.
 *
 * `unknown` (no version, or one that is not a semver) passes for the floor —
 * an instance older than this field is not refused. Capability gates do the
 * opposite: an unknown peer does not support a feature, because offering a
 * panel control the peer cannot render is unsafe.
 *
 * Control-plane self-update (`instance-update`) is the one place this floor
 * refuses work: the daemon will not install a control plane below
 * `MIN_SUPPORTED_INSTANCE_VERSION`. A missing target version is `unknown`
 * and is allowed. The daemon's own self-update does not consult this floor
 * — it gates commands the daemon dispatches, not a daemon updating itself.
 * The control plane does not gate `instance-update` on the daemon's version;
 * the daemon only executes the reconcile.
 *
 * `DAEMON_WIRE_FEATURES` is the advertised feature set: this daemon lists it
 * on `hello`, and the control plane lists it on the attach `version` frame.
 * `instanceSupports` reads the peer's list. That is distinct from
 * `DAEMON_FEATURE_MIN_VERSIONS`, which infers support from a semver floor.
 * A new wire message is gated on the advertisement. It does not raise
 * either floor.
 */

export const INSTANCE_VERSION_HEADER = "x-turbopanel-version";

/**
 * Oldest control plane this daemon will treat as supported. A peer below the
 * floor stays connected; the daemon only flags the condition.
 */
export const MIN_SUPPORTED_INSTANCE_VERSION = "0.1.0";

/**
 * Panel features that need a daemon at or above a semver (the daemon renders
 * the artifact). `instance-cert-sources-per-hostname` opens when the connected
 * daemon is the release that renders per-hostname certificate sources in
 * `orchestration/roles/caddy/templates/Caddyfile.j2` — currently the 0.1.1
 * daemon line. The UI gate calls `resolveDaemonCapabilities` in the instance
 * twin; do not re-implement the comparison.
 */
export const DAEMON_FEATURE_MIN_VERSIONS: Readonly<Record<string, string>> = {
  "instance-cert-sources-per-hostname": "0.1.1",
};

/**
 * Features this process advertises on the cell wire. Twin of
 * `DAEMON_WIRE_FEATURES` in `turbopanel/src/lib/version-wire.ts` —
 * contract-drift keeps them equal.
 *
 * This list is what the peer says it supports. `DAEMON_FEATURE_MIN_VERSIONS`
 * is the semver-floor inference for daemon-rendered artifacts. Do not treat
 * them as the same gate.
 */
export const DAEMON_WIRE_FEATURES = [
  "managed-upgrade-v1",
  "update-progress-v1",
  "sealed-instance-secrets-v1",
] as const;

export type DaemonWireFeature = (typeof DAEMON_WIRE_FEATURES)[number];

/**
 * This daemon opens `tpdaemon` envelopes on `public-urls-update`
 * (`keyEnvelope`) and `tunnel-token` (`tokenEnvelope`), so the control plane
 * seals those instance secrets instead of sending plaintext.
 */
export const SEALED_INSTANCE_SECRETS_FEATURE: DaemonWireFeature =
  "sealed-instance-secrets-v1";

/** Features that need an instance at or above a semver. Empty until one lands. */
export const INSTANCE_FEATURE_MIN_VERSIONS: Readonly<Record<string, string>> =
  {};

const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function parseSemver(
  value: string | undefined | null,
): ParsedSemver | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const m = SEMVER_RE.exec(
    trimmed.startsWith("v") ? trimmed.slice(1) : trimmed,
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** semver precedence: negative when `a` < `b`, zero when equal, positive when `a` > `b`. */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (c !== 0) return c;
  }
  return a.prerelease.length - b.prerelease.length;
}

export type InstanceSupportStatus = "supported" | "unsupported" | "unknown";

export type InstanceSupport = {
  status: InstanceSupportStatus;
  version: string | null;
  minVersion: string;
};

/**
 * Hold the control plane's reported version against
 * `MIN_SUPPORTED_INSTANCE_VERSION`. No version, or one that is not a semver,
 * is `unknown` — a flag, not a refusal.
 */
export function resolveInstanceSupport(
  reportedVersion: string | undefined | null,
  minVersion: string = MIN_SUPPORTED_INSTANCE_VERSION,
): InstanceSupport {
  const parsed = parseSemver(reportedVersion);
  const floor = parseSemver(minVersion);
  if (!parsed || !floor) {
    return {
      status: "unknown",
      version: parsed ? reportedVersion!.trim() : null,
      minVersion,
    };
  }
  return {
    status: compareSemver(parsed, floor) < 0 ? "unsupported" : "supported",
    version: reportedVersion!.trim(),
    minVersion,
  };
}

/** Greppable park-style flag. The daemon does not disconnect on this. */
export function instanceUnsupportedReason(support: InstanceSupport): string {
  return `instance-version: control plane version ${
    support.version ?? "unknown"
  } is below the supported minimum ${support.minVersion}; flagged — the daemon keeps reconnecting (update the control plane)`;
}

function peerSupportsFeature(
  parsed: ParsedSemver | null,
  minVersion: string,
): boolean {
  if (!parsed) return false;
  const floor = parseSemver(minVersion);
  if (!floor) return false;
  return compareSemver(parsed, floor) >= 0;
}

function resolvePeerCapabilities(
  reportedVersion: string | undefined | null,
  floors: Readonly<Record<string, string>>,
): Record<string, boolean> {
  const parsed = parseSemver(reportedVersion);
  const out: Record<string, boolean> = {};
  for (const [feature, minVersion] of Object.entries(floors)) {
    out[feature] = peerSupportsFeature(parsed, minVersion);
  }
  return out;
}

/** Which daemon-rendered features a reported daemon version can serve. */
export function resolveDaemonCapabilities(
  reportedVersion: string | undefined | null,
  floors: Readonly<Record<string, string>> = DAEMON_FEATURE_MIN_VERSIONS,
): Record<string, boolean> {
  return resolvePeerCapabilities(reportedVersion, floors);
}

/** Which instance-side features a reported control-plane version can serve. */
export function resolveInstanceCapabilities(
  reportedVersion: string | undefined | null,
  floors: Readonly<Record<string, string>> = INSTANCE_FEATURE_MIN_VERSIONS,
): Record<string, boolean> {
  return resolvePeerCapabilities(reportedVersion, floors);
}
