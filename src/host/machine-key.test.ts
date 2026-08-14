import { assertEquals } from "@std/assert";
import {
  deriveMachineKey,
  resetMachineKeyCacheForTests,
  TURBOPANEL_MACHINE_ID_NAMESPACE,
} from "./machine-key.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Parity contract with `turbopanel/src/lib/machine-key.test.ts` — same namespace
 * literal and pinned (fixture machine id → hex) vector. Drift between the two
 * copies breaks enroll/auth across the daemon ↔ instance boundary.
 */
const FIXTURE_MACHINE_ID = "0123456789abcdef0123456789abcdef";
const PINNED_MACHINE_KEY =
  "11716aa801bce01e817f5c72a7170e94dc0df512209c1785012b630648be628b";

test("namespace literal matches the pinned application-id constant", () => {
  assertEquals(
    TURBOPANEL_MACHINE_ID_NAMESPACE,
    "57fd317c-089a-4d52-9d3d-bbf76ba30383",
  );
});

test("deriveMachineKey returns undefined for empty or whitespace input", async () => {
  resetMachineKeyCacheForTests();
  assertEquals(await deriveMachineKey(""), undefined);
  assertEquals(await deriveMachineKey("   "), undefined);
  assertEquals(await deriveMachineKey("\n\t"), undefined);
});

test("deriveMachineKey is deterministic for the same raw id", async () => {
  const a = await deriveMachineKey(FIXTURE_MACHINE_ID);
  const b = await deriveMachineKey(FIXTURE_MACHINE_ID);
  assertEquals(a, b);
  assertEquals(a, PINNED_MACHINE_KEY);
});

test("deriveMachineKey matches the pinned parity vector", async () => {
  assertEquals(await deriveMachineKey(FIXTURE_MACHINE_ID), PINNED_MACHINE_KEY);
});

test("deriveMachineKey normalizes trim + lowercase before HMAC", async () => {
  const upper = await deriveMachineKey(
    `  ${FIXTURE_MACHINE_ID.toUpperCase()}  `,
  );
  assertEquals(upper, PINNED_MACHINE_KEY);
});
