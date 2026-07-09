/** OS families we may report; keep in sync with instance `ServerOsFamily`. */
export type HostOsFamily = "linux" | "windows" | "freebsd" | "darwin";

/**
 * Host OS identity collected from `/etc/os-release` (+ Deno build info).
 * Mirrored by instance `ServerOsMetadata`.
 */
export type HostOsMetadata = {
  family: HostOsFamily;
  /** Distro id from `ID=` (e.g. `"debian"`). */
  id?: string;
  /** `VERSION_ID` (e.g. `"13"` / `"13.1"`). */
  version?: string;
  /** `VERSION_CODENAME` (e.g. `"trixie"`). */
  versionCodename?: string;
  /** Raw `PRETTY_NAME` from os-release. */
  prettyName?: string;
  /** e.g. `"arm64"`, `"x86_64"`. */
  arch?: string;
};

export type HostHelloIdentity = {
  hostname?: string;
  machineId?: string;
  os?: HostOsMetadata;
};

const OS_RELEASE_PATH = "/etc/os-release";

let cachedOs: HostOsMetadata | undefined | null = null;
let cachedMachineId: string | undefined | null = null;

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
 * Build {@link HostOsMetadata} from os-release field map + Deno build info.
 * Exported for unit tests with fixture strings.
 */
export function hostOsFromFields(
  fields: Record<string, string>,
  build: { os: string; arch: string } = Deno.build,
): HostOsMetadata | undefined {
  const family = familyFromOsRelease(fields) ?? mapDenoOsFamily(build.os);
  if (!family) return undefined;

  const os: HostOsMetadata = { family };
  const id = fields.ID?.trim();
  if (id) os.id = id;
  const version = fields.VERSION_ID?.trim();
  if (version) os.version = version;
  const codename = fields.VERSION_CODENAME?.trim();
  if (codename) os.versionCodename = codename;
  const prettyName = fields.PRETTY_NAME?.trim();
  if (prettyName) os.prettyName = prettyName;
  const arch = build.arch?.trim();
  if (arch) os.arch = arch;
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
    ? hostOsFromFields(parseOsReleaseText(text))
    : (() => {
      const family = mapDenoOsFamily(Deno.build.os);
      if (!family) return undefined;
      const fallback: HostOsMetadata = { family };
      if (Deno.build.arch) fallback.arch = Deno.build.arch;
      return fallback;
    })();

  if (path === OS_RELEASE_PATH) {
    cachedOs = os;
  }
  return os;
}

function readMachineIdCached(): string | undefined {
  if (cachedMachineId !== null) return cachedMachineId;
  const text = readTextFile("/etc/machine-id")?.trim();
  cachedMachineId = text && text.length > 0 ? text : undefined;
  return cachedMachineId;
}

/**
 * Host identity fields attached to the daemon WS `hello` frame once per connect.
 * OS is static for the process; hostname/machineId are re-read cheaply.
 */
export function getHostHelloIdentity(): HostHelloIdentity {
  const identity: HostHelloIdentity = {};
  try {
    const hostname = Deno.hostname()?.trim();
    if (hostname) identity.hostname = hostname;
  } catch {
    // hostname may be unavailable under restricted --allow-sys
  }
  const machineId = readMachineIdCached();
  if (machineId) identity.machineId = machineId;
  const os = readOsRelease();
  if (os) identity.os = os;
  return identity;
}

/** Test helper — clear process caches between fixture cases. */
export function resetHostOsCacheForTests(): void {
  cachedOs = null;
  cachedMachineId = null;
}
