/**
 * Adds the managed database's CA file to a PostgreSQL connection URL on a PHP
 * site (feature `site-db-url-ca-v1`). Pure string work: the daemon knows where
 * the site's CA file lives, the control plane does not.
 */

const POSTGRES_SCHEMES = ["postgres://", "postgresql://"];
const VERIFY_MODES = new Set(["verify-ca", "verify-full"]);
const SAFE_PATH_CHAR = /[A-Za-z0-9/._-]/;

/** Percent-encodes every character outside `[A-Za-z0-9/._-]`. */
function encodeRootCertPath(path: string): string {
  let out = "";
  for (const char of path) {
    if (SAFE_PATH_CHAR.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function hasPostgresScheme(url: string): boolean {
  const lower = url.toLowerCase();
  return POSTGRES_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

type QueryFacts = { hasRootCert: boolean; verify: boolean };

function readQueryFacts(query: string): QueryFacts {
  const facts: QueryFacts = { hasRootCert: false, verify: false };
  for (const param of query === "" ? [] : query.split("&")) {
    const eq = param.indexOf("=");
    const key = eq === -1 ? param : param.slice(0, eq);
    const value = eq === -1 ? "" : param.slice(eq + 1);
    if (key === "sslrootcert") facts.hasRootCert = true;
    if (key === "sslmode" && VERIFY_MODES.has(value)) facts.verify = true;
  }
  return facts;
}

/** The text that joins a new parameter onto `base` (`?`, `&` or nothing). */
function querySeparator(queryAt: number, query: string): string {
  if (queryAt === -1) return "?";
  return query === "" || query.endsWith("&") ? "" : "&";
}

/**
 * Appends `sslrootcert=<path>` to a `postgres://` or `postgresql://` URL whose
 * `sslmode` is `verify-ca` or `verify-full` and that names no `sslrootcert`
 * yet. Any other value is returned unchanged.
 */
export function withPostgresRootCert(url: string, path: string): string {
  if (!hasPostgresScheme(url)) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const queryAt = base.indexOf("?");
  const query = queryAt === -1 ? "" : base.slice(queryAt + 1);
  const facts = readQueryFacts(query);
  if (facts.hasRootCert || !facts.verify) return url;
  const separator = querySeparator(queryAt, query);
  return `${base}${separator}sslrootcert=${
    encodeRootCertPath(path)
  }${fragment}`;
}
