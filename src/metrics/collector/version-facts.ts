/**
 * Slow-changing version facts: Docker, the hosting Caddy, the shared hosting
 * Traefik and the managed database engines. None of them is read per tick: one
 * cached poll every half hour, like the TLS expiry and Docker usage samplers.
 *
 * Nothing here spawns a process. Docker answers `GET /version` over its
 * socket; the Traefik and database versions are the image tags of the
 * containers the daemon itself created (read from the same container list);
 * the Caddy version is the name of the vendored directory `caddy/current`
 * points at (the daemon installs it as `caddy/<version>`).
 */
import { basename } from "@std/path";
import { LABEL_SYSTEM_COMPONENT } from "../../deploy/labels.ts";
import { SYSTEM_HOSTING_INGRESS_COMPONENT } from "../../deploy/system-component.ts";
import type { ContainerSummary } from "../../docker/client.ts";
import { MANAGED_ENGINE_LABEL } from "./managed-engines.ts";

export const VERSION_FACTS_POLL_INTERVAL_MS = 30 * 60_000;

const MAX_DB_ENGINES = 6;
const VERSION_RE = /^\d[\w.+-]{0,31}$/;
const ENGINE_CODE_RE = /^[a-z][a-z0-9_-]{0,23}$/;

export type VersionFacts = {
  dockerVersion?: string;
  caddyVersion?: string;
  traefikVersion?: string;
  /** `engine version` pairs, comma-joined: `mariadb 11.4,postgres 18`. */
  dbVersions?: string;
};

/**
 * The version in an image reference's tag (`traefik:v3.6.6` is `3.6.6`).
 * `undefined` for an untagged, `latest` or digest-only reference, or a tag
 * that does not start with a digit.
 */
export function imageVersion(image: string | undefined): string | undefined {
  const reference = (image ?? "").split("@")[0];
  const tag = reference.slice(reference.lastIndexOf("/") + 1).split(":")[1];
  const version = tag?.replace(/^v(?=\d)/, "");
  return version !== undefined && VERSION_RE.test(version)
    ? version
    : undefined;
}

function repository(image: string): string {
  const name = image.split("@")[0].split(":")[0];
  return name.slice(name.lastIndexOf("/") + 1);
}

/** The shared hosting Traefik's version: its container is the one labelled `hosting-ingress`. */
export function traefikVersionOf(
  containers: readonly ContainerSummary[],
): string | undefined {
  for (const container of containers) {
    const component = container.Labels?.[LABEL_SYSTEM_COMPONENT];
    if (
      component === SYSTEM_HOSTING_INGRESS_COMPONENT &&
      repository(container.Image) === "traefik"
    ) {
      const version = imageVersion(container.Image);
      if (version) return version;
    }
  }
  return undefined;
}

/** `engine version` for each managed engine that has a container, sorted, one entry per pair. */
export function dbVersionsOf(
  containers: readonly ContainerSummary[],
): string | undefined {
  const pairs = new Set<string>();
  for (const container of containers) {
    const engine = container.Labels?.[MANAGED_ENGINE_LABEL];
    const version = imageVersion(container.Image);
    if (engine !== undefined && ENGINE_CODE_RE.test(engine) && version) {
      pairs.add(`${engine} ${version}`);
    }
  }
  return pairs.size === 0
    ? undefined
    : [...pairs].sort().slice(0, MAX_DB_ENGINES).join(",");
}

/** `2.11.4` from the vendored directory name `…/caddy/2.11.4`; `undefined` for anything else. */
export function caddyVersionFromDirectory(path: string): string | undefined {
  const name = basename(path);
  return /^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(name) ? name : undefined;
}

export type VersionFactsDeps = {
  dockerVersion: () => Promise<string | undefined>;
  listContainers: () => Promise<readonly ContainerSummary[]>;
  /** Resolved target directory of the vendored `caddy/current` link. */
  caddyDirectory: () => Promise<string | undefined>;
  intervalMs?: number;
};

/**
 * Owns the slow timer and the cached facts. Each source is polled on its own:
 * one that fails keeps its last good value, so a stopped Docker does not erase
 * the versions already known.
 */
export class VersionFactsSampler {
  readonly #deps: VersionFactsDeps;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #latest: VersionFacts | null = null;

  constructor(deps: VersionFactsDeps) {
    this.#deps = deps;
  }

  latest(): VersionFacts | null {
    return this.#latest;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.refresh();
    this.#timer = setInterval(
      () => void this.refresh(),
      this.#deps.intervalMs ?? VERSION_FACTS_POLL_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One poll now; dropped while another is in flight. */
  async refresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const [dockerVersion, containers, caddyDirectory] = await Promise.all([
        settle(this.#deps.dockerVersion()),
        settle(this.#deps.listContainers()),
        settle(this.#deps.caddyDirectory()),
      ]);
      const next: VersionFacts = { ...this.#latest };
      if (dockerVersion) next.dockerVersion = dockerVersion;
      const caddy = caddyDirectory
        ? caddyVersionFromDirectory(caddyDirectory)
        : undefined;
      if (caddy) next.caddyVersion = caddy;
      if (containers) {
        setOrClear(next, "traefikVersion", traefikVersionOf(containers));
        setOrClear(next, "dbVersions", dbVersionsOf(containers));
      }
      this.#latest = Object.keys(next).length > 0 ? next : null;
    } finally {
      this.#running = false;
    }
  }
}

/** A readable container list is authoritative: engines that are gone stop being reported. */
function setOrClear(
  facts: VersionFacts,
  key: "traefikVersion" | "dbVersions",
  value: string | undefined,
): void {
  if (value === undefined) delete facts[key];
  else facts[key] = value;
}

async function settle<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}
