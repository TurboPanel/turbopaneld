/**
 * Host Docker CLI / Compose plugin versions for hello + change-detected heartbeat.
 *
 * The `docker` metadata area is omitted entirely when the Docker CLI is not
 * installed. Re-probe on every call so a later Ansible `ensureDocker` is
 * reported on the next presence tick without waiting for reconnect.
 *
 * Docker data-root discovery is CLI-free: it reads the Docker Engine API
 * (`GET /info`) over the Unix socket via {@link DockerClient}.
 */
import { DockerClient, type DockerInfo } from "../docker/client.ts";

export type HostDockerMetadata = {
  /** Docker CLI version (`docker --version`), e.g. `"28.3.3"`. */
  version?: string;
  /** Compose plugin version (`docker compose version`), e.g. `"2.39.1"`. */
  composeVersion?: string;
};

const DOCKER_BIN = "/usr/bin/docker";
const VERSION_MAX_CHARS = 64;
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    // Deno 2 may block some paths under scoped --allow-read; fall back to test.
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

function spawnText(cmd: string, args: string[]): string | undefined {
  try {
    const { code, stdout } = new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}

function sanitizeVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let trimmed = value.trim();
  if (trimmed.startsWith("v") || trimmed.startsWith("V")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.length === 0 || trimmed.length > VERSION_MAX_CHARS) {
    return undefined;
  }
  if (!VERSION_TOKEN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Parse `docker --version` (`Docker version 28.3.3, build …`) or a bare token.
 * Exported for fixture tests.
 */
export function parseDockerCliVersion(text: string): string | undefined {
  const trimmed = text.trim();
  const direct = sanitizeVersion(trimmed);
  if (direct) return direct;
  const match = /^Docker version\s+(\S+?)(?:,|$)/i.exec(trimmed);
  return sanitizeVersion(match?.[1]);
}

/**
 * Parse `docker compose version --short` (`2.39.1`) or the long banner.
 * Exported for fixture tests.
 */
export function parseComposeVersion(text: string): string | undefined {
  const trimmed = text.trim();
  const direct = sanitizeVersion(trimmed);
  if (direct) return direct;
  const match = /version\s+v?(\S+)/i.exec(trimmed);
  return sanitizeVersion(match?.[1]);
}

/** Build the docker metadata area only when at least one version is present. */
export function hostDockerFromVersions(
  dockerVersion: string | undefined,
  composeVersion: string | undefined,
): HostDockerMetadata | undefined {
  const docker: HostDockerMetadata = {};
  if (dockerVersion) docker.version = dockerVersion;
  if (composeVersion) docker.composeVersion = composeVersion;
  return Object.keys(docker).length > 0 ? docker : undefined;
}

function probeComposeVersion(bin: string): string | undefined {
  const short = spawnText(bin, ["compose", "version", "--short"]);
  if (short) {
    const parsed = parseComposeVersion(short);
    if (parsed) return parsed;
  }
  const full = spawnText(bin, ["compose", "version"]);
  if (!full) return undefined;
  return parseComposeVersion(full);
}

/**
 * Sanitize an Engine `/info` DockerRootDir value: one absolute path, no
 * whitespace/control characters. Exported for fixture tests.
 */
export function parseDockerDataRoot(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  if (/[\s\p{Cc}]/u.test(trimmed)) return undefined;
  return trimmed;
}

/** `/info` seam so tests never need a live Docker socket. */
export type DockerInfoReader = {
  info: () => Promise<DockerInfo>;
};

/**
 * Resolve the Docker data root via the Docker Engine API (`GET /info`,
 * `DockerRootDir`) over the Unix socket — no `docker` CLI subprocess.
 *
 * Consumers probe this path's filesystem capacity — that reports capacity on
 * the filesystem backing TurboPanel Docker volumes, not per-volume quotas.
 * Returns `undefined` when the Docker daemon is unreachable. Metrics wiring
 * caches a successful result and bounds re-probes after failure — never once
 * per interval.
 */
export async function resolveDockerDataRoot(
  client?: DockerInfoReader,
): Promise<string | undefined> {
  let owned: DockerClient | undefined;
  try {
    const engine = client ?? (owned = new DockerClient());
    const info = await engine.info();
    if (typeof info.DockerRootDir !== "string") return undefined;
    return parseDockerDataRoot(info.DockerRootDir);
  } catch {
    return undefined;
  } finally {
    owned?.close();
  }
}

/**
 * Probe the host Docker CLI. Returns `undefined` when `/usr/bin/docker` is
 * missing or neither `docker --version` nor `docker compose version` can be
 * parsed — callers must omit the wire field rather than send an empty object.
 */
export function readDocker(
  dockerBin: string = DOCKER_BIN,
): HostDockerMetadata | undefined {
  if (!pathExists(dockerBin)) return undefined;
  const cliText = spawnText(dockerBin, ["--version"]);
  const version = cliText ? parseDockerCliVersion(cliText) : undefined;
  return hostDockerFromVersions(version, probeComposeVersion(dockerBin));
}
