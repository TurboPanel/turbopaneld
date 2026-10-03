import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ensureDaemonDir,
  removeDaemonFile,
  writeDaemonFile,
} from "./daemon-files.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// A folder the daemon cannot write stands in for the root-owned config root.
// (Running as root, nothing is refused, so the fallback tests do not apply.)
const isRoot = Deno.uid?.() === 0;

async function sealedDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-daemon-files-" });
  await Deno.chmod(dir, 0o555);
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.chmod(dir, 0o755);
  await Deno.remove(dir, { recursive: true });
}

test("a writable folder gets the file by rename and no host call", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-daemon-files-" });
  const calls: string[][] = [];
  try {
    const path = join(dir, "server.id");
    await writeDaemonFile(path, "abc\n", 0o640, (args) => {
      calls.push(args);
      return Promise.resolve();
    });
    assertEquals(await Deno.readTextFile(path), "abc\n");
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o640);
    assertEquals(calls, []);
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["server.id"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test(
  "a root-owned folder sends the file through tp-host install as the daemon account",
  {
    ignore: isRoot,
  },
  async () => {
    const dir = await sealedDir();
    const calls: string[][] = [];
    try {
      const path = join(dir, "firewall.v4");
      let staged = "";
      await writeDaemonFile(path, "rules\n", 0o664, async (args) => {
        calls.push(args);
        staged = await Deno.readTextFile(args.at(-2)!);
      });
      assertEquals(calls.length, 1);
      // group- and world-write are dropped: tp-host refuses them in a root folder
      assertEquals(calls[0].slice(0, -2), [
        "install",
        "-m",
        "0644",
        "-o",
        "tp",
        "-g",
        "tp",
      ]);
      assertEquals(calls[0].at(-1), path);
      assertEquals(staged, "rules\n");
      // the staging copy never outlives the call
      assertEquals(
        await Deno.stat(calls[0].at(-2)!).then(() => true, () => false),
        false,
      );
    } finally {
      await cleanup(dir);
    }
  },
);

test("a failed host call is an error, not a silent skip", {
  ignore: isRoot,
}, async () => {
  const dir = await sealedDir();
  try {
    await assertRejects(
      () =>
        writeDaemonFile(join(dir, "x"), "y", 0o600, () => {
          throw new Error("sudo: a password is required");
        }),
      Error,
      "password",
    );
  } finally {
    await cleanup(dir);
  }
});

test(
  "removal: absent is fine, a writable folder is direct, a root-owned folder asks tp-host",
  {
    ignore: isRoot,
  },
  async () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return Promise.resolve();
    };
    const open = await Deno.makeTempDir({ prefix: "tp-daemon-files-" });
    try {
      await removeDaemonFile(join(open, "missing"), run);
      await Deno.writeTextFile(join(open, "a"), "x");
      await removeDaemonFile(join(open, "a"), run);
      assertEquals(calls, []);
    } finally {
      await Deno.remove(open, { recursive: true });
    }
    const sealed = await Deno.makeTempDir({ prefix: "tp-daemon-files-" });
    try {
      await Deno.writeTextFile(join(sealed, "b"), "x");
      await Deno.chmod(sealed, 0o555);
      await removeDaemonFile(join(sealed, "b"), run);
      assertEquals(calls, [["rm", "-f", "--", join(sealed, "b")]]);
    } finally {
      await cleanup(sealed);
    }
  },
);

test("ensureDaemonDir accepts a root-owned directory that already exists", {
  ignore: isRoot,
}, async () => {
  const dir = await sealedDir();
  try {
    await ensureDaemonDir(dir);
    await assertRejects(() => ensureDaemonDir(join(dir, "new", "deep")));
  } finally {
    await cleanup(dir);
  }
});
