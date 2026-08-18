import { assertEquals } from "@std/assert";
import { readProcFile } from "./proc-read.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "readProcFile reads a fixture file via Deno.readTextFile",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "tp-proc-read-" });
    try {
      const path = `${dir}/osrelease`;
      await Deno.writeTextFile(path, "6.1.0-test\n");
      assertEquals(await readProcFile(path), "6.1.0-test\n");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "readProcFile returns undefined when the path is missing",
  permissions: { read: true, run: ["cat"] },
  async fn() {
    assertEquals(
      await readProcFile("/no/such/turbopanel-proc-file"),
      undefined,
    );
  },
});

test("readProcFile uses cat fallback when Deno.readTextFile fails", async () => {
  const text = await readProcFile("/proc/sys/kernel/osrelease", {
    readTextFile: () => Promise.reject(new Error("blocked")),
    runCat: () =>
      Promise.resolve({
        code: 0,
        stdout: new TextEncoder().encode("6.1.0-cat-fallback\n"),
      }),
  });
  assertEquals(text, "6.1.0-cat-fallback\n");
});

test("readProcFile returns undefined when cat exits non-zero", async () => {
  assertEquals(
    await readProcFile("/ignored", {
      readTextFile: () => Promise.reject(new Error("blocked")),
      runCat: () => Promise.resolve({ code: 1, stdout: new Uint8Array() }),
    }),
    undefined,
  );
});

test("readProcFile returns undefined when cat itself throws", async () => {
  assertEquals(
    await readProcFile("/ignored", {
      readTextFile: () => Promise.reject(new Error("blocked")),
      runCat: () => Promise.reject(new Error("no cat")),
    }),
    undefined,
  );
});

test({
  name: "readProcFile uses default cat Command when runCat is omitted",
  permissions: { read: true, write: true, run: ["cat"] },
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "tp-proc-default-cat-" });
    try {
      const path = `${dir}/payload`;
      await Deno.writeTextFile(path, "default-cat-body\n");
      assertEquals(
        await readProcFile(path, {
          readTextFile: () => Promise.reject(new Error("blocked")),
        }),
        "default-cat-body\n",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
