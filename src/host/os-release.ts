import { type HostResources, readHostResources } from "./host-inventory.ts";
import { cachedMachineKey } from "./machine-key.ts";

/** OS families we may report; keep in sync with instance `ServerOsFamily`. */
export type HostOsFamily = "linux" | "windows" | "freebsd" | "darwin";

/**
 * Distro variant beyond raw `ID=` — used when Debian-based images are actually
 * Raspberry Pi OS (64-bit reports `ID=debian` but ships `/etc/rpi-issue`).
 */
export type HostOsVariant = "raspberry-pi-os";

/**
 * Host OS identity collected from `/etc/os-release` (+ Deno build info).
 * Mirrored by instance `ServerOsMetadata`.
 */
export type HostOsMetadata = {
  family: HostOsFamily;
  /** Distro id from `ID=` (e.g. `"debian"`, `"raspbian"`). */
  id?: string;
  /**
   * Product variant when `ID` alone is misleading.
   * Set to `"raspberry-pi-os"` when `/etc/rpi-issue` exists (incl. 64-bit
   * Raspberry Pi OS that still reports `ID=debian`).
   */
  variant?: HostOsVariant;
  /** Prefer `DEBIAN_VERSION_FULL` / `/etc/debian_version` (e.g. `"13.5"`). */
  version?: string;
  /** `VERSION_CODENAME` (e.g. `"trixie"`). */
  codename?: string;
  /** Raw `PRETTY_NAME` from os-release. */
  prettyName?: string;
  /** e.g. `"arm64"`, `"x86_64"`. */
  architecture?: string;
};

export type HostHelloIdentity = {
  hostname?: string;
  machineKey?: string;
  os?: HostOsMetadata;
  /** Capacity facts (cpu/mem/swap totals) for fleet inventory + load bars. */
  resources?: HostResources;
};

const OS_RELEASE_PATH = "/etc/os-release";
const DEBIAN_VERSION_PATH = "/etc/debian_version";
const RPI_ISSUE_PATH = "/etc/rpi-issue";

let cachedOs: HostOsMetadata | undefined | null = null;

function readTextFile(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    // Deno 2 may block some paths under scoped --allow-read; fall back to cat.
  }

  try {
    const { code, stdout } = new Deno.Command("cat", {
      args: [path],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    // fall through
  }
  try {
    const { code } = new Deno.Command("test", {
      args: ["-e", path],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return code === 0;
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse os-release KEY=VALUE lines into a map (values unquoted). */
export function parseOsReleaseText(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1));
    if (key) fields[key] = value;
  }
  return fields;
}

function mapDenoOsFamily(os: string): HostOsFamily | undefined {
  switch (os) {
    case "linux":
      return "linux";
    case "windows":
      return "windows";
    case "freebsd":
      return "freebsd";
    case "darwin":
      return "darwin";
    default:
      return undefined;
  }
}

function familyFromOsRelease(
  fields: Record<string, string>,
): HostOsFamily | undefined {
  const id = fields.ID?.toLowerCase();
  const like = fields.ID_LIKE?.toLowerCase() ?? "";
  if (id === "darwin" || like.includes("darwin")) return "darwin";
  if (id === "freebsd" || like.includes("freebsd")) return "freebsd";
  if (
    id === "windows" ||
    like.includes("windows") ||
    id === "msys" ||
    id === "cygwin"
  ) {
    return "windows";
  }
  // Most /etc/os-release hosts are Linux distros.
  if (id || fields.PRETTY_NAME || fields.NAME) return "linux";
  return undefined;
}

/**
 * Prefer the dotted Debian point-release (`13.5`) over bare `VERSION_ID` (`13`).
 * Exported for tests.
 */
export function resolveOsVersion(
  fields: Record<string, string>,
  debianVersionFile?: string,
): string | undefined {
  const full = fields.DEBIAN_VERSION_FULL?.trim();
  if (full && /^\d/.test(full)) return full;

  const fromFile = debianVersionFile?.trim();
  // Ignore suite names like "trixie/sid"; keep numeric point releases.
  if (fromFile && /^\d+(\.\d+)*/.test(fromFile)) {
    const match = /^(\d+(?:\.\d+)*)/.exec(fromFile);
    if (match?.[1]) return match[1];
  }

  const versionId = fields.VERSION_ID?.trim();
  if (versionId) return versionId;
  return undefined;
}

function resolveOsVariant(
  fields: Record<string, string>,
  rpiIssuePresent: boolean,
): HostOsVariant | undefined {
  const id = fields.ID?.trim().toLowerCase();
  if (id === "raspbian" || rpiIssuePresent) return "raspberry-pi-os";
  return undefined;
}

/**
 * Build {@link HostOsMetadata} from os-release field map + Deno build info.
 * Exported for unit tests with fixture strings.
 */
export function hostOsFromFields(
  fields: Record<string, string>,
  build: { os: string; arch: string } = Deno.build,
  extras: {
    debianVersionFile?: string;
    rpiIssuePresent?: boolean;
  } = {},
): HostOsMetadata | undefined {
  const family = familyFromOsRelease(fields) ?? mapDenoOsFamily(build.os);
  if (!family) return undefined;

  const os: HostOsMetadata = { family };
  const id = fields.ID?.trim();
  if (id) os.id = id;
  const variant = resolveOsVariant(fields, extras.rpiIssuePresent === true);
  if (variant) os.variant = variant;
  const version = resolveOsVersion(fields, extras.debianVersionFile);
  if (version) os.version = version;
  const codename = fields.VERSION_CODENAME?.trim();
  if (codename) os.codename = codename;
  const prettyName = fields.PRETTY_NAME?.trim();
  if (prettyName) os.prettyName = prettyName;
  const architecture = build.arch?.trim();
  if (architecture) os.architecture = architecture;
  return os;
}

/** Read and cache `/etc/os-release` for the process lifetime. */
export function readOsRelease(
  path: string = OS_RELEASE_PATH,
): HostOsMetadata | undefined {
  if (path === OS_RELEASE_PATH && cachedOs !== null) {
    return cachedOs;
  }

  const text = readTextFile(path);
  const os = text
    ? hostOsFromFields(parseOsReleaseText(text), Deno.build, {
      debianVersionFile: readTextFile(DEBIAN_VERSION_PATH),
      rpiIssuePresent: pathExists(RPI_ISSUE_PATH),
    })
    : (() => {
      const family = mapDenoOsFamily(Deno.build.os);
      if (!family) return undefined;
      const fallback: HostOsMetadata = { family };
      if (Deno.build.arch) fallback.architecture = Deno.build.arch;
      return fallback;
    })();

  if (path === OS_RELEASE_PATH) {
    cachedOs = os;
  }
  return os;
}

/**
 * Host identity fields attached to the daemon WS `hello` frame once per connect.
 * OS is static for the process; hostname is re-read cheaply. `machineKey` comes
 * from the process-level cache in `machine-key.ts` — warm it with
 * `readMachineKey()` on the connect path before hello (HMAC is async).
 */
export function getHostHelloIdentity(): HostHelloIdentity {
  const identity: HostHelloIdentity = {};
  try {
    const hostname = Deno.hostname()?.trim();
    if (hostname) identity.hostname = hostname;
  } catch {
    // hostname may be unavailable under restricted --allow-sys
  }
  const machineKey = cachedMachineKey();
  if (machineKey) identity.machineKey = machineKey;
  const os = readOsRelease();
  if (os) identity.os = os;
  const resources = readHostResources();
  if (resources) identity.resources = resources;
  return identity;
}

/** Test helper — clear process caches between fixture cases. */
export function resetHostOsCacheForTests(): void {
  cachedOs = null;
}
