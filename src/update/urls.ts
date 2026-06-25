export const DL_BASE_URL = "https://dl.trbp.nl";

function joinPath(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalized}`;
}

export function rootCatalogUrl(base = DL_BASE_URL): string {
  return joinPath(base, "/channels.json");
}

export function channelManifestUrl(
  manifestPath: string,
  base = DL_BASE_URL,
): string {
  return joinPath(base, manifestPath);
}

export function artifactUrl(artifactPath: string, base = DL_BASE_URL): string {
  return joinPath(base, artifactPath);
}
