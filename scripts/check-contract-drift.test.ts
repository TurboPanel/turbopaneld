import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  constantDrift,
  ContractDriftError,
  type ContractFieldPin,
  extractFieldSpecs,
  fieldPinDrift,
  floorWithinVersionDrift,
  main,
  mapDriftFromDaemon,
  markedWidening,
  missingFromDaemon,
  objectLiteralEntries,
  runContractDriftCheck,
  snapshotDataDrift,
  snapshotSubsetDrift,
  versionFloorsDrift,
} from "./check-contract-drift.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = join(fromFileUrl(new URL(".", import.meta.url)), "..");

const NARROWED = `
export type Scope = "private" | "public";
export type Sample = {
  /** brace } inside a comment must not end the object */
  address: "only";
  version: 4;
  items: Array<string>;
  payload: {
    id: string;
    name: string;
  };
};
`;

const PIN: ContractFieldPin[] = [
  { name: "address", required: true, type: "string" },
  { name: "version", required: true, type: "4 | 6" },
  { name: "items", required: true, type: "Array<string | number>" },
  {
    name: "payload",
    required: true,
    type: "{ id: string; name: string | number }",
  },
];

test("extractFieldSpecs keeps fields after a brace inside a comment", () => {
  const live = extractFieldSpecs(NARROWED, "Sample");
  assertEquals(live?.map((field) => field.name), [
    "address",
    "items",
    "payload",
    "version",
  ]);
  assertEquals(
    live?.find((field) => field.name === "items")?.type,
    "Array<string>",
  );
});

test("a narrowed union, literal, array, or member fails the drift check", () => {
  const live = extractFieldSpecs(NARROWED, "Sample");
  assertStringIncludes(
    fieldPinDrift(live, [PIN[1]], "fixture") ?? "",
    "narrowed version",
  );
  assertStringIncludes(
    fieldPinDrift(live, [PIN[0]], "fixture") ?? "",
    "narrowed address",
  );
  assertStringIncludes(
    fieldPinDrift(live, [PIN[2]], "fixture") ?? "",
    "narrowed items",
  );
  assertStringIncludes(
    fieldPinDrift(live, [PIN[3]], "fixture") ?? "",
    "narrowed payload",
  );
});

test("a wider type passes only when the snapshot marks a compatible expansion", () => {
  const live = extractFieldSpecs(
    "export type Sample = { version: 4 | 6 | 8 };",
    "Sample",
  );
  const pin: ContractFieldPin = {
    name: "version",
    required: true,
    type: "4 | 6",
  };
  assertStringIncludes(
    fieldPinDrift(live, [pin], "fixture") ?? "",
    "without a compatible expansion mark",
  );
  assertEquals(
    fieldPinDrift(live, [{ ...pin, expansion: true }], "fixture"),
    null,
  );
  const narrowed = extractFieldSpecs(
    "export type Sample = { version: 4 };",
    "Sample",
  );
  assertStringIncludes(
    fieldPinDrift(narrowed, [{ ...pin, expansion: true }], "fixture") ?? "",
    "narrowed version",
  );
});

test("the committed snapshot matches both checkouts' normalized field types", async () => {
  const sibling = join(ROOT, "..", "turbopanel");
  try {
    await Deno.stat(join(sibling, "src"));
  } catch {
    // Single-repo CI has no sibling. A co-located checkout, and the instance
    // repo's dual-checkout job, still compare the snapshot.
    return;
  }
  const snapshot = JSON.parse(
    await Deno.readTextFile(join(ROOT, "scripts/contract-field-snapshot.json")),
  ) as Record<
    string,
    { instance: string; daemon: string; fields: ContractFieldPin[] }
  >;
  // Daemon first: the control plane may pin fewer types and fields.
  const instanceSnapshot = JSON.parse(
    await Deno.readTextFile(
      join(sibling, "scripts/contract-field-snapshot.json"),
    ),
  ) as Record<string, { instance: string; fields: ContractFieldPin[] }>;
  for (const [typeName, pin] of Object.entries(snapshot)) {
    const daemonSrc = await Deno.readTextFile(join(ROOT, pin.daemon));
    assertEquals(extractFieldSpecs(daemonSrc, typeName), pin.fields);
    const theirs = instanceSnapshot[typeName];
    if (theirs) {
      const instanceSrc = await Deno.readTextFile(
        join(sibling, theirs.instance),
      );
      assertEquals(
        fieldPinDrift(
          extractFieldSpecs(instanceSrc, typeName),
          theirs.fields,
          typeName,
        ),
        null,
      );
    }
    assertEquals(
      fieldPinDrift(
        extractFieldSpecs(daemonSrc, typeName),
        pin.fields,
        typeName,
      ),
      null,
    );
  }
});

test("a missing sibling fails when CI requires it, and skips otherwise", async () => {
  const absent = await Deno.makeTempDir();
  const sibling = join(absent, "turbopanel");
  try {
    let refused: unknown;
    try {
      await runContractDriftCheck({ sibling, requireSibling: true });
    } catch (err) {
      refused = err;
    }
    assertEquals(refused instanceof ContractDriftError, true);
    assertStringIncludes((refused as Error).message, sibling);
    assertEquals(
      await runContractDriftCheck({ sibling, requireSibling: false }),
      "skipped",
    );
  } finally {
    await Deno.remove(absent, { recursive: true });
  }
});

test("the CLI entry exits on a refusal, rethrows other errors, and passes a clean run", async () => {
  const refusals: string[] = [];
  await main(
    () =>
      Promise.reject(new ContractDriftError("sibling checkout missing at /x")),
    (message) => refusals.push(message),
  );
  assertEquals(refusals, ["sibling checkout missing at /x"]);

  let rethrown: unknown;
  try {
    await main(
      () => Promise.reject(new Error("boom")),
      (m) => refusals.push(m),
    );
  } catch (err) {
    rethrown = err;
  }
  assertEquals((rethrown as Error).message, "boom");

  await main(() => Promise.resolve("ok"), (m) => refusals.push(m));
  assertEquals(refusals.length, 1);
});

test("snapshotDataDrift ignores layout and names the first differing path", () => {
  const wrapped = `{
  "Foo": {
    "fields": [
      {
        "name": "type",
        "required": true
      }
    ]
  }
}`;
  const collapsed =
    `{"Foo": {"fields": [{ "name": "type", "required": true }]}}`;
  assertEquals(snapshotDataDrift(wrapped, collapsed), null);
  assertEquals(
    snapshotDataDrift(
      wrapped,
      collapsed.replace('"required": true', '"required": false'),
    ),
    "$.Foo.fields[0].required",
  );
  assertEquals(
    snapshotDataDrift(wrapped, `{"Foo": {"fields": []}}`),
    "$.Foo.fields[0]",
  );
  assertEquals(snapshotDataDrift(wrapped, `{"Bar": {}}`), "$.Foo");
});

test("snapshotDataDrift reports a shorter array and a malformed file", () => {
  assertEquals(snapshotDataDrift(`{"a": [1, 2]}`, `{"a": [1]}`), "$.a[1]");
  assertEquals(snapshotDataDrift(`{"a": 1, "b": 2}`, `{"b": 2, "a": 1}`), null);
  assertThrows(
    () => snapshotDataDrift(`{"a": `, `{}`),
    Error,
    "contract-field-snapshot.json on the instance is not valid JSON",
  );
  assertThrows(
    () => snapshotDataDrift(`{}`, `nope`),
    Error,
    "on the daemon is not valid JSON",
  );
});

test("a version floor passes at or below the peer version and names why otherwise", () => {
  const name = "MIN_SUPPORTED_INSTANCE_VERSION";
  assertEquals(floorWithinVersionDrift("0.1.22", "0.1.22", name), null);
  assertEquals(floorWithinVersionDrift("0.1.18", "0.1.22", name), null);
  assertEquals(floorWithinVersionDrift("0.9.9", "1.0.0", name), null);
  assertEquals(
    floorWithinVersionDrift("0.1.23", "0.1.22", name),
    "MIN_SUPPORTED_INSTANCE_VERSION 0.1.23 is newer than the peer's version 0.1.22",
  );
  assertEquals(
    floorWithinVersionDrift("0.2.0", "0.1.22", name),
    "MIN_SUPPORTED_INSTANCE_VERSION 0.2.0 is newer than the peer's version 0.1.22",
  );
  assertEquals(
    floorWithinVersionDrift("0.1.22-rc.1", "0.1.22", name),
    "MIN_SUPPORTED_INSTANCE_VERSION must be a plain X.Y.Z (got 0.1.22-rc.1)",
  );
  assertEquals(
    floorWithinVersionDrift(null, "0.1.22", name),
    "MIN_SUPPORTED_INSTANCE_VERSION must be a plain X.Y.Z (got null)",
  );
  assertEquals(
    floorWithinVersionDrift("0.1.22", "v0.1.22", name),
    "MIN_SUPPORTED_INSTANCE_VERSION: the peer deno.json version is not X.Y.Z (got v0.1.22)",
  );
});

test("versionFloorsDrift holds each floor against the peer repo's deno.json", () => {
  const instanceWire = `export const MIN_SUPPORTED_DAEMON_VERSION = '0.1.18'`;
  const daemonWire = `export const MIN_SUPPORTED_INSTANCE_VERSION = "0.1.22";`;
  const json = (version: string) => JSON.stringify({ version });
  assertEquals(
    versionFloorsDrift(
      instanceWire,
      daemonWire,
      json("0.1.22"),
      json("0.1.18"),
    ),
    null,
  );
  assertEquals(
    versionFloorsDrift(
      instanceWire,
      daemonWire,
      json("0.1.21"),
      json("0.1.18"),
    ),
    "MIN_SUPPORTED_INSTANCE_VERSION 0.1.22 is newer than the peer's version 0.1.21",
  );
  assertEquals(
    versionFloorsDrift(
      instanceWire,
      daemonWire,
      json("0.1.22"),
      json("0.1.17"),
    ),
    "MIN_SUPPORTED_DAEMON_VERSION 0.1.18 is newer than the peer's version 0.1.17",
  );
  assertEquals(
    versionFloorsDrift(instanceWire, daemonWire, "{}", json("0.1.18")),
    "MIN_SUPPORTED_INSTANCE_VERSION: the peer deno.json version is not X.Y.Z (got null)",
  );
});

// Daemon first: this daemon may be ahead of the control plane, never behind.
test("more wire features here pass; a control plane feature this daemon lacks is named", () => {
  assertEquals(missingFromDaemon(["a-v1"], ["a-v1", "b-v1"]), []);
  assertEquals(missingFromDaemon(["a-v1", "c-v1"], ["a-v1"]), ["c-v1"]);
});

test("feature floors: every control plane key must be here with the same value", () => {
  assertEquals(objectLiteralEntries("{ a: 0.1.1, b: 0.2.0, }"), [
    ["a", "0.1.1"],
    ["b", "0.2.0"],
  ]);
  assertEquals(objectLiteralEntries("{}"), []);
  assertEquals(objectLiteralEntries("{ nope }"), null);
  assertEquals(
    mapDriftFromDaemon("{ a: 0.1.1 }", "{ a: 0.1.1, b: 0.2.0 }"),
    null,
  );
  assertStringIncludes(
    mapDriftFromDaemon("{ c: 0.3.0 }", "{ a: 0.1.1 }") ?? "",
    "c is not in this daemon's map",
  );
  assertStringIncludes(
    mapDriftFromDaemon("{ a: 0.1.2 }", "{ a: 0.1.1 }") ?? "",
    "a is 0.1.2 on the control plane but 0.1.1 here",
  );
  assertStringIncludes(mapDriftFromDaemon(null, "{}") ?? "", "missing");
});

test("snapshot: this daemon may pin more types and optional fields, never fewer or different", () => {
  const a = { name: "a", required: true, type: "string" };
  const b = { name: "b", required: false, type: "number" };
  const pin = (fields: object[]) =>
    JSON.stringify({ T: { instance: "i.ts", daemon: "d.ts", fields } });
  assertEquals(snapshotSubsetDrift(pin([a]), pin([a, b])), null);
  assertEquals(
    snapshotSubsetDrift(
      pin([a]),
      JSON.stringify({
        ...JSON.parse(pin([a])),
        U: { instance: "x", daemon: "y", fields: [] },
      }),
    ),
    null,
  );
  assertStringIncludes(
    snapshotSubsetDrift(pin([a, b]), pin([a])) ?? "",
    "T.b is pinned on the control plane but not here",
  );
  assertStringIncludes(
    snapshotSubsetDrift(pin([a]), "{}") ?? "",
    "T is pinned on the control plane",
  );
  assertStringIncludes(
    snapshotSubsetDrift(pin([a]), pin([a, { ...b, required: true }])) ?? "",
    "must be optional",
  );
  assertStringIncludes(
    snapshotSubsetDrift(pin([a]), pin([{ ...a, type: "number" }])) ?? "",
    "$.T.fields.a.type differs",
  );
});

test("named constants: a shared value must agree, a name only this daemon has is fine", () => {
  assertEquals(
    constantDrift("tp-hello-v1", "tp-hello-v1", "HELLO_PREFIX"),
    null,
  );
  assertEquals(constantDrift(null, "tp-new-v1", "REQUEST_PREFIX"), null);
  assertStringIncludes(
    constantDrift("tp-hello-v1", "tp-hello-v2", "HELLO_PREFIX") ?? "",
    "must hold the same value",
  );
  assertStringIncludes(
    constantDrift("x", null, "HELLO_PREFIX") ?? "",
    "missing on the daemon",
  );
});

test("snapshot: a daemon pin that widens on purpose still covers the control plane's", () => {
  const pin = { name: "v", required: true, type: "4 | 6" };
  const wide = { ...pin, type: "4 | 6 | 8", expansion: true };
  assertEquals(markedWidening(pin, wide), true);
  assertEquals(markedWidening(pin, { ...wide, expansion: undefined }), false);
  assertEquals(markedWidening(pin, { ...wide, required: false }), false);
  assertEquals(markedWidening(pin, { ...wide, type: "4" }), false);
  const snap = (field: object) =>
    JSON.stringify({
      T: { instance: "i.ts", daemon: "d.ts", fields: [field] },
    });
  assertEquals(snapshotSubsetDrift(snap(pin), snap(wide)), null);
  assertStringIncludes(
    snapshotSubsetDrift(snap(pin), snap({ ...pin, type: "4 | 6 | 8" })) ?? "",
    "differs",
  );
});

/**
 * A control plane checkout built from this daemon's own sources, so the whole
 * check runs here without the sibling repo: every pinned type, constant and
 * mirror the check reads from the control plane side, at its control plane
 * path. `drop` leaves files out; `tweak` edits one after it is written.
 */
async function fakeControlPlane(
  opts: {
    drop?: string[];
    tweak?: Record<string, (text: string) => string>;
  } = {},
): Promise<string> {
  const root = await Deno.makeTempDir();
  const files = new Map<string, string>();
  const add = async (to: string, from: string) => {
    const text = await Deno.readTextFile(join(ROOT, from));
    files.set(to, (files.get(to) ?? "") + text + "\n");
  };
  await add(
    "src/contracts/metrics-contract.ts",
    "src/contracts/metrics-contract.ts",
  );
  await add(
    "src/contracts/commands/hostname.ts",
    "src/contracts/commands-contracts.ts",
  );
  await add(
    "src/lib/panel-identity/frame-envelope.ts",
    "src/instance/panel-identity-frames.ts",
  );
  for (
    const to of [
      "src/daemon/authn/proof-version.ts",
      "src/daemon/authn/request-signature.ts",
      "src/daemon/authn/attach-proof.ts",
      "src/daemon/authn/pin-report.ts",
    ]
  ) await add(to, "src/crypto/keys.ts");
  await add(
    "src/test-fixtures/keyset-statement-vectors.json",
    "src/testing/keyset-statement-vectors.json",
  );
  await add("src/lib/machine-key.ts", "src/host/machine-key.ts");
  await add(
    "src/contracts/server-addresses.ts",
    "src/contracts/server-reported-ip.ts",
  );
  await add(
    "src/contracts/layout-vectors.json",
    "src/contracts/layout-vectors.json",
  );
  await add(
    "src/contracts/topology-types.ts",
    "src/contracts/topology-types.ts",
  );
  await add(
    "src/contracts/topology-slot-mapping.ts",
    "src/contracts/topology-slot-mapping.ts",
  );
  await add(
    "scripts/contract-field-snapshot.json",
    "scripts/contract-field-snapshot.json",
  );
  const snapshot = JSON.parse(
    await Deno.readTextFile(join(ROOT, "scripts/contract-field-snapshot.json")),
  ) as Record<string, { instance: string; daemon: string }>;
  const pairs = new Set(
    Object.values(snapshot).map((pin) => `${pin.instance}\n${pin.daemon}`),
  );
  for (const pair of pairs) {
    const [to, from] = pair.split("\n");
    await add(to, from);
  }
  const channels = (await Deno.readTextFile(join(ROOT, "src/update/types.ts")))
    .match(/export type UpdateChannel =([^;]*);/)?.[1] ?? "";
  files.set(
    "src/contracts/update-channel.ts",
    `export const UPDATE_CHANNELS = [${channels.split("|").join(",")}];\n`,
  );
  await add("src/lib/version-wire.ts", "src/instance/version-wire.ts");
  files.set(
    "src/lib/version-wire.ts",
    files.get("src/lib/version-wire.ts") +
      'export const MIN_SUPPORTED_DAEMON_VERSION = "0.0.1";\n',
  );
  files.set("deno.json", JSON.stringify({ version: "99.0.0" }));
  for (const [rel, text] of files) {
    if (opts.drop?.includes(rel)) continue;
    const path = join(root, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, opts.tweak?.[rel]?.(text) ?? text);
  }
  return root;
}

test("a control plane that is behind this daemon passes the whole check", async () => {
  const same = await fakeControlPlane();
  // Behind: daemon-only names missing, a whole-file mirror that differs, and
  // fewer features than this daemon lists. All of it is a notice at most.
  const behind = await fakeControlPlane({
    drop: [
      "src/daemon/authn/request-signature.ts",
      "src/contracts/metrics-contract.ts",
    ],
    tweak: {
      "src/contracts/layout-vectors.json": (text) => `${text} `,
      "src/lib/version-wire.ts": (text) =>
        text.replace(
          /(export const DAEMON_WIRE_FEATURES = \[)\s*"[^"]+",/,
          "$1",
        ),
    },
  });
  try {
    assertEquals(
      await runContractDriftCheck({ sibling: same, requireSibling: true }),
      "ok",
    );
    assertEquals(
      await runContractDriftCheck({ sibling: behind, requireSibling: true }),
      "ok",
    );
  } finally {
    await Deno.remove(same, { recursive: true });
    await Deno.remove(behind, { recursive: true });
  }
});
