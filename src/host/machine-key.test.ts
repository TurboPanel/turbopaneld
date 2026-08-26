import { assertEquals } from "@std/assert";
import {
  cachedMachineKey,
  deriveMachineKey,
  readMachineKey,
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

test({
  name:
    "readMachineKey derives from a fixture path without warming the default cache",
  permissions: { read: true, write: true },
  async fn() {
    resetMachineKeyCacheForTests();
    assertEquals(cachedMachineKey(), undefined);

    const dir = await Deno.makeTempDir({ prefix: "tp-machine-key-" });
    try {
      const path = `${dir}/machine-id`;
      await Deno.writeTextFile(path, `${FIXTURE_MACHINE_ID}\n`);
      const key = await readMachineKey(path);
      assertEquals(key, PINNED_MACHINE_KEY);
      // Custom path must not pollute the process cache used by hello.
      assertEquals(cachedMachineKey(), undefined);

      const emptyPath = `${dir}/empty-id`;
      await Deno.writeTextFile(emptyPath, "   \n");
      assertEquals(await readMachineKey(emptyPath), undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
      resetMachineKeyCacheForTests();
    }
  },
});

test({
  name: "readMachineKey returns undefined for a missing fixture path",
  permissions: { read: true },
  async fn() {
    resetMachineKeyCacheForTests();
    assertEquals(
      await readMachineKey("/no/such/turbopanel-machine-id"),
      undefined,
    );
    resetMachineKeyCacheForTests();
  },
});

test({
  name: "readMachineKey caches the default /etc/machine-id path",
  permissions: { read: true, run: true },
  async fn() {
    resetMachineKeyCacheForTests();
    try {
      const first = await readMachineKey();
      const second = await readMachineKey();
      assertEquals(second, first);
      assertEquals(cachedMachineKey(), first);
    } finally {
      resetMachineKeyCacheForTests();
    }
  },
});

test({
  name: "readMachineKey uses cat when Deno.readTextFileSync fails",
  permissions: { read: true, write: true, run: true },
  async fn() {
    resetMachineKeyCacheForTests();
    const dir = await Deno.makeTempDir({ prefix: "tp-machine-key-cat-" });
    const originalRead = Deno.readTextFileSync;
    try {
      const path = `${dir}/machine-id`;
      await Deno.writeTextFile(path, `${FIXTURE_MACHINE_ID}\n`);
      Deno.readTextFileSync = () => {
        throw new Error("read blocked");
      };
      assertEquals(await readMachineKey(path), PINNED_MACHINE_KEY);
      assertEquals(cachedMachineKey(), undefined);
    } finally {
      Deno.readTextFileSync = originalRead;
      await Deno.remove(dir, { recursive: true });
      resetMachineKeyCacheForTests();
    }
  },
});

test({
  name: "readMachineKey treats cat command failure as empty input",
  permissions: { read: true, run: true },
  async fn() {
    resetMachineKeyCacheForTests();
    const originalRead = Deno.readTextFileSync;
    const OriginalCommand = Deno.Command;
    Deno.readTextFileSync = () => {
      throw new Error("read blocked");
    };
    Deno.Command = function (
      cmd: string,
      options?: Deno.CommandOptions,
    ): Deno.Command {
      if (cmd === "cat") {
        throw new Error("cat unavailable");
      }
      return new OriginalCommand(cmd, options);
    } as unknown as typeof Deno.Command;
    try {
      assertEquals(
        await readMachineKey("/no/such/turbopanel-machine-id-cmd"),
        undefined,
      );
    } finally {
      Deno.Command = OriginalCommand;
      Deno.readTextFileSync = originalRead;
      resetMachineKeyCacheForTests();
    }
  },
});
