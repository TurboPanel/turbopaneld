import type { UpdateChannel } from "./types.ts";

export const DL_BASE_URL = "https://dl.trbp.nl";

/** The repository whose GitHub Releases carry the daemon's canary/rc/release packages. */
export const GITHUB_RELEASES_REPO = "TurboPanel/turbopaneld";

/** Control-plane packages (compiled instance). GitHub Releases only — no CDN drop. */
export const INSTANCE_GITHUB_RELEASES_REPO = "TurboPanel/turbopanel";

/** Web export packages. GitHub Releases only — no CDN drop. */
export const UI_GITHUB_RELEASES_REPO = "TurboPanel/ui";

export const RELEASE_ARTIFACT_KINDS = ["daemon", "instance", "ui"] as const;

export type ReleaseArtifactKind = (typeof RELEASE_ARTIFACT_KINDS)[number];

export function githubReleasesRepo(
  kind: ReleaseArtifactKind = "daemon",
): string {
  switch (kind) {
    case "instance":
      return INSTANCE_GITHUB_RELEASES_REPO;
    case "ui":
      return UI_GITHUB_RELEASES_REPO;
    case "daemon":
      return GITHUB_RELEASES_REPO;
  }
}

/**
 * Where each advertised channel's manifest lives when no overlay catalog
 * (`TURBOPANEL_DL_BASE`) is configured — the built-in rail.
 *
 * `trunk` is the per-merge CDN drop. `canary`, `rc` and `release` are GitHub
 * Releases: `release` follows the platform's own `releases/latest` pointer
 * (which skips pre-releases, so promotion is `gh release edit
 * --prerelease=false` and nothing here moves); `rc` follows a rolling
 * pre-release tagged `rc` whose manifest points at a versioned pre-release;
 * `canary` follows a rolling pre-release tagged `canary` that carries the
 * newest green trunk build's own bytes, replaced on every merge
 * (publish-daemon-trunk.yml → TurboPanel/dev gh-canary.yml). All three are
 * redirects GitHub serves without touching the unauthenticated API limit.
 * `edge` is reserved and unadvertised: no built-in location, so a daemon
 * following it needs an overlay catalog that names it.
 *
 * Mirrored by hand in scripts/run.sh (`tp_builtin_channel_manifest_url`) and
 * the control plane's src/contracts/update-channel.ts — keep the three in step;
 * urls.test.ts pins run.sh's copy against this one.
 *
 * `kind` selects the package. Daemon `trunk` stays
 * `channels/trunk/manifest.json` (the CDN drop). Instance and UI have no CDN
 * drop, so their `trunk` (and every kind's `edge`) is `null` — canary, rc,
 * and release are GitHub Releases for that repository. The default kind is
 * `daemon` so existing call sites stay on the daemon rail.
 */
export function builtinChannelManifestUrl(
  channel: UpdateChannel,
  kind: ReleaseArtifactKind = "daemon",
): string | null {
  const repo = githubReleasesRepo(kind);
  switch (channel) {
    case "trunk":
      return trunkManifestUrl(kind);
    case "canary":
      return `https://github.com/${repo}/releases/download/canary/manifest.json`;
    case "rc":
      return `https://github.com/${repo}/releases/download/rc/manifest.json`;
    case "release":
      return `https://github.com/${repo}/releases/latest/download/manifest.json`;
    default:
      return null;
  }
}

function trunkManifestUrl(kind: ReleaseArtifactKind): string | null {
  if (kind !== "daemon") return null;
  return `${DL_BASE_URL}/channels/trunk/manifest.json`;
}

/** Env var that pins one artifact kind to an exact manifest. Independent per kind. */
export function pinnedManifestEnvName(
  kind: ReleaseArtifactKind = "daemon",
): string {
  switch (kind) {
    case "instance":
      return "TURBOPANEL_INSTANCE_MANIFEST_URL";
    case "ui":
      return "TURBOPANEL_UI_MANIFEST_URL";
    case "daemon":
      return "TURBOPANEL_MANIFEST_URL";
  }
}

/** Strip all trailing `/` without a backtracking regex. */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.codePointAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === path.length ? path : path.slice(0, end);
}

function joinPath(base: string, path: string): string {
  const normalizedBase = stripTrailingSlashes(base);
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalized}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Artifact catalog origin: local overlay (`TURBOPANEL_DL_BASE`) or the public CDN. */
export function resolveDlBase(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_DL_BASE?.trim();
  if (override) return stripTrailingSlashes(override);
  return DL_BASE_URL;
}

/**
 * A pinned manifest: one exact release manifest, typically a tag's
 * releases/download/vX.Y.Z/manifest.json, that wins over the channel's
 * current pointer so a host can be held on (or rolled back to) a specific
 * release while the channel moves on. https only; `null` when unset.
 *
 * The daemon pin is `TURBOPANEL_MANIFEST_URL` (`run.sh --manifest-url`).
 * The control plane and the UI have their own pins
 * (`TURBOPANEL_INSTANCE_MANIFEST_URL`, `TURBOPANEL_UI_MANIFEST_URL`) so a
 * canary host can hold each package on a different build.
 */
export function resolvePinnedManifestUrl(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  kind: ReleaseArtifactKind = "daemon",
): string | null {
  const pinned = env[pinnedManifestEnvName(kind)]?.trim();
  if (!pinned) return null;
  try {
    return new URL(pinned).protocol === "https:" ? pinned : null;
  } catch {
    return null;
  }
}

/**
 * The overlay catalog origin when one is configured, else `null` — the
 * resolver reads `<origin>/channels.json` in that case and the built-in
 * per-channel rail otherwise. Setting `TURBOPANEL_DL_BASE=https://dl.trbp.nl`
 * is the manual override that forces the CDN catalog for every channel.
 */
export function resolveOverlayDlBase(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | null {
  const override = env.TURBOPANEL_DL_BASE?.trim();
  return override ? stripTrailingSlashes(override) : null;
}

export function rootCatalogUrl(base = DL_BASE_URL): string {
  return joinPath(base, "/channels.json");
}

/** Resolve a catalog/manifest URL that may be relative to `baseUrl`. */
export function resolveMaybeRelativeUrl(
  baseUrl: string,
  value: string,
): string {
  return new URL(value, baseUrl).href;
}

export function catalogAllowsHttp(catalogUrl: string): boolean {
  try {
    return new URL(catalogUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/** Rewrite `channels[].manifestUrl` to absolute URLs against the catalog fetch URL. */
export function absolutizeRootCatalogJson(
  raw: unknown,
  catalogUrl: string,
): unknown {
  if (!isRecord(raw) || !isRecord(raw.channels)) return raw;
  const channels: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw.channels)) {
    if (!isRecord(entry) || typeof entry.manifestUrl !== "string") {
      channels[name] = entry;
      continue;
    }
    channels[name] = {
      ...entry,
      manifestUrl: resolveMaybeRelativeUrl(catalogUrl, entry.manifestUrl),
    };
  }
  return { ...raw, channels };
}

function rewriteArtifactEntry(entry: unknown, baseUrl: string): unknown {
  if (!isRecord(entry) || typeof entry.url !== "string") return entry;
  return { ...entry, url: resolveMaybeRelativeUrl(baseUrl, entry.url) };
}

/** Rewrite artifact `url` fields to absolute URLs against the manifest fetch URL. */
export function absolutizeChannelManifestJson(
  raw: unknown,
  manifestUrl: string,
): unknown {
  if (!isRecord(raw)) return raw;
  const binary = isRecord(raw.binaryArtifacts) ? raw.binaryArtifacts : null;
  return {
    ...raw,
    binaryArtifacts: binary
      ? {
        ...binary,
        "linux-amd64": rewriteArtifactEntry(binary["linux-amd64"], manifestUrl),
        "linux-arm64": rewriteArtifactEntry(binary["linux-arm64"], manifestUrl),
      }
      : raw.binaryArtifacts,
    jsFallbackArtifact: rewriteArtifactEntry(
      raw.jsFallbackArtifact,
      manifestUrl,
    ),
    orchestrationArtifact: rewriteArtifactEntry(
      raw.orchestrationArtifact,
      manifestUrl,
    ),
  };
}
