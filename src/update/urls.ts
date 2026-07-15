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

export function rootCatalogUrl(base = DL_BASE_URL): string {
  return joinPath(base, "/channels.json");
}
