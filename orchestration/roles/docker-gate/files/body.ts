/**
 * Request bodies read the way the engine reads them.
 *
 * The engine decodes JSON with Go's `encoding/json`: struct field names match
 * case-insensitively (and through Unicode simple folding, so `ſ` is `s` and
 * the Kelvin sign is `k`), and a field sent twice is decoded twice into the
 * same struct, the first object's fields surviving the second. `JSON.parse`
 * does neither. So the gate parses strictly instead: a struct field name that
 * is not ASCII, or that repeats case-insensitively, makes the body
 * unparseable (fail closed: no Docker API field has either), and every
 * ASCII field name the policy reads is rewritten to its canonical spelling.
 * Keys of the Go maps (labels, driver options, ...) are matched exactly by the
 * engine and are kept exactly here.
 *
 * Dependency-free on purpose (see http.ts).
 */

/** What a body came to: the parsed JSON, or why it is refused. */
export type ParsedBody = { json?: unknown; error?: string };

/**
 * Fields (case-folded) whose value is a Go map in the engine's request types:
 * their keys are data, matched exactly, never folded or refused.
 */
export const MAP_FIELDS: ReadonlySet<string> = new Set([
  "annotations",
  "auxiliaryaddresses",
  "config",
  "driveropts",
  "endpointsconfig",
  "exposedports",
  "labels",
  "options",
  "portbindings",
  "storageopt",
  "sysctls",
  "tmpfs",
  "volumes",
]);

/** The spelling the policy reads for every struct field it looks at. */
export const CANONICAL_FIELDS: readonly string[] = [
  "Annotations",
  "BindOptions",
  "Binds",
  "Capabilities",
  "CapAdd",
  "Cgroup",
  "CgroupParent",
  "CgroupnsMode",
  "Cmd",
  "CpuRealtimePeriod",
  "CpuRealtimeRuntime",
  "DeviceCgroupRules",
  "DeviceRequests",
  "Devices",
  "Driver",
  "DriverConfig",
  "DriverOpts",
  "GroupAdd",
  "HostConfig",
  "IpcMode",
  "Labels",
  "Links",
  "LogConfig",
  "MaskedPaths",
  "Mounts",
  "Name",
  "NetworkMode",
  "OomScoreAdj",
  "Options",
  "PidMode",
  "Privileged",
  "Propagation",
  "ReadOnly",
  "ReadonlyPaths",
  "Runtime",
  "SecurityOpt",
  "Source",
  "Subpath",
  "Sysctls",
  "TmpfsOptions",
  "Type",
  "UTSMode",
  "UsernsMode",
  "VolumeDriver",
  "VolumeOptions",
  "VolumesFrom",
];

const CANONICAL = new Map(
  CANONICAL_FIELDS.map((field) => [field.toLowerCase(), field]),
);

/** Deeper than any Docker request body; refused rather than recursed into. */
const MAX_DEPTH = 64;

/** Anything but printable ASCII: no Docker API field name holds it. */
const NOT_PRINTABLE_ASCII = /[^ -~]/;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS: ReadonlyArray<[string, unknown]> = [
  ["true", true],
  ["false", false],
  ["null", null],
];

class BodyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Whether an object's keys are struct field names or the keys of a Go map. */
type Context = "struct" | "map";

class StrictJson {
  #pos = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.value("struct", 0);
    this.skipWhitespace();
    if (this.#pos !== this.text.length) throw new BodyError("invalid-json");
    return value;
  }

  private value(context: Context, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new BodyError("too-deep");
    this.skipWhitespace();
    const ch = this.text[this.#pos];
    if (ch === "{") return this.object(context, depth + 1);
    if (ch === "[") return this.array(depth + 1);
    if (ch === '"') return this.string();
    return this.scalar();
  }

  private object(context: Context, depth: number): Record<string, unknown> {
    this.#pos++;
    const entries: Array<[string, unknown]> = [];
    const seen = new Set<string>();
    if (this.eat("}")) return Object.fromEntries(entries);
    do {
      this.skipWhitespace();
      const raw = this.string();
      const key = context === "struct" ? structKey(raw, seen) : raw;
      this.expect(":");
      entries.push([key, this.value(childContext(context, key), depth)]);
    } while (this.eat(","));
    this.expect("}");
    return Object.fromEntries(entries);
  }

  private array(depth: number): unknown[] {
    this.#pos++;
    const items: unknown[] = [];
    if (this.eat("]")) return items;
    do {
      items.push(this.value("struct", depth));
    } while (this.eat(","));
    this.expect("]");
    return items;
  }

  /** A string token, decoded (and its escapes validated) by `JSON.parse`. */
  private string(): string {
    const start = this.#pos;
    if (this.text[start] !== '"') throw new BodyError("invalid-json");
    let end = start + 1;
    while (end < this.text.length && this.text[end] !== '"') {
      end += this.text[end] === "\\" ? 2 : 1;
    }
    if (end >= this.text.length) throw new BodyError("invalid-json");
    this.#pos = end + 1;
    return decodeToken(this.text.slice(start, end + 1)) as string;
  }

  private scalar(): unknown {
    for (const [word, value] of LITERALS) {
      if (this.text.startsWith(word, this.#pos)) {
        this.#pos += word.length;
        return value;
      }
    }
    NUMBER.lastIndex = this.#pos;
    const match = NUMBER.exec(this.text);
    if (match === null) throw new BodyError("invalid-json");
    this.#pos += match[0].length;
    return Number(match[0]);
  }

  private skipWhitespace(): void {
    while (" \t\n\r".includes(this.text[this.#pos] ?? "x")) this.#pos++;
  }

  private eat(ch: string): boolean {
    this.skipWhitespace();
    if (this.text[this.#pos] !== ch) return false;
    this.#pos++;
    return true;
  }

  private expect(ch: string): void {
    if (!this.eat(ch)) throw new BodyError("invalid-json");
  }
}

function decodeToken(token: string): unknown {
  try {
    return JSON.parse(token);
  } catch {
    throw new BodyError("invalid-json");
  }
}

/** A struct field name: ASCII, not repeated case-insensitively, canonical. */
function structKey(raw: string, seen: Set<string>): string {
  if (NOT_PRINTABLE_ASCII.test(raw)) throw new BodyError("non-ascii-key");
  const folded = raw.toLowerCase();
  if (seen.has(folded)) throw new BodyError("duplicate-key");
  seen.add(folded);
  return CANONICAL.get(folded) ?? raw;
}

/** A map's values are structs again; a struct field named like a map is a map. */
function childContext(context: Context, key: string): Context {
  return context === "struct" && MAP_FIELDS.has(key.toLowerCase())
    ? "map"
    : "struct";
}

/**
 * Parse a request body strictly (see the module comment). Never throws: an
 * empty, non-UTF-8, malformed, too deep or ambiguous body comes back as
 * `{ error }` with a fixed reason, never echoing the body.
 */
export function parseRequestBody(bytes: Uint8Array): ParsedBody {
  if (bytes.length === 0) return { error: "empty" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return { error: "invalid-utf8" };
  }
  try {
    return { json: new StrictJson(text).parse() };
  } catch (err) {
    if (err instanceof BodyError) return { error: err.reason };
    throw err;
  }
}
