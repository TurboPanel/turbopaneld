import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  type ContractFieldPin,
  extractFieldSpecs,
  fieldPinDrift,
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
  const snapshot = JSON.parse(
    await Deno.readTextFile(join(ROOT, "scripts/contract-field-snapshot.json")),
  ) as Record<
    string,
    { instance: string; daemon: string; fields: ContractFieldPin[] }
  >;
  const sibling = join(ROOT, "..", "turbopanel");
  for (const [typeName, pin] of Object.entries(snapshot)) {
    const daemonSrc = await Deno.readTextFile(join(ROOT, pin.daemon));
    const instanceSrc = await Deno.readTextFile(join(sibling, pin.instance));
    assertEquals(extractFieldSpecs(daemonSrc, typeName), pin.fields);
    assertEquals(extractFieldSpecs(instanceSrc, typeName), pin.fields);
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
