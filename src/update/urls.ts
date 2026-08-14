export const DL_BASE_URL = "https://dl.trbp.nl";

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
