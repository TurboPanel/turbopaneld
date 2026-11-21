/**
 * SMB network shares as top-level Compose volumes (`network-shares-v1`).
 *
 * The local volume driver hands `type`, `device` and `o` to the mount helper,
 * so a `cifs` / `smb3` volume dials an address the author picks and passes
 * options to the kernel. When the control plane allows network shares for the
 * server (`allowNetworkShares`) the daemon accepts exactly this shape:
 *
 * - driver `local` (or absent), `driver_opts` holding only `type`, `device`, `o`;
 * - `device` is `//host/share[/path]` and the host is neither loopback,
 *   link-local, unspecified, a cloud metadata address nor `localhost`;
 * - every option in `o` is on {@link SAFE_OPTIONS} with a value of the right
 *   shape (no `suid`, `dev`, `exec`, `ip`, `sloppy` or any other option).
 *
 * The judged document is the resolved model (`docker compose config`), so
 * `${VAR}` interpolation has already happened; a value that still holds `$` is
 * an escaped literal and fails the shape checks like any other odd value.
 *
 * Compose text from the control plane never carries a login: `password=`,
 * `pass=`, `pwd=` and `credentials=` are refused (the kernel cifs client
 * ignores `credentials=` anyway). The daemon adds `username=`, `password=` and
 * `domain=` itself from sealed material (see `network-share-logins.ts`) after
 * the compose is judged, and the final check accepts exactly those tokens.
 *
 * Findings never repeat an option's value: they name the option or the host.
 * {@link redactMountOptions} masks `password=` for every line the daemon
 * writes about a share.
 */

import { ipScope } from "./compose-build-policy.ts";
import { REDACTED } from "../logs/redactor.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mount types that dial an SMB server. */
export const NETWORK_SHARE_TYPES: readonly string[] = ["cifs", "smb3"];

/** Shown in a refusal so the author knows what the control plane allows. */
export const NETWORK_SHARES_REFUSAL_NOTE =
  "network shares must be allowed for this server by an organization owner";

function volumeType(spec: unknown): string | undefined {
  if (!isRecord(spec) || !isRecord(spec.driver_opts)) return undefined;
  const type = spec.driver_opts.type;
  return typeof type === "string" ? type.trim().toLowerCase() : undefined;
}

/** True for a top-level volume whose mount type is `cifs` or `smb3`. */
export function isNetworkShareVolume(spec: unknown): boolean {
  const type = volumeType(spec);
  return type !== undefined && NETWORK_SHARE_TYPES.includes(type);
}

/** The top-level volumes of a resolved model that are SMB shares, by name. */
export function networkShareVolumes(
  document: Record<string, unknown>,
): Array<[string, Record<string, unknown>]> {
  const volumes = document.volumes;
  if (!isRecord(volumes)) return [];
  return Object.entries(volumes).filter((
    entry,
  ): entry is [string, Record<string, unknown>] =>
    isNetworkShareVolume(entry[1])
  );
}

/** True when the resolved model mounts at least one SMB share. */
export function hasNetworkShares(document: Record<string, unknown>): boolean {
  return networkShareVolumes(document).length > 0;
}

// --- option string ---------------------------------------------------------

const PASSWORD_KEYS = ["password=", "pass=", "pwd="];

/**
 * Split an `o` string on commas. mount.cifs writes a comma inside a password
 * as `,,`, so after a `password=` key the doubled comma stays in the value.
 */
export function splitMountOptions(o: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (let i = 0; i < o.length; i++) {
    const ch = o[i];
    if (ch !== ",") {
      current += ch;
      continue;
    }
    const inPassword = PASSWORD_KEYS.some((key) =>
      current.trimStart().toLowerCase().startsWith(key)
    );
    if (inPassword && o[i + 1] === ",") {
      current += ",";
      i++;
      continue;
    }
    tokens.push(current);
    current = "";
  }
  tokens.push(current);
  return tokens;
}

/** An `o` string with every password value replaced, safe to log. */
export function redactMountOptions(o: string): string {
  return splitMountOptions(o).map((token) => {
    const trimmed = token.trimStart();
    const key = PASSWORD_KEYS.find((k) => trimmed.toLowerCase().startsWith(k));
    return key === undefined
      ? token
      : `${trimmed.slice(0, key.length)}${REDACTED}`;
  }).join(",");
}

/** One redacted line naming a share, for the deploy log. */
export function describeNetworkShare(
  name: string,
  spec: Record<string, unknown>,
): string {
  const driverOpts = isRecord(spec.driver_opts) ? spec.driver_opts : {};
  const device = typeof driverOpts.device === "string"
    ? driverOpts.device
    : "(no device)";
  const o = typeof driverOpts.o === "string"
    ? redactMountOptions(driverOpts.o)
    : "";
  const shown = o === "" ? "" : ` (${o})`;
  return `Network share volume ${name}: ${device}${shown}`;
}

// --- host -------------------------------------------------------------------

const HOSTNAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const DOTTED_QUAD = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;
/** The default bridge's gateway: containers reach the host's own services there. */
const DOCKER_BRIDGE_GATEWAY = "172.17.0.1"; // NOSONAR typescript:S1313 - Docker default bridge gateway, refused as a share host
const LOCAL_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/** Why a share host is refused, or `null` when it may be dialed. */
export function shareHostRefusal(raw: string): string | null {
  const host = raw.trim();
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) return "is not a valid address";
    const scope = ipScope(host);
    if (scope === null) return "is not a valid address";
    return scope === "internal" ? INTERNAL_REASON : null;
  }
  if (host.length === 0 || host.length > 253 || !HOSTNAME.test(host)) {
    return "is not a valid host name or address";
  }
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === DOCKER_BRIDGE_GATEWAY) {
    return "is the Docker bridge gateway (this server itself)";
  }
  if (LOCAL_NAMES.has(name) || name.endsWith(".localhost")) {
    return "is this server itself (localhost)";
  }
  const lastLabel = name.slice(name.lastIndexOf(".") + 1);
  // A name whose last label is numeric is an address in disguise (`127.1`,
  // `2130706433`, `0x7f.1`, `0177.0.0.1`): only a plain dotted quad is read.
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(lastLabel)) {
    if (!DOTTED_QUAD.test(name)) {
      return "is an address in a form the daemon cannot check (use a plain a.b.c.d address or a host name)";
    }
    return ipScope(name) === "internal" ? INTERNAL_REASON : null;
  }
  return null;
}

const INTERNAL_REASON =
  "is a loopback, link-local, unspecified, multicast or cloud metadata address";

type Pattern = { test: (value: string) => boolean };

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

const SHARE_SEGMENT: Pattern = {
  test: (value) =>
    value.length > 0 && !hasControlChar(value) && !/[/\\,:*?"<>|]/.test(value),
};

/** Parse `//host/share[/path]`; the refusal is a sentence fragment. */
function parseShareDevice(
  device: string,
): { host: string; refusal?: undefined } | { refusal: string } {
  const match = /^\/\/(\[[^\]/]*\]|[^/]+)\/(.+)$/.exec(device);
  if (match === null) {
    return {
      refusal: "device must look like //host/share or //host/share/path",
    };
  }
  const segments = match[2].replace(/\/$/, "").split("/");
  if (
    segments.some((s) => s === "." || s === ".." || !SHARE_SEGMENT.test(s))
  ) {
    return {
      refusal: "device share or path has an empty, dot or unsupported segment",
    };
  }
  return { host: match[1] };
}

// --- options ----------------------------------------------------------------

const NUMBER = /^\d{1,10}$/;
const NAME: Pattern = {
  test: (value) =>
    value.length >= 1 && value.length <= 256 && !hasControlChar(value),
};

/** Options that take no value. Only ones that cannot widen what the mount reaches. */
const FLAG_OPTIONS: ReadonlySet<string> = new Set([
  "ro",
  "rw",
  "noperm",
  "nounix",
  "unix",
  "serverino",
  "noserverino",
  "soft",
  "hard",
  "nobrl",
  "brl",
  "mfsymlinks",
  "nomfsymlinks",
  "noblocksend",
  "nosharesock",
  "forceuid",
  "forcegid",
  "guest",
  "nocase",
  "nosuid",
  "nodev",
  "noexec",
]);

/** Options with a value, each with the shape its value must have. */
const VALUE_OPTIONS: Readonly<Record<string, Pattern>> = {
  username: NAME,
  domain: NAME,
  workgroup: NAME,
  uid: NUMBER,
  gid: NUMBER,
  file_mode: /^0?[0-7]{3}$/,
  dir_mode: /^0?[0-7]{3}$/,
  vers: /^(?:2\.0|2\.1|3|3\.0|3\.02|3\.1\.1|default)$/,
  sec: /^(?:krb5|krb5i|ntlmsspi|ntlmssp|ntlmv2|ntlmv2i|none)$/,
  iocharset: /^[A-Za-z0-9_-]{1,32}$/,
  cache: /^(?:none|strict|loose)$/,
  actimeo: NUMBER,
  echo_interval: NUMBER,
  rsize: NUMBER,
  wsize: NUMBER,
};

/** The options an `o` string may hold, for the refusal text. */
export const SAFE_OPTIONS: readonly string[] = [
  ...Object.keys(VALUE_OPTIONS),
  "addr",
  ...FLAG_OPTIONS,
].sort((a, b) => a.localeCompare(b));

function optionKey(token: string): { key: string; value?: string } {
  const trimmed = token.trim();
  const eq = trimmed.indexOf("=");
  return eq < 0 ? { key: trimmed.toLowerCase() } : {
    key: trimmed.slice(0, eq).trim().toLowerCase(),
    value: trimmed.slice(eq + 1),
  };
}

const SECRET_OPTION_KEYS: ReadonlySet<string> = new Set([
  "password",
  "pass",
  "pwd",
  "password2",
]);

const NEVER_OPTIONS: ReadonlySet<string> = new Set([
  "bind",
  "rbind",
  "remount",
]);

function forbiddenOptionRefusal(key: string): string | null {
  if (SECRET_OPTION_KEYS.has(key)) {
    return `option "${key}" is not allowed in compose text (the control plane supplies share logins as sealed material)`;
  }
  if (key === "credentials" || key === "cred") {
    return `option "${key}" is not allowed (the kernel cifs client ignores it; the control plane supplies share logins as sealed material)`;
  }
  if (NEVER_OPTIONS.has(key)) {
    return `option "${key}" is never allowed on a network share`;
  }
  return null;
}

function optionRefusal(token: string): string | null {
  const { key, value } = optionKey(token);
  if (key === "") return "an empty option";
  const forbidden = forbiddenOptionRefusal(key);
  if (forbidden !== null) return forbidden;
  if (key === "addr") {
    const why = value === undefined ? "needs a value" : shareHostRefusal(value);
    return why === null ? null : `option "addr" ${why}`;
  }
  if (FLAG_OPTIONS.has(key)) {
    return value === undefined ? null : `option "${key}" takes no value`;
  }
  const shape = Object.hasOwn(VALUE_OPTIONS, key)
    ? VALUE_OPTIONS[key]
    : undefined;
  if (shape === undefined) {
    const allowed = SAFE_OPTIONS.join(", ");
    return `option "${key}" is not allowed (setuid, device, exec and other mount options are refused; allowed: ${allowed})`;
  }
  return value !== undefined && shape.test(value)
    ? null
    : `option "${key}" has a missing or unsupported value`;
}

// --- one volume -------------------------------------------------------------

export type NetworkShareContext = {
  /**
   * The exact `username=`, `password=` and `domain=` tokens the daemon added
   * for this volume's login. Only those tokens are exempt from the refusals;
   * set by the final check, never when judging compose text.
   */
  injectedTokens?: readonly string[];
};

function deviceFindings(prefix: string, device: unknown): string[] {
  if (typeof device !== "string") {
    return [`${prefix} a network share needs a device like //host/share`];
  }
  const parsed = parseShareDevice(device);
  if (parsed.refusal !== undefined) return [`${prefix} ${parsed.refusal}`];
  const why = shareHostRefusal(parsed.host);
  return why === null ? [] : [`${prefix} share host "${parsed.host}" ${why}`];
}

function optionFindings(
  prefix: string,
  o: unknown,
  injectedTokens: readonly string[],
): string[] {
  if (o === undefined) return [];
  if (typeof o !== "string") {
    return [`${prefix} o must be a string of mount options`];
  }
  const found: string[] = [];
  const pending = [...injectedTokens];
  for (const token of splitMountOptions(o)) {
    const at = pending.indexOf(token);
    if (at >= 0) {
      pending.splice(at, 1);
      continue;
    }
    const why = optionRefusal(token);
    if (why !== null) found.push(`${prefix} ${why}`);
  }
  if (pending.length > 0) {
    found.push(`${prefix} the share login is missing from its options`);
  }
  return found;
}

/** Findings for one SMB volume; empty when it may be mounted. */
export function networkShareFindings(
  name: string,
  spec: Record<string, unknown>,
  ctx: NetworkShareContext,
): string[] {
  const prefix = `volume ${name}:`;
  if (spec.driver !== undefined && spec.driver !== "local") {
    return [`${prefix} a network share needs the local volume driver`];
  }
  const opts = isRecord(spec.driver_opts) ? spec.driver_opts : {};
  const extra = Object.keys(opts).filter((k) =>
    k !== "type" && k !== "device" && k !== "o"
  );
  if (extra.length > 0) {
    const named = extra.map((k) => JSON.stringify(k)).join(", ");
    return [
      `${prefix} driver option ${named} is not allowed for a network share (only type, device and o)`,
    ];
  }
  return [
    ...deviceFindings(prefix, opts.device),
    ...optionFindings(prefix, opts.o, ctx.injectedTokens ?? []),
  ];
}

/**
 * The last check before compose starts, on the final resolved model: every
 * share volume must pass {@link networkShareFindings} (with only the login
 * tokens the daemon added for it) and the server must allow shares.
 */
export function assertNetworkSharesFinal(
  document: Record<string, unknown>,
  opts: {
    allowNetworkShares: boolean;
    /** Volume to the login tokens the daemon injected into its `o`. */
    injectedLogins?: ReadonlyMap<string, readonly string[]>;
  },
): void {
  const found: string[] = [];
  for (const [name, spec] of networkShareVolumes(document)) {
    if (!opts.allowNetworkShares) {
      found.push(`volume ${name}: ${NETWORK_SHARES_REFUSAL_NOTE}`);
      continue;
    }
    found.push(
      ...networkShareFindings(name, spec, {
        injectedTokens: opts.injectedLogins?.get(name),
      }),
    );
  }
  if (found.length > 0) {
    throw new Error(
      `network share volumes refused before start: ${found.join("; ")}`,
    );
  }
}
