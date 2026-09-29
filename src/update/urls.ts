import { InsecureOverlayBaseError } from "./errors.ts";
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

/**
 * A version token safe to place in one GitHub release path segment.
 * The tag is `v<version>`, so the token itself starts with a digit.
 */
const PINNED_VERSION_RE = /^\d[0-9A-Za-z._+-]*$/;

/**
 * Manifest URL for one published build, beside {@link builtinChannelManifestUrl}.
 *
 * `canary` keeps `manifest-<version>.json` on the rolling `canary` release
 * (gh-canary.yml). `rc` and `release` use the tag `v<version>` and
 * `manifest.json` (gh-release.yml). `trunk` and `edge` have no pin.
 * Mirrored in scripts/run.sh (`tp_pinned_channel_manifest_url`).
 */
export function pinnedChannelManifestUrl(
  kind: ReleaseArtifactKind,
  channel: UpdateChannel,
  version: string,
): string | null {
  if (!PINNED_VERSION_RE.test(version)) return null;
  const repo = githubReleasesRepo(kind);
  switch (channel) {
    case "canary":
      return `https://github.com/${repo}/releases/download/canary/manifest-${version}.json`;
    case "rc":
    case "release":
      return `https://github.com/${repo}/releases/download/v${version}/manifest.json`;
    default:
      return null;
  }
}

/**
 * Every character a release-rail manifest URL may carry after `https://`.
 * No `%` (no percent-encoded dot segments or slashes), no `@` / `:` (no
 * userinfo, no port), no `?` / `#`, no `\`, no whitespace or controls.
 */
const RELEASE_MANIFEST_URL_CHARS = /^[A-Za-z0-9._~/+-]+$/;
const RELEASE_MANIFEST_FILE = /^manifest(?:-[A-Za-z0-9._~+-]+)?\.json$/;
const RELEASE_CDN_HOST = new URL(DL_BASE_URL).host;

/**
 * Whether `url` names a manifest on the release rail for `kind`, checked on
 * the raw string before anything parses or normalises it:
 *
 * - daemon: `https://dl.trbp.nl/channels/<channel>/manifest*.json`, or the
 *   turbopaneld GitHub rail;
 * - every kind: `https://github.com/TurboPanel/<repo>/releases/download/<tag>/manifest*.json`
 *   or `…/releases/latest/download/manifest*.json`, `<repo>` fixed by kind.
 *
 * Exact host, no empty / `.` / `..` segment, closed character set. A URL
 * that a client would normalise onto another path can therefore never match.
 * scripts/run.sh and orchestration/scripts/tp-orchestrate carry the same
 * rule as `tp_release_manifest_url_ok`; src/testing/release-manifest-url-corpus.json
 * pins all three together.
 */
export function releaseManifestUrlAllowed(kind: string, url: string): boolean {
  if (kind !== "daemon" && kind !== "instance" && kind !== "ui") return false;
  if (!url.startsWith("https://")) return false;
  const rest = url.slice("https://".length);
  if (!RELEASE_MANIFEST_URL_CHARS.test(rest)) return false;
  const slash = rest.indexOf("/");
  if (slash <= 0) return false;
  const host = rest.slice(0, slash);
  const segments = rest.slice(slash + 1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  if (!RELEASE_MANIFEST_FILE.test(segments[segments.length - 1])) return false;
  if (host === RELEASE_CDN_HOST) {
    return kind === "daemon" && segments.length === 3 &&
      segments[0] === "channels";
  }
  if (host !== "github.com" || segments.length !== 6) return false;
  const [owner, repo] = githubReleasesRepo(kind).split("/");
  if (
    segments[0] !== owner || segments[1] !== repo || segments[2] !== "releases"
  ) {
    return false;
  }
  return segments[3] === "download" ||
    (segments[3] === "latest" && segments[4] === "download");
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
 *
 * A pin off that kind's release rail ({@link releaseManifestUrlAllowed}) is
 * ignored, the same as an unset one.
 */
export function resolvePinnedManifestUrl(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  kind: ReleaseArtifactKind = "daemon",
): string | null {
  const pinned = env[pinnedManifestEnvName(kind)]?.trim();
  if (!pinned) return null;
  return releaseManifestUrlAllowed(kind, pinned) ? pinned : null;
}

/** `v<version>`: a release tag as gh-release.yml creates it. */
const RELEASE_TAG_RE = /^v[0-9][0-9A-Za-z._+-]*$/;
/** `manifest-<version>.json`: gh-canary.yml's per-build copy on the rolling release. */
const PER_BUILD_MANIFEST_FILE_RE = /^manifest-[0-9][0-9A-Za-z._+-]*\.json$/;

/**
 * Whether `url` names exactly one published build of `kind` — the shapes
 * {@link pinnedChannelManifestUrl} produces and the control plane sends for
 * an update run: a canary build's `…/releases/download/canary/manifest-<version>.json`
 * or a tag's `…/releases/download/v<version>/manifest.json`. A channel
 * pointer (`…/download/canary/manifest.json`, `…/latest/download/…`, the
 * CDN's `channels/<channel>/manifest.json`) floats and is not one build.
 */
export function isExactBuildManifestUrl(kind: string, url: string): boolean {
  if (!releaseManifestUrlAllowed(kind, url)) return false;
  const segments = url.slice("https://".length).split("/");
  // github.com/<owner>/<repo>/releases/download/<tag>/<file>
  if (segments.length !== 7 || segments[0] !== "github.com") return false;
  if (segments[4] !== "download") return false;
  const [tag, file] = [segments[5], segments[6]];
  if (tag === "canary") return PER_BUILD_MANIFEST_FILE_RE.test(file);
  return RELEASE_TAG_RE.test(tag) && file === "manifest.json";
}

/**
 * The manifest a control-plane-targeted update verifies and installs.
 *
 * A run that names one exact build ({@link isExactBuildManifestUrl}) wins
 * over the host pin. run.sh persists every `--manifest-url` it is handed into
 * daemon.env, so without this the first managed update left
 * `TURBOPANEL_MANIFEST_URL=<that build>` behind and every later run verified
 * the old build and failed `preflight_manifest` against its targetCommit —
 * the host froze. A floating message URL (a channel pointer) never replaces
 * a host pin: a panel click must not move a held host onto the channel.
 */
export function selectUpdateManifestUrl(
  kind: ReleaseArtifactKind,
  env: Record<string, string | undefined>,
  messageUrl: string | undefined,
): string | undefined {
  const requested = messageUrl?.trim() || undefined;
  if (requested && isExactBuildManifestUrl(kind, requested)) return requested;
  return resolvePinnedManifestUrl(env, kind) ?? requested;
}

/**
 * The overlay catalog origin when `TURBOPANEL_DL_BASE` is an https URL.
 * An absent or blank value is `null` (the built-in rail). A configured
 * value that is not https throws {@link InsecureOverlayBaseError} so the
 * resolver cannot treat it as "no overlay" and fetch the public catalog.
 * Setting `TURBOPANEL_DL_BASE=https://dl.trbp.nl` is the manual override
 * that forces the CDN catalog for every channel.
 */
export function resolveOverlayDlBase(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string | null {
  const override = env.TURBOPANEL_DL_BASE?.trim();
  if (!override) return null;
  const base = stripTrailingSlashes(override);
  let protocol = "";
  try {
    protocol = new URL(base).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "https:") {
    throw new InsecureOverlayBaseError(
      `TURBOPANEL_DL_BASE must be an https URL (configured value is not https). Daemon updates will not use the public catalog.`,
    );
  }
  return base;
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
