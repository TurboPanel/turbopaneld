#!/usr/bin/env -S deno run --allow-read
/**
 * Cross-repo contract drift check (daemon side).
 *
 * Mirrors `turbopanel/scripts/check-contract-drift.mjs`. Missing sibling
 * `../turbopanel` → skip (exit 0). Dual-checkout CI (turbopanel
 * `contract-twin` job) runs the Node twin; this task covers a co-located
 * daemon workspace.
 *
 * The expand-only snapshot pins a normalized type signature per field. A
 * committed field may not be removed or narrowed. A wider live type passes
 * only when that pin sets `expansion: true`.
 *
 * Daemon first. A wire change merges into the daemon's trunk before the
 * control plane's, and each side is checked against the other repository's
 * trunk (never another pull request's branch). So the rule is one-way:
 *
 *   - lists and maps (DAEMON_WIRE_FEATURES, DAEMON_FEATURE_MIN_VERSIONS,
 *     INSTANCE_FEATURE_MIN_VERSIONS, UPDATE_CHANNELS, the ServerReportedIp
 *     field names) and the field snapshot: every control plane entry must be
 *     in the daemon's, unchanged. The daemon may have more (a daemon-only
 *     snapshot field must be optional); old control planes ignore daemon
 *     features they do not know.
 *   - named constants both sides use (signed-session prefixes, proof tags,
 *     HOSTNAME_RE, HOSTNAME_MAX_LENGTH, MAX_NIC_SLOTS, the machine-key
 *     namespace, INSTANCE_VERSION_HEADER): a value the control plane has must
 *     equal this daemon's (a peer that disagrees rejects the other's bytes);
 *     a name only this daemon has yet is a notice.
 *   - whole-file mirrors (the metrics contract body, the key-set and folder
 *     name vectors) and FILESYSTEM_ROLE_PRIORITY: there is no "ahead" for
 *     bytes, so a mismatch (or a control plane copy that does not exist yet)
 *     is only a notice here. The control plane's twin goes red when its own
 *     pull request changes its copy to something other than daemon trunk's.
 *
 * Run: `deno task check:contract-drift`.
 */
import { fromFileUrl, join } from "@std/path";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const ROOT = stripTrailingSlash(fromFileUrl(new URL("..", import.meta.url)));
const SIBLING = join(ROOT, "..", "turbopanel");

function stripHeaderDocblock(source: string): string {
  const end = source.indexOf("*/");
  return end === -1 ? source : source.slice(end + 2);
}

function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") || ch === "_";
}

function isWord(value: string): boolean {
  if (!value) return false;
  for (const ch of value) {
    if (!isWordChar(ch)) return false;
  }
  return true;
}

function normalizeWs(value: string): string {
  let out = "";
  let inSpace = false;
  for (const ch of value.trim()) {
    const space = ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
    if (space) {
      inSpace = true;
      continue;
    }
    if (inSpace && out.length > 0) out += " ";
    inSpace = false;
    out += ch;
  }
  return out;
}

function quotedStrings(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const quote = source[i];
    if (quote !== "'" && quote !== '"') {
      i += 1;
      continue;
    }
    const end = source.indexOf(quote, i + 1);
    if (end === -1) break;
    const token = source.slice(i + 1, end);
    if (token.length > 0) out.push(token);
    i = end + 1;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function stripQuotes(value: string): string {
  return value.replaceAll("'", "").replaceAll('"', "");
}

function extractAfterEquals(source: string, marker: string): number | null {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const eq = source.indexOf("=", start + marker.length);
  if (eq === -1) return null;
  return eq + 1;
}

function extractConst(source: string, name: string): string | null {
  let from = extractAfterEquals(source, `export const ${name}`);
  if (from == null) return null;
  while (
    from < source.length &&
    (source[from] === " " || source[from] === "\t" || source[from] === "\n" ||
      source[from] === "\r")
  ) {
    from += 1;
  }
  let end = from;
  while (end < source.length && source[end] !== "\n" && source[end] !== ";") {
    end += 1;
  }
  const captured = source.slice(from, end).trim();
  if (!captured) return null;
  return stripQuotes(normalizeWs(captured));
}

function extractTypeFields(source: string, typeName: string): string[] | null {
  const from = extractAfterEquals(source, `export type ${typeName}`);
  if (from == null) return null;
  const open = source.indexOf("{", from);
  const close = source.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  const names: string[] = [];
  for (const line of source.slice(open + 1, close).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 1) continue;
    let name = trimmed.slice(0, colon);
    if (name.endsWith("?")) name = name.slice(0, -1);
    if (isWord(name)) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function extractArrayConst(source: string, name: string): string[] | null {
  const idx = source.indexOf(`const ${name}`);
  if (idx === -1) return null;
  const open = source.indexOf("[", idx);
  const close = source.indexOf("]", open);
  if (open === -1 || close === -1) return null;
  return quotedStrings(source.slice(open + 1, close));
}

function fail(message: string): never {
  console.error(`check-contract-drift: ${message}`);
  Deno.exit(1);
}

async function readRel(root: string, rel: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(join(root, rel));
  } catch {
    return null;
  }
}

function requireText(value: string | null, message: string): string {
  if (value == null) fail(message);
  return value;
}

/** A byte mirror that differs: the control plane has not caught up yet. */
function mirrorNotice(message: string): void {
  console.log(
    `::notice title=Contract mirror::${message}; the control plane has not caught up with this daemon yet`,
  );
}

function mirrorEqual(
  left: string | null,
  right: string | null,
  message: string,
): void {
  if (right == null) fail(message);
  if (left !== right) mirrorNotice(message);
}

/** The control plane's copy of a mirror, or null (with a notice) when it has none yet. */
async function mirrorSource(root: string, rel: string): Promise<string | null> {
  const text = await readRel(root, rel);
  if (text == null) mirrorNotice(`${rel} is not on the control plane yet`);
  return text;
}

/**
 * The entries of `instance` that `daemon` lacks. Daemon first: the daemon may
 * list more; the control plane may not rely on anything the daemon lacks.
 */
export function missingFromDaemon(
  instance: readonly string[],
  daemon: readonly string[],
): string[] {
  const have = new Set(daemon);
  return instance.filter((entry) => !have.has(entry));
}

function requireSubset(
  instance: string[] | null,
  daemon: string[] | null,
  what: string,
): void {
  if (instance == null || daemon == null) {
    fail(`${what} missing on one side of the pair`);
  }
  const missing = missingFromDaemon(instance, daemon);
  if (missing.length > 0) {
    fail(
      `${what}: the control plane relies on ${
        missing.join(", ")
      }, which this daemon does not have; merge the daemon change first`,
    );
  }
}

/** `{ a: 0.1.1, b: 0.2.0 }` (as extractObjectLiteral returns it) as [key, value] pairs. */
export function objectLiteralEntries(
  literal: string | null,
): [string, string][] | null {
  if (literal == null) return null;
  const body = literal.trim().replace(/^\{/, "").replace(/\}$/, "");
  const entries: [string, string][] = [];
  for (const part of body.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const colon = item.indexOf(":");
    if (colon < 1) return null;
    entries.push([item.slice(0, colon).trim(), item.slice(colon + 1).trim()]);
  }
  return entries;
}

/** Every control plane key must be in the daemon's map with the same value. */
export function mapDriftFromDaemon(
  instanceLiteral: string | null,
  daemonLiteral: string | null,
): string | null {
  const instance = objectLiteralEntries(instanceLiteral);
  const daemon = objectLiteralEntries(daemonLiteral);
  if (instance == null || daemon == null) {
    return "missing or not a plain object literal";
  }
  const byKey = new Map(daemon);
  for (const [key, value] of instance) {
    if (!byKey.has(key)) {
      return `${key} is not in this daemon's map; merge the daemon change first`;
    }
    if (byKey.get(key) !== value) {
      return `${key} is ${value} on the control plane but ${
        byKey.get(key)
      } here`;
    }
  }
  return null;
}

const PLAIN_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * A version floor is a plain X.Y.Z at or below the peer's current version.
 * Returns why it is not, or null when it is.
 */
export function floorWithinVersionDrift(
  floor: string | null,
  peerVersion: string | null,
  name: string,
): string | null {
  const f = PLAIN_SEMVER_RE.exec(floor ?? "");
  const v = PLAIN_SEMVER_RE.exec(peerVersion ?? "");
  if (!f) return `${name} must be a plain X.Y.Z (got ${floor})`;
  if (!v) {
    return `${name}: the peer deno.json version is not X.Y.Z (got ${peerVersion})`;
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(f[i]) - Number(v[i]);
    if (diff < 0) return null;
    if (diff > 0) {
      return `${name} ${floor} is newer than the peer's version ${peerVersion}`;
    }
  }
  return null;
}

function denoJsonVersion(denoJson: string): string | null {
  const version = (JSON.parse(denoJson) as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}

/**
 * The two floors name versions on two separate release lines (the daemon's
 * and the control plane's), so they are not equal. Each must be a plain
 * X.Y.Z no newer than the version the peer repo is building.
 */
export function versionFloorsDrift(
  instanceWire: string,
  daemonWire: string,
  instanceDenoJson: string,
  daemonDenoJson: string,
): string | null {
  return floorWithinVersionDrift(
    extractConst(daemonWire, "MIN_SUPPORTED_INSTANCE_VERSION"),
    denoJsonVersion(instanceDenoJson),
    "MIN_SUPPORTED_INSTANCE_VERSION",
  ) ?? floorWithinVersionDrift(
    extractConst(instanceWire, "MIN_SUPPORTED_DAEMON_VERSION"),
    denoJsonVersion(daemonDenoJson),
    "MIN_SUPPORTED_DAEMON_VERSION",
  );
}

/**
 * A named constant both sides use (a signing prefix, a proof tag, a hostname
 * rule): the control plane's value must equal this daemon's. A name only this
 * daemon has yet is fine (a notice); a different value is red, because a peer
 * that disagrees rejects the other's bytes.
 */
export function constantDrift(
  left: string | null,
  right: string | null,
  message: string,
): string | null {
  if (right == null) return `${message}: missing on the daemon`;
  if (left == null) return null;
  if (left !== right) {
    return `${message}: the control plane and this daemon must hold the same value`;
  }
  return null;
}

function constantEqual(
  left: string | null,
  right: string | null,
  message: string,
): void {
  const drift = constantDrift(left, right, message);
  if (drift) fail(drift);
  if (left == null) mirrorNotice(`${message} is not on the control plane yet`);
}

function mirrorJoinedEqual(
  left: string[] | null,
  right: string[] | null,
  message: string,
): void {
  if (right == null) fail(message);
  if (left?.join(",") !== right.join(",")) mirrorNotice(message);
}

function updateChannelsFromType(source: string): string[] | null {
  const marker = "export type UpdateChannel";
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const from = source.indexOf("=", start);
  const to = source.indexOf(";", from);
  if (from === -1 || to === -1) return null;
  return quotedStrings(source.slice(from + 1, to));
}

async function checkMetrics(tp: string, td: string): Promise<void> {
  const metricsLeft = await mirrorSource(
    tp,
    "src/contracts/metrics-contract.ts",
  );
  const metricsRight = requireText(
    await readRel(td, "src/contracts/metrics-contract.ts"),
    "metrics-contract.ts missing on the daemon",
  );
  if (metricsLeft == null) return;
  mirrorEqual(
    stripHeaderDocblock(metricsLeft),
    stripHeaderDocblock(metricsRight),
    "metrics-contract.ts body drifted (below the header docblock)",
  );
}

async function checkHostname(tp: string, td: string): Promise<void> {
  const hostnameLeft = await mirrorSource(
    tp,
    "src/contracts/commands/hostname.ts",
  );
  const hostnameRight = requireText(
    await readRel(td, "src/contracts/commands-contracts.ts"),
    "hostname sources missing on the daemon",
  );
  if (hostnameLeft == null) return;
  constantEqual(
    extractConst(hostnameLeft, "HOSTNAME_RE"),
    extractConst(hostnameRight, "HOSTNAME_RE"),
    "HOSTNAME_RE drifted",
  );
  constantEqual(
    extractConst(hostnameLeft, "HOSTNAME_MAX_LENGTH"),
    extractConst(hostnameRight, "HOSTNAME_MAX_LENGTH"),
    "HOSTNAME_MAX_LENGTH drifted",
  );
}

/** The signed-session byte rules and the v2 sign-in proof tags must be identical on both sides. */
async function checkPanelIdentityBytes(tp: string, td: string): Promise<void> {
  const envelopeLeft = await mirrorSource(
    tp,
    "src/lib/panel-identity/frame-envelope.ts",
  );
  const envelopeRight = requireText(
    await readRel(td, "src/instance/panel-identity-frames.ts"),
    "panel-identity-frames.ts missing on the daemon",
  );
  for (
    const name of [
      "HELLO_PREFIX",
      "FRAME_PREFIX",
      "HTTP_PREFIX",
      "REPORT_PREFIX",
      "SIG_SUFFIX_MARKER",
    ]
  ) {
    constantEqual(
      envelopeLeft == null ? null : extractConst(envelopeLeft, name),
      extractConst(envelopeRight, name),
      `${name} drifted`,
    );
  }
  const proofLeft = await mirrorSource(tp, "src/daemon/authn/proof-version.ts");
  const proofRight = requireText(
    await readRel(td, "src/crypto/keys.ts"),
    "keys.ts missing on the daemon",
  );
  for (const name of ["ENROLL_PROOF_V2_TAG", "AUTH_PROOF_V2_TAG"]) {
    constantEqual(
      proofLeft == null ? null : extractConst(proofLeft, name),
      extractConst(proofRight, name),
      `${name} drifted`,
    );
  }
  // Daemon-signed requests and the attach proof (pinned here only: the
  // daemon ships first, so the control plane's check does not pin them).
  const pairs: ReadonlyArray<[string, string]> = [
    ["src/daemon/authn/request-signature.ts", "REQUEST_PREFIX"],
    ["src/daemon/authn/attach-proof.ts", "ATTACH_PREFIX"],
    ["src/daemon/authn/pin-report.ts", "PIN_REPORT_PREFIX"],
    ["src/daemon/authn/pin-report.ts", "PIN_PASSKEYS_REPORT_PREFIX"],
  ];
  const sources = await Promise.all(
    pairs.map(([file]) => mirrorSource(tp, file)),
  );
  for (const [index, [, name]] of pairs.entries()) {
    const left = sources[index];
    if (left == null) continue;
    constantEqual(
      extractConst(left, name),
      extractConst(proofRight, name),
      `${name} drifted`,
    );
  }
}

/** The key-set vectors are one file in both repos: the TypeScript and tp-host verifiers must agree. */
async function checkKeysetVectors(tp: string, td: string): Promise<void> {
  const left = await mirrorSource(
    tp,
    "src/test-fixtures/keyset-statement-vectors.json",
  );
  if (left == null) return;
  mirrorEqual(
    left,
    requireText(
      await readRel(td, "src/testing/keyset-statement-vectors.json"),
      "keyset-statement-vectors.json missing on the daemon",
    ),
    "keyset-statement-vectors.json drifted",
  );
}

async function checkMachineKey(tp: string, td: string): Promise<void> {
  const mkLeft = await mirrorSource(tp, "src/lib/machine-key.ts");
  const mkRight = requireText(
    await readRel(td, "src/host/machine-key.ts"),
    "machine-key.ts missing on one side of the pair",
  );
  if (mkLeft == null) return;
  constantEqual(
    extractConst(mkLeft, "TURBOPANEL_MACHINE_ID_NAMESPACE"),
    extractConst(mkRight, "TURBOPANEL_MACHINE_ID_NAMESPACE"),
    "TURBOPANEL_MACHINE_ID_NAMESPACE drifted",
  );
}

async function checkUpdateChannels(tp: string, td: string): Promise<void> {
  const channelsLeftSrc = requireText(
    await readRel(tp, "src/contracts/update-channel.ts"),
    "update-channel sources missing on one side of the pair",
  );
  const channelsRightSrc = requireText(
    await readRel(td, "src/update/types.ts"),
    "update-channel sources missing on one side of the pair",
  );
  const channelsLeft = extractArrayConst(channelsLeftSrc, "UPDATE_CHANNELS");
  const channelsRight = updateChannelsFromType(channelsRightSrc);
  requireSubset(channelsLeft, channelsRight, "UPDATE_CHANNELS");
}

async function checkReportedIp(tp: string, td: string): Promise<void> {
  const ipLeftSrc = requireText(
    await readRel(tp, "src/contracts/server-addresses.ts"),
    "ServerReportedIp sources missing on one side of the pair",
  );
  const ipRightSrc = requireText(
    await readRel(td, "src/contracts/server-reported-ip.ts"),
    "ServerReportedIp sources missing on one side of the pair",
  );
  const ipLeft = extractTypeFields(ipLeftSrc, "ServerReportedIp");
  const ipRight = extractTypeFields(ipRightSrc, "ServerReportedIp");
  requireSubset(ipLeft, ipRight, "ServerReportedIp fields");
}

async function checkLayoutVectors(tp: string, td: string): Promise<void> {
  const left = await mirrorSource(tp, "src/contracts/layout-vectors.json");
  const right = requireText(
    await readRel(td, "src/contracts/layout-vectors.json"),
    "layout-vectors.json missing on the daemon",
  );
  if (left == null) return;
  mirrorEqual(left, right, "layout-vectors.json drifted between checkouts");
}

async function checkSlotMapping(tp: string, td: string): Promise<void> {
  const slotLeftTypes = await mirrorSource(
    tp,
    "src/contracts/topology-types.ts",
  );
  const slotRightTypes = requireText(
    await readRel(td, "src/contracts/topology-types.ts"),
    "topology slot-mapping sources missing on one side of the pair",
  );
  const slotLeftMap = await mirrorSource(
    tp,
    "src/contracts/topology-slot-mapping.ts",
  );
  const slotRightMap = requireText(
    await readRel(td, "src/contracts/topology-slot-mapping.ts"),
    "topology slot-mapping sources missing on one side of the pair",
  );
  constantEqual(
    slotLeftTypes == null ? null : extractConst(slotLeftTypes, "MAX_NIC_SLOTS"),
    extractConst(slotRightTypes, "MAX_NIC_SLOTS"),
    "MAX_NIC_SLOTS drifted",
  );
  mirrorJoinedEqual(
    slotLeftMap == null
      ? null
      : extractArrayConst(slotLeftMap, "FILESYSTEM_ROLE_PRIORITY"),
    extractArrayConst(slotRightMap, "FILESYSTEM_ROLE_PRIORITY"),
    "FILESYSTEM_ROLE_PRIORITY drifted",
  );
}

const TYPE_KEYWORDS = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "any",
  "unknown",
  "never",
  "void",
  "null",
  "undefined",
]);

type TypeAst =
  | { kind: "keyword"; name: string }
  | { kind: "literal"; text: string }
  | { kind: "union"; members: TypeAst[] }
  | { kind: "intersection"; members: TypeAst[] }
  | { kind: "array"; element: TypeAst; readonly: boolean }
  | { kind: "ref"; name: string; args: TypeAst[] }
  | {
    kind: "object";
    fields: Array<{ name: string; required: boolean; type: TypeAst }>;
  }
  | { kind: "opaque"; text: string };

export type ContractFieldSpec = {
  name: string;
  required: boolean;
  type: string;
};

export type ContractFieldPin = ContractFieldSpec & {
  /** Live type may be a proper supertype of `type`. */
  expansion?: boolean;
};

type TypeRelation = "same" | "narrower" | "wider" | "different";

function isWhitespaceChar(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Index after a `//` comment starting at `i` (stops on the newline). */
function skipLineComment(source: string, i: number): number {
  let j = i + 2;
  while (j < source.length && source[j] !== "\n") j += 1;
  return j;
}

/** Index after a block comment starting at `i` (or the end of the source). */
function skipBlockComment(source: string, i: number): number {
  let j = i + 2;
  while (
    j < source.length && !(source[j] === "*" && source[j + 1] === "/")
  ) {
    j += 1;
  }
  return Math.min(source.length, j + 2);
}

function skipTrivia(source: string, i: number): number {
  let j = i;
  while (j < source.length) {
    const ch = source[j];
    if (isWhitespaceChar(ch)) {
      j += 1;
    } else if (ch === "/" && source[j + 1] === "/") {
      j = skipLineComment(source, j);
    } else if (ch === "/" && source[j + 1] === "*") {
      j = skipBlockComment(source, j);
    } else {
      break;
    }
  }
  return j;
}

function skipQuoted(source: string, i: number): number {
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") return i + 1;
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === "\\") {
      j += 2;
      continue;
    }
    if (source[j] === quote) return j + 1;
    j += 1;
  }
  return j;
}

function readWordAt(source: string, i: number): string | null {
  if (!isWordChar(source[i] ?? "")) return null;
  let j = i + 1;
  while (j < source.length && isWordChar(source[j] ?? "")) j += 1;
  return source.slice(i, j);
}

function isDigits(word: string): boolean {
  if (!word) return false;
  for (const ch of word) {
    if (ch < "0" || ch > "9") return false;
  }
  return true;
}

function decodeString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const next = raw[i + 1] ?? "";
    out += next === "n" ? "\n" : next;
    i += 1;
  }
  return out;
}

function quoteLiteral(value: string): string {
  const escaped = value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("'", String.raw`\'`);
  return `'${escaped}'`;
}

class TypeParser {
  readonly #source: string;
  #i = 0;

  constructor(source: string) {
    this.#source = source;
  }

  get index(): number {
    return this.#i;
  }

  parse(): TypeAst {
    return this.#parseUnion();
  }

  #skip(): void {
    this.#i = skipTrivia(this.#source, this.#i);
  }

  #eat(token: string): boolean {
    this.#skip();
    if (!this.#source.startsWith(token, this.#i)) return false;
    this.#i += token.length;
    return true;
  }

  #peekWord(): string {
    return readWordAt(this.#source, skipTrivia(this.#source, this.#i)) ?? "";
  }

  #readWord(): string {
    this.#skip();
    const word = readWordAt(this.#source, this.#i) ?? "";
    this.#i += word.length;
    return word;
  }

  #parseUnion(): TypeAst {
    // A leading `|` is TypeScript style, not an empty union member.
    this.#skip();
    if (this.#source.startsWith("|", this.#i)) this.#i += 1;
    const members = [this.#parseIntersection()];
    while (this.#eat("|")) members.push(this.#parseIntersection());
    if (members.length === 1) return members[0];
    return { kind: "union", members };
  }

  #parseIntersection(): TypeAst {
    const members = [this.#parsePostfix()];
    while (this.#eat("&")) members.push(this.#parsePostfix());
    if (members.length === 1) return members[0];
    return { kind: "intersection", members };
  }

  #parsePostfix(): TypeAst {
    let ast = this.#parsePrimary();
    while (this.#eat("[]")) {
      ast = { kind: "array", element: ast, readonly: false };
    }
    return ast;
  }

  #parsePrimary(): TypeAst {
    this.#skip();
    if (this.#peekWord() === "readonly") {
      return this.#parseReadonly();
    }
    if (this.#eat("(")) {
      const inner = this.#parseUnion();
      this.#eat(")");
      return inner;
    }
    if (this.#eat("{")) return this.#parseObjectFields();
    const ch = this.#source[this.#i];
    if (ch === "'" || ch === '"') return this.#parseStringLiteral();
    const word = this.#readWord();
    if (!word) return { kind: "opaque", text: "" };
    return this.#wordType(word);
  }

  #parseReadonly(): TypeAst {
    this.#readWord();
    const inner = this.#parsePostfix();
    if (inner.kind === "array") return { ...inner, readonly: true };
    return { kind: "opaque", text: `readonly ${canonical(inner)}` };
  }

  #wordType(word: string): TypeAst {
    if (isDigits(word)) return { kind: "literal", text: word };
    if (word === "true" || word === "false") {
      return { kind: "literal", text: word };
    }
    if (TYPE_KEYWORDS.has(word)) return { kind: "keyword", name: word };
    const args = this.#eat("<") ? this.#parseTypeArgs() : [];
    return { kind: "ref", name: word, args };
  }

  #parseStringLiteral(): TypeAst {
    const quote = this.#source[this.#i];
    const end = skipQuoted(this.#source, this.#i);
    const raw = this.#source.slice(this.#i + 1, end - 1);
    this.#i = end;
    if (quote !== "'" && quote !== '"') {
      return { kind: "opaque", text: this.#source.slice(end) };
    }
    return { kind: "literal", text: quoteLiteral(decodeString(raw)) };
  }

  #parseTypeArgs(): TypeAst[] {
    const args: TypeAst[] = [];
    while (this.#i < this.#source.length) {
      this.#skip();
      if (this.#source[this.#i] === ">") break;
      args.push(this.#parseUnion());
      this.#skip();
      if (this.#source[this.#i] === ",") {
        this.#i += 1;
        continue;
      }
      break;
    }
    this.#eat(">");
    return args;
  }

  #parseObjectFields(): TypeAst {
    const fields: Array<{ name: string; required: boolean; type: TypeAst }> =
      [];
    while (this.#i < this.#source.length) {
      this.#skip();
      if (this.#eat("}")) break;
      if (this.#eat(";") || this.#eat(",")) continue;
      const before = this.#i;
      const field = this.#parseField();
      if (field) fields.push(field);
      if (this.#i === before) this.#i += 1;
    }
    return { kind: "object", fields };
  }

  #parseField(): { name: string; required: boolean; type: TypeAst } | null {
    if (this.#peekWord() === "readonly") {
      const mark = this.#i;
      this.#readWord();
      this.#skip();
      const next = this.#source[this.#i];
      if (next === ":" || next === "?") this.#i = mark;
    }
    this.#skip();
    const quoted = this.#source[this.#i] === "'" ||
      this.#source[this.#i] === '"';
    const name = quoted ? this.#readQuotedName() : this.#readWord();
    if (!name || !isWord(name)) return null;
    const required = !this.#eat("?");
    if (!this.#eat(":")) return null;
    return { name, required, type: this.#parseUnion() };
  }

  #readQuotedName(): string {
    const end = skipQuoted(this.#source, this.#i);
    const raw = this.#source.slice(this.#i + 1, Math.max(this.#i + 1, end - 1));
    this.#i = end;
    return decodeString(raw);
  }
}

function parseType(text: string): TypeAst {
  return new TypeParser(text).parse();
}

function collectTypeAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  let i = 0;
  while (i < source.length) {
    const trivia = skipTrivia(source, i);
    if (trivia > i) {
      i = trivia;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(source, i);
      continue;
    }
    if (source.startsWith("export type ", i) && boundaryBefore(source, i)) {
      i = captureAlias(source, i + "export type ".length, aliases);
      continue;
    }
    i += 1;
  }
  return aliases;
}

function boundaryBefore(source: string, i: number): boolean {
  if (i === 0) return true;
  return !isWordChar(source[i - 1] ?? "");
}

function captureAlias(
  source: string,
  i: number,
  aliases: Map<string, string>,
): number {
  const nameAt = skipTrivia(source, i);
  const name = readWordAt(source, nameAt);
  if (!name) return nameAt + 1;
  let cursor = skipTrivia(source, nameAt + name.length);
  if (source[cursor] === "<") {
    const parser = new TypeParser(source.slice(cursor));
    parser.parse();
    cursor = skipTrivia(source, cursor + parser.index);
  }
  if (source[cursor] !== "=") return cursor;
  cursor = skipTrivia(source, cursor + 1);
  const parser = new TypeParser(source.slice(cursor));
  parser.parse();
  const end = cursor + parser.index;
  aliases.set(name, source.slice(cursor, end).trim());
  let after = skipTrivia(source, end);
  if (source[after] === ";") after += 1;
  return after;
}

function resolveAst(
  ast: TypeAst,
  aliases: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
): TypeAst {
  if (ast.kind === "ref" && ast.args.length === 0) {
    return resolveAliasRef(ast.name, aliases, seen);
  }
  if (ast.kind === "ref") {
    return {
      kind: "ref",
      name: ast.name,
      args: ast.args.map((arg) => resolveAst(arg, aliases, seen)),
    };
  }
  if (ast.kind === "union") {
    return {
      kind: "union",
      members: ast.members.map((member) => resolveAst(member, aliases, seen)),
    };
  }
  if (ast.kind === "intersection") {
    return {
      kind: "intersection",
      members: ast.members.map((member) => resolveAst(member, aliases, seen)),
    };
  }
  if (ast.kind === "array") {
    return {
      kind: "array",
      readonly: ast.readonly,
      element: resolveAst(ast.element, aliases, seen),
    };
  }
  if (ast.kind === "object") {
    return {
      kind: "object",
      fields: ast.fields.map((field) => ({
        name: field.name,
        required: field.required,
        type: resolveAst(field.type, aliases, seen),
      })),
    };
  }
  return ast;
}

function resolveAliasRef(
  name: string,
  aliases: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
): TypeAst {
  const body = aliases.get(name);
  if (!body || seen.has(name)) return { kind: "ref", name, args: [] };
  const next = new Set(seen);
  next.add(name);
  return resolveAst(parseType(body), aliases, next);
}

function desugar(ast: TypeAst): TypeAst {
  if (ast.kind === "ref" && ast.name === "Array" && ast.args.length === 1) {
    return { kind: "array", readonly: false, element: desugar(ast.args[0]) };
  }
  if (
    ast.kind === "ref" && ast.name === "ReadonlyArray" && ast.args.length === 1
  ) {
    return { kind: "array", readonly: true, element: desugar(ast.args[0]) };
  }
  if (ast.kind === "ref") {
    return { kind: "ref", name: ast.name, args: ast.args.map(desugar) };
  }
  if (ast.kind === "union") {
    return { kind: "union", members: ast.members.map(desugar) };
  }
  if (ast.kind === "intersection") {
    return { kind: "intersection", members: ast.members.map(desugar) };
  }
  if (ast.kind === "array") {
    return {
      kind: "array",
      readonly: ast.readonly,
      element: desugar(ast.element),
    };
  }
  if (ast.kind === "object") {
    return {
      kind: "object",
      fields: ast.fields.map((field) => ({
        name: field.name,
        required: field.required,
        type: desugar(field.type),
      })),
    };
  }
  return ast;
}

function canonical(ast: TypeAst): string {
  if (ast.kind === "keyword") return ast.name;
  if (ast.kind === "literal") return ast.text;
  if (ast.kind === "opaque") return normalizeWs(ast.text);
  if (ast.kind === "array") return canonicalArray(ast);
  if (ast.kind === "ref") return canonicalRef(ast);
  if (ast.kind === "union") return joinSorted(ast.members, " | ");
  if (ast.kind === "intersection") return joinSorted(ast.members, " & ");
  return canonicalObject(ast.fields);
}

function canonicalArray(ast: { element: TypeAst; readonly: boolean }): string {
  const inner = canonical(ast.element);
  return ast.readonly ? `ReadonlyArray<${inner}>` : `Array<${inner}>`;
}

function canonicalRef(ast: { name: string; args: TypeAst[] }): string {
  if (ast.args.length === 0) return ast.name;
  return `${ast.name}<${ast.args.map(canonical).join(", ")}>`;
}

function joinSorted(members: TypeAst[], sep: string): string {
  return members.map(canonical).sort((a, b) => a.localeCompare(b)).join(sep);
}

function canonicalObject(
  fields: Array<{ name: string; required: boolean; type: TypeAst }>,
): string {
  const parts = fields
    .map((field) => ({
      name: field.name,
      text: `${field.name}${field.required ? "" : "?"}: ${
        canonical(field.type)
      }`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((field) => field.text);
  return `{ ${parts.join("; ")} }`;
}

function literalFitsKeyword(text: string, keyword: string): boolean {
  if (keyword === "string") return text.startsWith("'");
  if (keyword === "number") return isDigits(text);
  if (keyword === "boolean") return text === "true" || text === "false";
  return false;
}

function isAssignable(from: TypeAst, to: TypeAst): boolean {
  if (canonical(from) === canonical(to)) return true;
  if (from.kind === "keyword" && from.name === "never") return true;
  if (to.kind === "keyword" && (to.name === "any" || to.name === "unknown")) {
    return true;
  }
  if (from.kind === "union") {
    return from.members.every((member) => isAssignable(member, to));
  }
  if (to.kind === "union") {
    return to.members.some((member) => isAssignable(from, member));
  }
  return isAssignableShape(from, to);
}

function isAssignableShape(from: TypeAst, to: TypeAst): boolean {
  if (from.kind === "literal" && to.kind === "keyword") {
    return literalFitsKeyword(from.text, to.name);
  }
  if (from.kind === "array" && to.kind === "array") {
    if (from.readonly && !to.readonly) return false;
    return isAssignable(from.element, to.element);
  }
  if (from.kind === "object" && to.kind === "object") {
    return objectAssignable(from.fields, to.fields);
  }
  if (
    from.kind === "ref" && to.kind === "ref" && from.name === to.name &&
    from.args.length === to.args.length
  ) {
    return from.args.every((arg, index) => isAssignable(arg, to.args[index]));
  }
  return false;
}

function objectAssignable(
  from: Array<{ name: string; required: boolean; type: TypeAst }>,
  to: Array<{ name: string; required: boolean; type: TypeAst }>,
): boolean {
  for (const field of to) {
    const found = from.find((item) => item.name === field.name);
    if (!found) return false;
    if (field.required && !found.required) return false;
    if (!isAssignable(found.type, field.type)) return false;
  }
  return true;
}

export function relateFieldTypes(live: string, pin: string): TypeRelation {
  const liveAst = desugar(parseType(live));
  const pinAst = desugar(parseType(pin));
  const liveToPin = isAssignable(liveAst, pinAst);
  const pinToLive = isAssignable(pinAst, liveAst);
  if (liveToPin && pinToLive) return "same";
  if (liveToPin) return "narrower";
  if (pinToLive) return "wider";
  return "different";
}

function finishType(
  text: string,
  aliases: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
): TypeAst {
  return desugar(resolveAst(parseType(text), aliases, seen));
}

export function extractFieldSpecs(
  source: string,
  typeName: string,
): ContractFieldSpec[] | null {
  const aliases = collectTypeAliases(source);
  const body = aliases.get(typeName);
  if (body == null) return null;
  const ast = finishType(body, aliases, new Set([typeName]));
  if (ast.kind !== "object") return null;
  return ast.fields
    .map((field) => ({
      name: field.name,
      required: field.required,
      type: canonical(field.type),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function fieldPinDrift(
  live: ContractFieldSpec[] | null,
  pin: ContractFieldPin[],
  label: string,
): string | null {
  if (!live) return `${label} type missing`;
  const byName = new Map(live.map((field) => [field.name, field]));
  for (const field of pin) {
    const reason = pinFieldDrift(byName.get(field.name), field, label);
    if (reason) return reason;
  }
  return null;
}

function pinFieldDrift(
  found: ContractFieldSpec | undefined,
  field: ContractFieldPin,
  label: string,
): string | null {
  if (!found) return `${label} removed ${field.name}`;
  if (field.required && !found.required) {
    return `${label} narrowed ${field.name}`;
  }
  const relation = relateFieldTypes(found.type, field.type);
  if (relation === "same") return null;
  if (relation === "wider" && field.expansion === true) return null;
  if (relation === "wider") {
    return `${label} expanded ${field.name} from ${field.type} to ${found.type} without a compatible expansion mark`;
  }
  return `${label} narrowed ${field.name} from ${field.type} to ${found.type}`;
}

function extractObjectLiteral(source: string, name: string): string | null {
  const marker = `export const ${name}`;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const eq = source.indexOf("=", start + marker.length);
  if (eq === -1) return null;
  const open = source.indexOf("{", eq);
  const close = source.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  return stripQuotes(normalizeWs(source.slice(open, close + 1)));
}

/**
 * Compares two snapshot files by parsed data, not bytes, because each repo's
 * formatter wraps lines differently. Returns the path of the first difference
 * (for example `$.Foo.fields[2].type`) or null when the data is identical.
 * Throws a one-line Error when either file is not valid JSON.
 */
export function snapshotDataDrift(left: string, right: string): string | null {
  return firstDataDifference(
    parseSnapshot(left, "instance"),
    parseSnapshot(right, "daemon"),
    "$",
  );
}

type SnapshotPin = {
  instance?: unknown;
  daemon?: unknown;
  fields?: { name: string; required?: boolean }[];
};

/**
 * A daemon pin that widens the control plane's on purpose (same requiredness,
 * a wider type, `expansion: true`) still covers it.
 */
export function markedWidening(
  pin: { required?: boolean; type?: string },
  theirs: { required?: boolean; type?: string; expansion?: boolean },
): boolean {
  return theirs.expansion === true && theirs.required === pin.required &&
    relateFieldTypes(theirs.type ?? "", pin.type ?? "") === "wider";
}

/** Why the daemon's pin of one type does not cover the control plane's, or null. */
function typePinDrift(
  typeName: string,
  pin: SnapshotPin,
  theirs: SnapshotPin,
): string | null {
  for (const key of ["instance", "daemon"] as const) {
    if (pin[key] !== theirs[key]) return `$.${typeName}.${key} differs`;
  }
  const daemonFields = new Map(
    (theirs.fields ?? []).map((field) => [field.name, field]),
  );
  for (const field of pin.fields ?? []) {
    const found = daemonFields.get(field.name);
    if (!found) {
      return `${typeName}.${field.name} is pinned on the control plane but not here; merge the daemon change first`;
    }
    const differs = firstDataDifference(
      field,
      found,
      `$.${typeName}.fields.${field.name}`,
    );
    if (differs && !markedWidening(field, found)) {
      return `${differs} differs between the snapshots`;
    }
    daemonFields.delete(field.name);
  }
  const required = [...daemonFields.values()].find((extra) => extra.required);
  return required
    ? `${typeName}.${required.name} is a required field only the daemon pins; a field the control plane does not know yet must be optional`
    : null;
}

/**
 * Daemon first: every type and field the control plane pins must be pinned
 * the same way in the daemon's snapshot. The daemon may pin more types, and
 * more fields when they are optional. Returns why not, or null.
 */
export function snapshotSubsetDrift(
  left: string,
  right: string,
): string | null {
  const instance = parseSnapshot(left, "instance") as Record<
    string,
    SnapshotPin
  >;
  const daemon = parseSnapshot(right, "daemon") as Record<
    string,
    SnapshotPin
  >;
  for (const [typeName, pin] of Object.entries(instance)) {
    const theirs = daemon[typeName];
    if (!isPlainObject(theirs)) {
      return `${typeName} is pinned on the control plane but not here; merge the daemon change first`;
    }
    const drift = typePinDrift(typeName, pin, theirs);
    if (drift) return drift;
  }
  return null;
}

function parseSnapshot(text: string, side: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `contract-field-snapshot.json on the ${side} is not valid JSON`,
    );
  }
}

function firstDataDifference(
  a: unknown,
  b: unknown,
  path: string,
): string | null {
  if (Array.isArray(a) && Array.isArray(b)) return arrayDifference(a, b, path);
  if (isPlainObject(a) && isPlainObject(b)) return objectDifference(a, b, path);
  return Object.is(a, b) ? null : path;
}

function arrayDifference(
  a: unknown[],
  b: unknown[],
  path: string,
): string | null {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const at = `${path}[${i}]`;
    if (i >= a.length || i >= b.length) return at;
    const found = firstDataDifference(a[i], b[i], at);
    if (found) return found;
  }
  return null;
}

function objectDifference(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: string,
): string | null {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const at = `${path}.${key}`;
    if (!(key in a) || !(key in b)) return at;
    const found = firstDataDifference(a[key], b[key], at);
    if (found) return found;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ContractPin = {
  instance: string;
  daemon: string;
  fields: ContractFieldPin[];
};

function assertFieldsCovered(
  live: ContractFieldSpec[] | null,
  pin: ContractFieldPin[],
  label: string,
): void {
  const drift = fieldPinDrift(live, pin, label);
  if (drift) fail(drift);
}

function assertRequiredSuperset(
  instanceFields: ContractFieldSpec[],
  daemonFields: ContractFieldSpec[],
  label: string,
): void {
  const daemonByName = new Map(
    daemonFields.map((field) => [field.name, field]),
  );
  for (const field of instanceFields) {
    if (!field.required) continue;
    const found = daemonByName.get(field.name);
    if (!found?.required) {
      fail(`${label} daemon mirror is missing required ${field.name}`);
    }
  }
}

async function checkExpandOnly(tp: string, td: string): Promise<void> {
  const left = requireText(
    await readRel(tp, "scripts/contract-field-snapshot.json"),
    "contract-field-snapshot.json missing on the instance",
  );
  const right = requireText(
    await readRel(td, "scripts/contract-field-snapshot.json"),
    "contract-field-snapshot.json missing on the daemon",
  );
  let differsAt: string | null = null;
  try {
    differsAt = snapshotSubsetDrift(left, right);
  } catch (error) {
    fail((error as Error).message);
  }
  if (differsAt) {
    fail(`contract-field-snapshot.json: ${differsAt}`);
  }
  const snapshot = JSON.parse(left) as Record<string, ContractPin>;
  const daemonSnapshot = JSON.parse(right) as Record<string, ContractPin>;
  // Reads are independent (readRel never throws); the checks below still run
  // in snapshot order so the first failure reported is unchanged.
  const sources = await Promise.all(
    Object.values(snapshot).map(async (pin) => ({
      instance: await readRel(tp, pin.instance),
      daemon: await readRel(td, pin.daemon),
    })),
  );
  for (const [index, [typeName, pin]] of Object.entries(snapshot).entries()) {
    const instanceSrc = requireText(
      sources[index].instance,
      `${typeName} instance source missing`,
    );
    const daemonSrc = requireText(
      sources[index].daemon,
      `${typeName} daemon source missing`,
    );
    const instanceFields = extractFieldSpecs(instanceSrc, typeName);
    const daemonFields = extractFieldSpecs(daemonSrc, typeName);
    assertFieldsCovered(instanceFields, pin.fields, `${typeName} instance`);
    assertFieldsCovered(
      daemonFields,
      daemonSnapshot[typeName].fields,
      `${typeName} daemon`,
    );
    if (!instanceFields || !daemonFields) fail(`${typeName} fields missing`);
    assertRequiredSuperset(instanceFields, daemonFields, typeName);
  }

  const instanceWire = requireText(
    await readRel(tp, "src/lib/version-wire.ts"),
    "instance version-wire.ts missing",
  );
  const daemonWire = requireText(
    await readRel(td, "src/instance/version-wire.ts"),
    "daemon version-wire.ts missing",
  );
  constantEqual(
    extractConst(instanceWire, "INSTANCE_VERSION_HEADER"),
    extractConst(daemonWire, "INSTANCE_VERSION_HEADER"),
    "INSTANCE_VERSION_HEADER drifted",
  );
  const floors = versionFloorsDrift(
    instanceWire,
    daemonWire,
    requireText(await readRel(tp, "deno.json"), "instance deno.json missing"),
    requireText(await readRel(td, "deno.json"), "daemon deno.json missing"),
  );
  if (floors) fail(floors);
  for (
    const name of [
      "DAEMON_FEATURE_MIN_VERSIONS",
      "INSTANCE_FEATURE_MIN_VERSIONS",
    ]
  ) {
    const drift = mapDriftFromDaemon(
      extractObjectLiteral(instanceWire, name),
      extractObjectLiteral(daemonWire, name),
    );
    if (drift) fail(`${name}: ${drift}`);
  }
  requireSubset(
    extractArrayConst(instanceWire, "DAEMON_WIRE_FEATURES"),
    extractArrayConst(daemonWire, "DAEMON_WIRE_FEATURES"),
    "DAEMON_WIRE_FEATURES",
  );
}

/** A precondition the check itself refuses (not a drift in the contracts). */
export class ContractDriftError extends Error {}

export type ContractDriftOptions = {
  /** The turbopanel checkout to compare against. */
  sibling?: string;
  /** Fail instead of skipping when the sibling is absent (CI sets this). */
  requireSibling?: boolean;
};

export async function runContractDriftCheck(
  opts: ContractDriftOptions = {},
): Promise<"ok" | "skipped"> {
  const sibling = opts.sibling ?? SIBLING;
  const requireSibling = opts.requireSibling ??
    Deno.env.get("TURBOPANEL_REQUIRE_SIBLING") === "1";
  const siblingSrc = join(sibling, "src");
  try {
    await Deno.stat(siblingSrc);
  } catch {
    // CI's contract-drift job checks the sibling out and sets this, so a
    // missing checkout there is a failure rather than a silent pass.
    if (requireSibling) {
      throw new ContractDriftError(`sibling checkout missing at ${sibling}`);
    }
    console.log(
      `check-contract-drift: sibling checkout missing at ${sibling}; skip`,
    );
    return "skipped";
  }

  const tp = sibling;
  const td = ROOT;
  await checkMetrics(tp, td);
  await checkHostname(tp, td);
  await checkMachineKey(tp, td);
  await checkKeysetVectors(tp, td);
  await checkUpdateChannels(tp, td);
  await checkReportedIp(tp, td);
  await checkSlotMapping(tp, td);
  await checkLayoutVectors(tp, td);
  await checkPanelIdentityBytes(tp, td);
  await checkExpandOnly(tp, td);

  console.log(
    "check-contract-drift: the control plane relies on nothing this daemon lacks (features, feature floors, channels, ServerReportedIp, expand-only fields); byte mirrors checked (notices above, if any).",
  );
  return "ok";
}

/** CLI entry: a refused precondition exits non-zero; anything else rethrows. */
export async function main(
  run: () => Promise<unknown> = runContractDriftCheck,
  onRefused: (message: string) => void = fail,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof ContractDriftError)) throw err;
    onRefused(err.message);
  }
}

if (import.meta.main) await main();
