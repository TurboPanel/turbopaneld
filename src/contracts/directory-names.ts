/**
 * Folder name rules and the folder reference (daemon and control plane).
 * Mirrored in control plane `src/contracts/directory-names.ts`.
 *
 * Every name that becomes a directory under a site owner's tree has one rule
 * here: the owner's Linux user, the environment (scope), a service folder, a
 * volume folder and a project slug. The control plane validates what a person
 * types; the daemon and the root helper re-check the same four components
 * before touching a disk. The two copies are formatted differently, so the
 * files are not byte twins. Instead `layout-vectors.json` (identical in both
 * repos, compared byte for byte by `check:contract-drift`) carries the rules
 * as data and a table of valid and invalid examples. A test in each repo
 * proves this file agrees with that data, so a rule cannot change on one side
 * only.
 *
 * Plain functions with no imports: safe in the Workers bundle and in Deno.
 * Nothing here builds a path on the host. {@link folderHostPath} only joins
 * validated components onto a root the caller supplies.
 */

/** The scope that holds assets shared by every environment of one owner. */
export const COMMON_SCOPE = "common";

/** The site owner's Linux user. Lowercase only, up to 28 characters. */
export const OWNER_NAME_RE = /^[a-z_][a-z0-9_-]{0,27}$/;
export const OWNER_NAME_MAX_LENGTH = 28;

/** An environment name, which is also its folder name. */
export const ENVIRONMENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ENVIRONMENT_NAME_MAX_LENGTH = 32;

/** A service or volume folder name. Dots allowed so a domain can be the name. */
export const FOLDER_NAME_RE = /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/;
export const FOLDER_NAME_MAX_LENGTH = 63;

/** A project slug. It is never part of a path. */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PROJECT_SLUG_MAX_LENGTH = 40;

/** Any id that forms a path, unit name, file name or lock name: a lowercase canonical UUID. */
export const PATH_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A new database table name: one lowercase word, no hyphen, underscore or digit. */
export const TABLE_NAME_RE = /^[a-z]+$/;

/**
 * Names an environment may not take. The first five are the owner's own
 * folders; `base` is kept so no environment is confused with the project's
 * Base; the rest stay free so a future folder beside `home` and `tmp`
 * never needs a rename and old names cannot return with an old meaning.
 */
export const RESERVED_SCOPE_NAMES: readonly string[] =
  "common home tmp services volumes data sites backup backups logs cache run var etc bin root public releases current shared lost-found tmp-staging base"
    .split(
      " ",
    );

/** Owner names may not start with this (the TurboPanel service accounts). */
export const OWNER_RESERVED_PREFIXES: readonly string[] = ["tp", "systemd-"];
/** Owner names may not end with this (the old per-user group suffix). */
export const OWNER_RESERVED_SUFFIX = "-grp";

/** Longest slug the default name builder produces before a collision suffix. */
export const DEFAULT_NAME_CUT_LENGTH = 54;
export const DEFAULT_NAME_HASH_LENGTH = 8;
export const COLLISION_SUFFIX_MIN = 2;
export const COLLISION_SUFFIX_MAX = 99;

const RESERVED_SCOPE_SET: ReadonlySet<string> = new Set(RESERVED_SCOPE_NAMES);

/** True for a lowercase canonical UUID. */
export function isPathId(value: unknown): boolean {
  return typeof value === "string" && PATH_ID_RE.test(value);
}

/** True for a name usable as a new table name (one lowercase word). */
export function isSingleWordTableName(value: unknown): boolean {
  return typeof value === "string" && TABLE_NAME_RE.test(value);
}

/**
 * Shape rule for a site owner's Linux user. The host's own account names
 * (root, daemon, admin and so on) are a separate list each repo already keeps;
 * a caller refuses those on top of this check.
 */
export function isValidOwnerName(value: unknown): boolean {
  if (typeof value !== "string" || !OWNER_NAME_RE.test(value)) return false;
  if (value.endsWith("-") || value.includes("--")) return false;
  if (OWNER_RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return false;
  }
  return !value.endsWith(OWNER_RESERVED_SUFFIX);
}

/** True when the name is on the reserved scope list (`common` included). */
export function isReservedScopeName(value: string): boolean {
  return RESERVED_SCOPE_SET.has(value);
}

/** An environment name: the rule and not reserved. `common` is not an environment. */
export function isValidEnvironmentName(value: unknown): boolean {
  return typeof value === "string" && ENVIRONMENT_NAME_RE.test(value) &&
    !isReservedScopeName(value);
}

/** A scope folder: `common` or a valid environment name. */
export function isValidScope(value: unknown): boolean {
  return value === COMMON_SCOPE || isValidEnvironmentName(value);
}

/** A service or volume folder name: the rule, and never `..` inside it. */
export function isValidFolderName(value: unknown): boolean {
  return typeof value === "string" && FOLDER_NAME_RE.test(value) &&
    !value.includes("..");
}

/** A project slug. */
export function isValidProjectSlug(value: unknown): boolean {
  return typeof value === "string" && PROJECT_SLUG_RE.test(value);
}

export type FolderKind = "service" | "volume";

/** The four components that name one asset folder. The control plane sends these, never a path. */
export type FolderRef = {
  owner: string;
  scope: string;
  kind: FolderKind;
  slug: string;
};

/** A folder reference whose kind is fixed by where it sits on the wire. */
export type FolderRefParts = {
  owner: string;
  scope: string;
  slug: string;
};

const FOLDER_REF_KEYS: readonly string[] = ["owner", "scope", "kind", "slug"];
const FOLDER_PARTS_KEYS: readonly string[] = ["owner", "scope", "slug"];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkFolderParts(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`Unknown folder reference field ${key}`);
    }
  }
  if (!isValidOwnerName(value.owner)) {
    throw new TypeError("Invalid folder reference owner");
  }
  if (!isValidScope(value.scope)) {
    throw new TypeError("Invalid folder reference scope");
  }
  if (!isValidFolderName(value.slug)) {
    throw new TypeError("Invalid folder reference slug");
  }
}

/** Validate a full folder reference. Throws a TypeError naming the bad part. */
export function parseFolderRef(value: unknown): FolderRef {
  if (!isPlainRecord(value)) throw new TypeError("Invalid folder reference");
  checkFolderParts(value, FOLDER_REF_KEYS);
  if (value.kind !== "service" && value.kind !== "volume") {
    throw new TypeError("Invalid folder reference kind");
  }
  return {
    owner: value.owner as string,
    scope: value.scope as string,
    kind: value.kind,
    slug: value.slug as string,
  };
}

/** Validate the wire form without `kind`, and attach the kind that its position implies. */
export function parseFolderRefParts(
  value: unknown,
  kind: FolderKind,
): FolderRef {
  if (!isPlainRecord(value)) throw new TypeError("Invalid folder reference");
  checkFolderParts(value, FOLDER_PARTS_KEYS);
  return {
    owner: value.owner as string,
    scope: value.scope as string,
    kind,
    slug: value.slug as string,
  };
}

/** The wire form of a reference, without `kind`. */
export function folderRefParts(ref: FolderRef): FolderRefParts {
  return { owner: ref.owner, scope: ref.scope, slug: ref.slug };
}

/** The path an owner sees over SFTP (the jail root is `/`): `/{scope}/{services|volumes}/{slug}`. */
export function folderJailPath(ref: FolderRef): string {
  return `/${ref.scope}/${
    ref.kind === "service" ? "services" : "volumes"
  }/${ref.slug}`;
}

/**
 * The host path under a root such as `/srv/users`: `{root}/{owner}` followed by the jail path.
 * The root is the caller's own value (the daemon reads it from its layout); it must be absolute
 * and have no trailing slash. The reference is re-validated here.
 */
export function folderHostPath(root: string, ref: FolderRef): string {
  if (!root.startsWith("/") || root.length < 2 || root.endsWith("/")) {
    throw new TypeError("Invalid folder root");
  }
  const checked = parseFolderRef(ref);
  return `${root}/${checked.owner}${folderJailPath(checked)}`;
}

// -- Default folder names ---------------------------------------------------

const SHA256_K = [
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Block(h: number[], w: number[]): void {
  for (let i = 16; i < 64; i += 1) {
    const s0 = rotateRight(w[i - 15], 7) ^ rotateRight(w[i - 15], 18) ^
      (w[i - 15] >>> 3);
    const s1 = rotateRight(w[i - 2], 17) ^ rotateRight(w[i - 2], 19) ^
      (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, hh] = h;
  for (let i = 0; i < 64; i += 1) {
    const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
    const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  const next = [a, b, c, d, e, f, g, hh];
  for (let i = 0; i < 8; i += 1) h[i] = (h[i] + next[i]) >>> 0;
}

/** SHA-256 of an ASCII or UTF-8 string, as lowercase hex. Synchronous so a form can use it. */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6) as number);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(
    padded.length - 8,
    Math.floor((data.length * 8) / 0x100000000),
  );
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const h = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ];
  const w = new Array<number>(64).fill(0);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(offset + i * 4);
    sha256Block(h, w);
  }
  return h.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * The ASCII (Punycode) spelling of a domain as typed, lowercased, with a leading `*.` kept.
 * Trims spaces and one trailing dot, normalises to NFC, converts each label (`bücher` becomes
 * `xn--bcher-kva`). Returns null for anything that is not a plain domain: empty, an address,
 * a label that cannot be converted, or a character that does not belong in a host name.
 */
export function domainToAscii(input: string): string | null {
  let text = input.trim().normalize("NFC");
  if (text.endsWith(".")) text = text.slice(0, -1);
  const wildcard = text.startsWith("*.");
  const rest = wildcard ? text.slice(2) : text;
  if (rest.length === 0 || /[\s/?#@:\\%*[\]]/.test(rest)) return null;
  const labels = rest.split(".");
  if (labels.some((label) => label.length === 0)) return null;
  // A final all-digit label reads as an address, not a name.
  if (/^\d+$/.test(labels.at(-1) ?? "")) return null;
  let host: string;
  try {
    host = new URL(`http://${rest}`).hostname;
  } catch {
    return null;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.split(".").some((label) => label.length === 0)) return null;
  // The URL parser also reads 0x7f.1 and 2130706433 as addresses; refuse any result that is one.
  if (host.length === 0 || host.length > 253 || /^\d+(\.\d+){3}$/.test(host)) {
    return null;
  }
  return (wildcard ? "*." : "") + host.toLowerCase();
}

function trimEdgeSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && ".-_".includes(value[start])) start += 1;
  while (end > start && ".-_".includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/**
 * The default folder name for a web hosting service made from its primary domain, before any
 * collision suffix. Returns null when the input is not a domain.
 *
 * 1. {@link domainToAscii} (Punycode, lowercase, `*.` kept).
 * 2. A leading `*.` becomes `wildcard.`.
 * 3. A result that already fits the folder rule is the name.
 * 4. Otherwise (longer than 63, or a character outside the rule): drop characters outside
 *    `a-z 0-9 . _ -`, collapse runs of dots, keep the first 54, trim `. - _` from both ends, then
 *    append `-` and the first 8 hex characters of the SHA-256 of the full ASCII domain as typed
 *    (with `*.` still in place). An empty remainder leaves the 8 hash characters alone.
 */
export function defaultFolderNameFromDomain(input: string): string | null {
  const ascii = domainToAscii(input);
  if (ascii === null) return null;
  const named = ascii.startsWith("*.") ? `wildcard.${ascii.slice(2)}` : ascii;
  if (isValidFolderName(named)) return named;
  const cleaned = named.replace(/[^a-z0-9._-]/g, "").replace(/\.{2,}/g, ".");
  const base = trimEdgeSeparators(cleaned.slice(0, DEFAULT_NAME_CUT_LENGTH));
  const hash = sha256Hex(ascii).slice(0, DEFAULT_NAME_HASH_LENGTH);
  return base.length === 0 ? hash : `${base}-${hash}`;
}

/** `base` with `-n` appended, the base cut (and its end trimmed) so the whole name stays valid. */
export function withCollisionSuffix(base: string, n: number): string {
  if (
    !Number.isInteger(n) || n < COLLISION_SUFFIX_MIN || n > COLLISION_SUFFIX_MAX
  ) {
    throw new RangeError(
      "Collision suffix must be a whole number from 2 to 99",
    );
  }
  const suffix = `-${n}`;
  const room = FOLDER_NAME_MAX_LENGTH - suffix.length;
  const cut = base.length > room
    ? trimEdgeSeparators(base.slice(0, room))
    : base;
  return `${cut}${suffix}`;
}

/**
 * The first free name for a defaulted folder: the base, then `-2` up to `-99`. Returns null when
 * every one is taken (the create then fails with a conflict and the owner types a name). A name
 * the owner typed is never suffixed; call this only for defaults.
 */
export function firstFreeFolderName(
  base: string,
  isTaken: (name: string) => boolean,
): string | null {
  if (!isTaken(base)) return base;
  for (let n = COLLISION_SUFFIX_MIN; n <= COLLISION_SUFFIX_MAX; n += 1) {
    const candidate = withCollisionSuffix(base, n);
    if (!isTaken(candidate)) return candidate;
  }
  return null;
}
