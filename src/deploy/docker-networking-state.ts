/**
 * Locally persisted Docker host addressing (`<configDir>/docker/networking.json`).
 *
 * The daemon pulls the org's dockerd `default-address-pools` / `bip` once per
 * session over `GET /api/daemon/v1/host/docker-networking` and keeps the last
 * applied copy here so:
 *
 * - an on-demand Docker install (`ensureDocker` → `runDockerSetup()` with no
 *   options) lands with the right pools without another round-trip;
 * - the apply step is skipped when nothing changed — every apply that
 *   rewrites `daemon.json` restarts dockerd, so "unchanged" must be cheap and
 *   certain;
 * - a non-empty → empty transition is detectable, so the sync can tell the
 *   docker role to strip the keys it wrote earlier rather than skipping.
 *
 * Shape mirrors `readSystemComponentDescriptor` / `writeSystemComponentDescriptor`
 * in `system-component.ts`: temp-file + rename, `0640` / `0750`, corrupt
 * file → warn and treat as absent.
 */

import { join } from "@std/path";
import { logWarn } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";

export type DockerNetworkingDescriptor = {
  addressPools: Array<{ base: string; size: number }>;
  defaultBridgeCidr: string | null;
};

const CIDR_LITERAL_RE = /^[0-9A-Fa-f:.]+\/\d{1,3}$/;

export function dockerNetworkingStatePath(
  layout: Pick<LayoutPaths, "configDir">,
): string {
  return join(layout.configDir, "docker", "networking.json");
}

export function isValidDockerNetworkingDescriptor(
  value: unknown,
): value is DockerNetworkingDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.addressPools)) return false;
  for (const entry of record.addressPools) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const pool = entry as Record<string, unknown>;
    if (typeof pool.base !== "string" || !CIDR_LITERAL_RE.test(pool.base)) {
      return false;
    }
    if (typeof pool.size !== "number" || !Number.isInteger(pool.size)) {
      return false;
    }
  }
  if (
    record.defaultBridgeCidr !== null &&
    (typeof record.defaultBridgeCidr !== "string" ||
      !CIDR_LITERAL_RE.test(record.defaultBridgeCidr))
  ) {
    return false;
  }
  return true;
}

/** Canonical form so two descriptors compare by content, not key order. */
export function normalizeDockerNetworkingDescriptor(
  value: DockerNetworkingDescriptor,
): DockerNetworkingDescriptor {
  return {
    addressPools: value.addressPools.map((pool) => ({
      base: pool.base,
      size: pool.size,
    })),
    defaultBridgeCidr: value.defaultBridgeCidr ?? null,
  };
}

export function dockerNetworkingDescriptorsEqual(
  a: DockerNetworkingDescriptor | null,
  b: DockerNetworkingDescriptor | null,
): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(normalizeDockerNetworkingDescriptor(a)) ===
    JSON.stringify(normalizeDockerNetworkingDescriptor(b));
}

/** True when the descriptor carries nothing dockerd would need to apply. */
export function isEmptyDockerNetworkingDescriptor(
  value: DockerNetworkingDescriptor | null,
): boolean {
  return value === null ||
    (value.addressPools.length === 0 && value.defaultBridgeCidr === null);
}

/**
 * Read the persisted descriptor. Missing → `null`. A corrupt file is logged
 * and treated as absent so a bad write can never wedge the daemon session —
 * the next successful fetch simply overwrites it.
 */
export async function readDockerNetworkingState(
  layout: Pick<LayoutPaths, "configDir">,
): Promise<DockerNetworkingDescriptor | null> {
  const filePath = dockerNetworkingStatePath(layout);
  let contents: string;
  try {
    contents = await Deno.readTextFile(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    logWarn("deploy", `docker networking state unreadable (${filePath}):`, err);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    logWarn(
      "deploy",
      `docker networking state is not JSON (${filePath}); ignoring`,
    );
    return null;
  }
  if (!isValidDockerNetworkingDescriptor(parsed)) {
    logWarn(
      "deploy",
      `docker networking state is malformed (${filePath}); ignoring`,
    );
    return null;
  }
  return normalizeDockerNetworkingDescriptor(parsed);
}

export async function writeDockerNetworkingState(
  layout: Pick<LayoutPaths, "configDir">,
  descriptor: DockerNetworkingDescriptor,
): Promise<void> {
  const filePath = dockerNetworkingStatePath(layout);
  const dir = join(layout.configDir, "docker");
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(
    tmpPath,
    JSON.stringify(normalizeDockerNetworkingDescriptor(descriptor)),
    { mode: 0o640 },
  );
  try {
    const written: unknown = JSON.parse(await Deno.readTextFile(tmpPath));
    if (!isValidDockerNetworkingDescriptor(written)) {
      throw new Error(
        `docker networking state ${filePath} failed validation before commit`,
      );
    }
    await Deno.rename(tmpPath, filePath);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    throw err;
  }
}
