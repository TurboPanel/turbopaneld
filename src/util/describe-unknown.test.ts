/**
 * Host-free coverage for the unknown-value formatter.
 */

import { assertEquals } from "@std/assert";
import { describeUnknown } from "./describe-unknown.ts";

/** Jest/Mocha-shaped alias for {@link Deno.test} (Sonar S2187). */
const test = Deno.test.bind(Deno);

test("describeUnknown keeps the message of an Error", () => {
  assertEquals(describeUnknown(new Error("boom")), "boom");
  assertEquals(describeUnknown(new TypeError("bad type")), "bad type");
});

test("describeUnknown passes strings through and stringifies primitives", () => {
  assertEquals(describeUnknown("plain"), "plain");
  assertEquals(describeUnknown(42), "42");
  assertEquals(describeUnknown(false), "false");
  assertEquals(describeUnknown(10n), "10");
  assertEquals(describeUnknown(undefined), "undefined");
  assertEquals(describeUnknown(Symbol("tag")), "Symbol(tag)");
});

test("describeUnknown renders objects as JSON, never [object Object]", () => {
  assertEquals(describeUnknown({ code: "E1" }), '{"code":"E1"}');
  assertEquals(describeUnknown(null), "null");
  assertEquals(describeUnknown([1, 2]), "[1,2]");
});

test("describeUnknown survives values JSON cannot encode", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertEquals(describeUnknown(cyclic), "[unserializable value]");
  assertEquals(describeUnknown({ n: 1n }), "[unserializable value]");
  assertEquals(
    describeUnknown({ toJSON: () => undefined }),
    "[unserializable value]",
  );
});
