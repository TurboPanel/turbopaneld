import { assert, assertEquals } from "@std/assert";
import {
  CANONICAL_FIELDS,
  MAP_FIELDS,
  type ParsedBody,
  parseRequestBody,
} from "../../orchestration/roles/docker-gate/files/body.ts";
import {
  DEFAULT_POLICY_CONFIG,
  evaluateRequest,
  type ResolvePath,
} from "../../orchestration/roles/docker-gate/files/policy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const identity: ResolvePath = (path) => Promise.resolve(path);

type Corpus = Array<{
  name: string;
  method: string;
  path: string;
  body: unknown;
  expect: string[];
}>;

const CORPUS: Corpus = JSON.parse(
  await Deno.readTextFile(new URL("./testdata/corpus.json", import.meta.url)),
);

const parse = (text: string): ParsedBody =>
  parseRequestBody(new TextEncoder().encode(text));

/** The rules a request with this raw body text breaks, as the proxy judges it. */
async function rulesFor(path: string, text: string): Promise<string[]> {
  const parsed = parse(text);
  const found = await evaluateRequest(
    {
      method: "POST",
      path,
      query: new URLSearchParams(),
      body: parsed.json,
      bodyError: parsed.error,
    },
    DEFAULT_POLICY_CONFIG,
    identity,
  );
  return found.map((violation) =>
    violation.detail === undefined
      ? violation.rule
      : `${violation.rule}:${violation.detail}`
  );
}

const CREATE = "/containers/create";

test("odd-case and escaped field names reach the policy like the canonical ones", async () => {
  const cases: Array<[string, string, string[]]> = [
    [CREATE, `{"hostconfig":{"privileged":true}}`, ["privileged"]],
    [CREATE, `{"HOSTCONFIG":{"PRIVILEGED":true}}`, ["privileged"]],
    [
      CREATE,
      `{"hostConfig":{"binds":["/:/h"]}}`,
      ["bind-host-root:/"],
    ],
    [
      CREATE,
      `{"HostConfig":{"mounts":[{"type":"bind","source":"/etc","readonly":true}]}}`,
      ["bind-forbidden-path:/etc"],
    ],
    [
      CREATE,
      String.raw`{"hostconfig":{"Privileged":true,"binds":["/:/h"]}}`,
      ["privileged", "bind-host-root:/"],
    ],
    [
      CREATE,
      `{"HostConfig":{"networkmode":"host","capadd":["SYS_ADMIN"]}}`,
      ["cap-add:SYS_ADMIN", "network-mode-host:host"],
    ],
    ["/containers/abc/exec", `{"privileged":true}`, ["exec-privileged"]],
    ["/networks/create", `{"DRIVER":"macvlan"}`, ["network-driver:macvlan"]],
    [
      "/volumes/create",
      `{"driverOpts":{"type":"none","o":"bind","device":"/etc"}}`,
      ["volume-bind-forbidden-path:/etc"],
    ],
  ];
  for (const [path, text, expected] of cases) {
    assertEquals(await rulesFor(path, text), expected, text);
  }
});

test("a repeated field is refused, exact or case-folded, at every depth", async () => {
  const repeated = [
    // Go decodes both into the same struct (the first one's fields survive).
    `{"HostConfig":{"Privileged":true},"HostConfig":{}}`,
    `{"HostConfig":{},"hostconfig":{"Privileged":true}}`,
    `{"HostConfig":{"Binds":[],"binds":["/:/h"]}}`,
    String.raw`{"HostConfig":{"Binds":[],"binds":["/:/h"]}}`,
    `{"HostConfig":{"Mounts":[{"Type":"volume","TYPE":"bind","Source":"/"}]}}`,
    `{"Privileged":false,"privileged":true}`,
  ];
  for (const text of repeated) {
    assertEquals(parse(text), { error: "duplicate-key" }, text);
    assertEquals(
      await rulesFor(CREATE, text),
      ["body-unparseable:duplicate-key"],
      text,
    );
  }
});

test("non-ASCII field names are refused (Go folds the Kelvin sign and the long s)", async () => {
  const folded = [
    `{"HostConfig":{"Bindſ":["/:/h"]}}`,
    String.raw`{"HostConfig":{"Bindſ":["/:/h"]}}`,
    `{"HostConfig":{"MasKedPaths":[]}}`,
    `{"HostKonfig":{}}`,
  ];
  for (const text of folded) {
    assertEquals(parse(text), { error: "non-ascii-key" }, text);
    assertEquals(
      await rulesFor(CREATE, text),
      ["body-unparseable:non-ascii-key"],
      text,
    );
  }
});

test("map fields keep their keys exactly: labels and driver options are neither folded nor refused", () => {
  const parsed = parse(
    `{"Labels":{"a":"1","A":"2","été":"x"},"HostConfig":{"LogConfig":{"Type":"json-file","Config":{"max-size":"1m","MAX-SIZE":"2m"}}}}`,
  );
  assertEquals(parsed, {
    json: {
      Labels: { a: "1", A: "2", "été": "x" },
      HostConfig: {
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "1m", "MAX-SIZE": "2m" },
        },
      },
    },
  });
  // A map's values that are objects are structs again.
  assertEquals(
    parse(`{"NetworkingConfig":{"EndpointsConfig":{"n":{"a":1,"A":2}}}}`),
    { error: "duplicate-key" },
  );
  assertEquals(parse(`{"Labels":{"__proto__":"x"}}`), {
    json: { Labels: Object.fromEntries([["__proto__", "x"]]) },
  });
});

test("whitespace around the value is fine; a BOM, bad UTF-8, trailing data, deep nesting and empty bodies fail closed", async () => {
  assertEquals(parse(` \r\n\t{"HostConfig":{}}\n`), {
    json: { HostConfig: {} },
  });
  const bad: Array<[Uint8Array, string]> = [
    [new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "invalid-json"],
    [
      new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
      "invalid-utf8",
    ],
    [new Uint8Array(0), "empty"],
  ];
  for (const [bytes, error] of bad) {
    assertEquals(parseRequestBody(bytes), { error });
  }
  const invalid = [
    `{"a":1}{"b":2}`,
    `{"a":1,}`,
    `{'a':1}`,
    `{"a":NaN}`,
    `{"a":01}`,
    `{"a":"\u0001"}`,
    `{"a" 1}`,
    `{"a":tru}`,
    `[1 2]`,
    `{"a":"x`,
    `{a:1}`,
    `   `,
  ];
  for (const text of invalid) {
    assertEquals(parse(text), { error: "invalid-json" }, text);
  }
  assertEquals(parse(`${"[".repeat(100)}${"]".repeat(100)}`), {
    error: "too-deep",
  });
  assertEquals(await rulesFor(CREATE, `{"HostConfig":{}`), [
    "body-unparseable:invalid-json",
  ]);
  assertEquals(parse(`[1,-2.5e3,true,false,null,"s",{}]`), {
    json: [1, -2500, true, false, null, "s", {}],
  });
});

test("every corpus body parses strictly and keeps its verdict", async () => {
  for (const entry of CORPUS) {
    const parsed = parse(JSON.stringify(entry.body));
    assertEquals(parsed.error, undefined, entry.name);
    assertEquals(parsed.json, entry.body, entry.name);
    const found = await evaluateRequest(
      {
        method: entry.method,
        path: entry.path,
        query: new URLSearchParams(),
        body: parsed.json,
      },
      DEFAULT_POLICY_CONFIG,
      identity,
    );
    assertEquals(found.map((v) => v.rule), entry.expect, entry.name);
  }
});

test("every field the policy reads has a canonical spelling, and no struct it descends into is a map", async () => {
  const sources = await Promise.all(
    ["policy.ts", "review.ts", "platform.ts"].map((file) =>
      Deno.readTextFile(
        new URL(
          `../../orchestration/roles/docker-gate/files/${file}`,
          import.meta.url,
        ),
      )
    ),
  );
  const read = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\.([A-Z][A-Za-z]+)\b/g)) {
      read.add(match[1]);
    }
    for (const match of source.matchAll(/\["([A-Z][A-Za-z]+)", "/g)) {
      read.add(match[1]);
    }
  }
  const canonical = new Set(CANONICAL_FIELDS);
  for (const field of read) {
    assert(canonical.has(field), `${field} is read by the policy`);
  }
  for (const struct of ["HostConfig", "VolumeOptions", "DriverConfig"]) {
    assert(!MAP_FIELDS.has(struct.toLowerCase()), struct);
  }
});
