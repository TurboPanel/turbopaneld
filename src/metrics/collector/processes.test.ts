import { assertEquals } from "@std/assert";
import { countProcessesInProc } from "./processes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "countProcessesInProc counts only numeric directory entries",
  permissions: { read: true, write: true },
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "tp-proc-count-" });
    try {
      await Deno.mkdir(`${dir}/1`);
      await Deno.mkdir(`${dir}/42`);
      await Deno.mkdir(`${dir}/self`);
      await Deno.writeTextFile(`${dir}/cmdline`, "x");
      assertEquals(await countProcessesInProc(dir), 2);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "countProcessesInProc returns null when the directory cannot be read",
  permissions: { read: true, run: ["ls"] },
  async fn() {
    assertEquals(
      await countProcessesInProc("/no/such/turbopanel-proc-dir"),
      null,
    );
  },
});

test("countProcessesInProc uses ls fallback when Deno.readDir fails", async () => {
  const count = await countProcessesInProc("/proc", {
    readDir: () => {
      throw new Error("blocked");
    },
    runLs: () =>
      Promise.resolve({
        code: 0,
        stdout: new TextEncoder().encode("1\n42\nself\nstat\n"),
      }),
  });
  assertEquals(count, 2);
});

test("countProcessesInProc returns null when ls exits non-zero", async () => {
  assertEquals(
    await countProcessesInProc("/ignored", {
      readDir: () => {
        throw new Error("blocked");
      },
      runLs: () => Promise.resolve({ code: 1, stdout: new Uint8Array() }),
    }),
    null,
  );
});

test("countProcessesInProc returns null when ls itself throws", async () => {
  assertEquals(
    await countProcessesInProc("/ignored", {
      readDir: () => {
        throw new Error("blocked");
      },
      runLs: () => Promise.reject(new Error("no ls")),
    }),
    null,
  );
});

test({
  name: "countProcessesInProc uses default ls Command when runLs is omitted",
  permissions: { env: true, read: true, write: true, run: ["ls"] },
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "tp-proc-default-ls-" });
    const previousLd = Deno.env.get("LD_LIBRARY_PATH");
    try {
      // CI setup-python exports this; scoped --allow-run=ls must still spawn.
      Deno.env.set("LD_LIBRARY_PATH", "/usr/lib");
      await Deno.mkdir(`${dir}/1`);
      await Deno.mkdir(`${dir}/9`);
      await Deno.mkdir(`${dir}/self`);
      assertEquals(
        await countProcessesInProc(dir, {
          readDir: () => {
            throw new Error("blocked");
          },
        }),
        2,
      );
    } finally {
      if (previousLd === undefined) {
        Deno.env.delete("LD_LIBRARY_PATH");
      } else {
        Deno.env.set("LD_LIBRARY_PATH", previousLd);
      }
      await Deno.remove(dir, { recursive: true });
    }
  },
});
