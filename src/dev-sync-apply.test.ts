import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  applyDevSyncTarball,
  COLOCATED_DEV_SYNC_REFUSED_REASON,
  HOST_LOCAL_ARTIFACTS,
  MANAGED_DEV_SYNC_REFUSED_REASON,
  resolveDevSyncSourceRoot,
} from "./dev-sync-apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// Source dev-sync replaces an editable checkout in place. It must refuse the
// co-located development daemon and every managed / compiled / JS-fallback
// install (no editable source tree). These pin that contract so a managed target
// is never mistaken for a source-tree daemon.

function withEnv<T>(
  key: string,
  value: string | undefined,
  fn: () => T,
): T {
  const previous = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  try {
    return fn();
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
}

function withEnvMap<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> | T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

async function createTarGzFromDir(contentDir: string): Promise<Uint8Array> {
  const tgz = await Deno.makeTempFile({ suffix: ".tgz" });
  const out = await new Deno.Command("tar", {
    args: ["-czf", tgz, "-C", contentDir, "."],
  }).output();
  if (!out.success) {
    throw new Error(
      `tar create failed: ${new TextDecoder().decode(out.stderr).trim()}`,
    );
  }
  const bytes = await Deno.readFile(tgz);
  await Deno.remove(tgz);
  return bytes;
}

async function writeTree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
}

type CheckoutFixture = {
  parent: string;
  daemonRoot: string;
  cleanup: () => Promise<void>;
};

async function createCheckoutFixture(): Promise<CheckoutFixture> {
  const parent = await Deno.makeTempDir({ prefix: "dev-sync-apply-" });
  const daemonRoot = join(parent, "turbopaneld");
  await Deno.mkdir(daemonRoot);
  await writeTree(daemonRoot, {
    "main.ts": "// old checkout\n",
    "stale-upstream.ts": "// remove on sync\n",
    ".git/HEAD": "ref: refs/heads/trunk\n",
    "logs/daemon.log": "old log line\n",
    ".github/workflows/ci.yml": "name: ci\n",
    "cloudflared/token.json": "{\"token\":\"host\"}\n",
  });
  return {
    parent,
    daemonRoot,
    cleanup: async () => {
      await Deno.remove(parent, { recursive: true });
    },
  };
}

type CommandMock = {
  cmd: string;
  args: string[];
  cwd?: string | URL;
};

function installCommandMock(
  handler: (call: CommandMock) => {
    success: boolean;
    stderr?: string;
    throwOnConstruct?: boolean;
  },
): () => void {
  const original = Deno.Command;
  Deno.Command = class {
    #call: CommandMock;
    constructor(cmd: string, opts: Deno.CommandOptions) {
      this.#call = {
        cmd,
        args: (opts.args ?? []) as string[],
        cwd: opts.cwd,
      };
      const result = handler(this.#call);
      if (result.throwOnConstruct) {
        throw new Error("command construct failed");
      }
    }
    output() {
      const result = handler(this.#call);
      const stderr = result.stderr ?? "";
      return Promise.resolve({
        success: result.success,
        code: result.success ? 0 : 1,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(stderr),
      });
    }
  } as unknown as typeof Deno.Command;
  return () => {
    Deno.Command = original;
  };
}

function restoreCwd(originalCwd: string): void {
  try {
    Deno.chdir(originalCwd);
  } catch {
    // Best-effort restore for tests that re-anchor cwd.
  }
}

test("resolveDevSyncSourceRoot refuses the co-located dev daemon", () => {
  withEnv("TURBOPANEL_DEV_INSTANCE", "1", () => {
    const result = resolveDevSyncSourceRoot({});
    if (result.ok) {
      throw new Error("expected co-located refusal, got a source root");
    }
    if (result.reason !== COLOCATED_DEV_SYNC_REFUSED_REASON) {
      throw new Error(`unexpected reason: ${result.reason}`);
    }
  });
});

test("resolveDevSyncSourceRoot refuses managed installs (bundled JS / compiled / native)", async () => {
  // A non-checkout root override models the managed install layout where the
  // resolver would otherwise fall back to the bundled entrypoint dir.
  const notCheckout = await Deno.makeTempDir();
  try {
    withEnv("TURBOPANEL_DEV_INSTANCE", undefined, () => {
      const result = resolveDevSyncSourceRoot({
        TURBOPANEL_DAEMON_ROOT: notCheckout,
      });
      if (result.ok) {
        throw new Error(
          `managed install must refuse source-sync, got root ${result.root}`,
        );
      }
      if (result.reason !== MANAGED_DEV_SYNC_REFUSED_REASON) {
        throw new Error(`unexpected reason: ${result.reason}`);
      }
    });
  } finally {
    await Deno.remove(notCheckout, { recursive: true });
  }
});

test("resolveDevSyncSourceRoot accepts a real checkout override", async () => {
  const checkout = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");
    withEnv("TURBOPANEL_DEV_INSTANCE", undefined, () => {
      const result = resolveDevSyncSourceRoot({
        TURBOPANEL_DAEMON_ROOT: checkout,
      });
      if (!result.ok) {
        throw new Error(`expected source root, refused: ${result.reason}`);
      }
      if (result.root !== checkout) {
        throw new Error(`unexpected root: ${result.root}`);
      }
    });
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

test("applyDevSyncTarball refuses the co-located development daemon", async () => {
  const originalCwd = Deno.cwd();
  try {
    await assertRejects(
      async () =>
        await withEnvMap({ TURBOPANEL_DEV_INSTANCE: "1" }, async () =>
          await applyDevSyncTarball(new Uint8Array([0x1f]))
        ),
      Error,
      COLOCATED_DEV_SYNC_REFUSED_REASON,
    );
  } finally {
    await restoreCwd(originalCwd);
  }
});

test("applyDevSyncTarball refuses managed installs without a checkout", async () => {
  const notCheckout = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  try {
    await assertRejects(
      async () =>
        await withEnvMap({
          TURBOPANEL_DEV_INSTANCE: undefined,
          TURBOPANEL_DAEMON_ROOT: notCheckout,
        }, async () => await applyDevSyncTarball(new Uint8Array([0x1f]))),
      Error,
      MANAGED_DEV_SYNC_REFUSED_REASON,
    );
  } finally {
    await restoreCwd(originalCwd);
    await Deno.remove(notCheckout, { recursive: true });
  }
});

test("applyDevSyncTarball replaces checkout and preserves host-local artifacts", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  try {
    await writeTree(contentDir, {
      "main.ts": "// synced checkout\n",
      "src/new.ts": "export const v = 1;\n",
      ".git/shipped": "archive should not win\n",
    });
    const tarball = await createTarGzFromDir(contentDir);

    await withEnvMap({
      TURBOPANEL_DEV_INSTANCE: undefined,
      TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
    }, async () => {
      await applyDevSyncTarball(tarball);
    });

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// synced checkout\n");
    const newFile = await Deno.readTextFile(join(fixture.daemonRoot, "src/new.ts"));
    assertEquals(newFile, "export const v = 1;\n");

    let staleExists = true;
    try {
      await Deno.stat(join(fixture.daemonRoot, "stale-upstream.ts"));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) staleExists = false;
      else throw err;
    }
    assertEquals(staleExists, false);

    for (const name of HOST_LOCAL_ARTIFACTS) {
      await Deno.stat(join(fixture.daemonRoot, name));
    }
    const head = await Deno.readTextFile(join(fixture.daemonRoot, ".git/HEAD"));
    assertEquals(head, "ref: refs/heads/trunk\n");
    const log = await Deno.readTextFile(join(fixture.daemonRoot, "logs/daemon.log"));
    assertEquals(log, "old log line\n");

    let shippedExists = true;
    try {
      await Deno.stat(join(fixture.daemonRoot, ".git/shipped"));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) shippedExists = false;
      else throw err;
    }
    assertEquals(shippedExists, false);

    let stagingExists = true;
    try {
      await Deno.stat(join(fixture.parent, ".daemon-dev-sync-staging"));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) stagingExists = false;
      else throw err;
    }
    assertEquals(stagingExists, false);

    let backupExists = true;
    try {
      await Deno.stat(`${fixture.daemonRoot}.dev-sync-old`);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) backupExists = false;
      else throw err;
    }
    assertEquals(backupExists, false);
  } finally {
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball rejects tarballs that fail extraction", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const restoreCommand = installCommandMock((call) => {
    if (call.cmd === "tar") {
      return { success: false, stderr: "bogus archive" };
    }
    return { success: true };
  });
  try {
    await assertRejects(
      async () =>
        await withEnvMap({
          TURBOPANEL_DEV_INSTANCE: undefined,
          TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
        }, async () => await applyDevSyncTarball(new Uint8Array([0x00, 0x01, 0x02]))),
      Error,
      "tar extract failed: bogus archive",
    );

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// old checkout\n");
  } finally {
    restoreCommand();
    await restoreCwd(originalCwd);
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball rejects archives missing main.ts", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(contentDir, "README.md"), "no main\n");
    const tarball = await createTarGzFromDir(contentDir);

    await assertRejects(
      async () =>
        await withEnvMap({
          TURBOPANEL_DEV_INSTANCE: undefined,
          TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
        }, async () => await applyDevSyncTarball(tarball)),
      Error,
      "dev-sync archive did not contain main.ts",
    );

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// old checkout\n");
  } finally {
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball logs deno cache warnings without aborting", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  const originalCommand = Deno.Command;
  Deno.Command = class {
    #cmd: string;
    #opts: Deno.CommandOptions;
    constructor(cmd: string, opts: Deno.CommandOptions) {
      this.#cmd = cmd;
      this.#opts = opts;
    }
    output() {
      if (this.#cmd === Deno.execPath()) {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("cache warming failed"),
        });
      }
      return new originalCommand(this.#cmd, this.#opts).output();
    }
  } as unknown as typeof Deno.Command;
  try {
    await writeTree(contentDir, { "main.ts": "// cache warn path\n" });
    const tarball = await createTarGzFromDir(contentDir);

    await withEnvMap({
      TURBOPANEL_DEV_INSTANCE: undefined,
      TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
    }, async () => {
      await applyDevSyncTarball(tarball);
    });

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// cache warn path\n");
  } finally {
    Deno.Command = originalCommand;
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball skips deno cache when execPath spawn throws", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  const originalCommand = Deno.Command;
  Deno.Command = class {
    #cmd: string;
    #opts: Deno.CommandOptions;
    constructor(cmd: string, opts: Deno.CommandOptions) {
      this.#cmd = cmd;
      this.#opts = opts;
      if (cmd === Deno.execPath()) {
        throw new Error("command construct failed");
      }
    }
    output() {
      return new originalCommand(this.#cmd, this.#opts).output();
    }
  } as unknown as typeof Deno.Command;
  try {
    await writeTree(contentDir, { "main.ts": "// cache skipped\n" });
    const tarball = await createTarGzFromDir(contentDir);

    await withEnvMap({
      TURBOPANEL_DEV_INSTANCE: undefined,
      TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
    }, async () => {
      await applyDevSyncTarball(tarball);
    });

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// cache skipped\n");
  } finally {
    Deno.Command = originalCommand;
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball syncs when no host-local artifacts are present", async () => {
  const parent = await Deno.makeTempDir({ prefix: "dev-sync-minimal-" });
  const daemonRoot = join(parent, "turbopaneld");
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(daemonRoot);
    await Deno.writeTextFile(join(daemonRoot, "main.ts"), "// bare checkout\n");
    await writeTree(contentDir, { "main.ts": "// synced bare\n" });
    const tarball = await createTarGzFromDir(contentDir);

    await withEnvMap({
      TURBOPANEL_DEV_INSTANCE: undefined,
      TURBOPANEL_DAEMON_ROOT: daemonRoot,
    }, async () => {
      await applyDevSyncTarball(tarball);
    });

    const main = await Deno.readTextFile(join(daemonRoot, "main.ts"));
    assertEquals(main, "// synced bare\n");
  } finally {
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await Deno.remove(parent, { recursive: true });
  }
});

test("applyDevSyncTarball falls back to / when parent chdir fails", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  const originalChdir = Deno.chdir.bind(Deno);
  const chdirPaths: string[] = [];
  try {
    await writeTree(contentDir, { "main.ts": "// chdir fallback\n" });
    const tarball = await createTarGzFromDir(contentDir);

    Deno.chdir = (path: string | URL) => {
      const target = typeof path === "string" ? path : path.toString();
      chdirPaths.push(target);
      if (target === dirname(fixture.daemonRoot)) {
        throw new Error("parent chdir blocked");
      }
      return originalChdir(path);
    };

    await withEnvMap({
      TURBOPANEL_DEV_INSTANCE: undefined,
      TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
    }, async () => {
      await applyDevSyncTarball(tarball);
    });

    assertEquals(chdirPaths.includes("/"), true);
    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// chdir fallback\n");
  } finally {
    Deno.chdir = originalChdir;
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball tolerates chmod/stat failures during tree swap", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  const originalStat = Deno.stat.bind(Deno);
  try {
    await writeTree(contentDir, { "main.ts": "// stat tolerant\n" });
    const tarball = await createTarGzFromDir(contentDir);

    Deno.stat = async (path: string | URL) => {
      const target = typeof path === "string" ? path : path.toString();
      if (target === fixture.daemonRoot) {
        throw new Error("stat blocked");
      }
      return await originalStat(path);
    };

    await withEnvMap({
      TURBOPANEL_DEV_INSTANCE: undefined,
      TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
    }, async () => {
      await applyDevSyncTarball(tarball);
    });

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// stat tolerant\n");
  } finally {
    Deno.stat = originalStat;
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball rethrows unexpected pathExists errors", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  const originalLstat = Deno.lstat.bind(Deno);
  try {
    await writeTree(contentDir, { "main.ts": "// should not land\n" });
    const tarball = await createTarGzFromDir(contentDir);

    Deno.lstat = async (path: string | URL) => {
      const target = typeof path === "string" ? path : path.toString();
      if (target.endsWith("/.git")) {
        throw new Deno.errors.PermissionDenied("blocked");
      }
      return await originalLstat(path);
    };

    await assertRejects(
      async () =>
        await withEnvMap({
          TURBOPANEL_DEV_INSTANCE: undefined,
          TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
        }, async () => await applyDevSyncTarball(tarball)),
      Deno.errors.PermissionDenied,
      "blocked",
    );

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// old checkout\n");
  } finally {
    Deno.lstat = originalLstat;
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});

test("applyDevSyncTarball restores checkout when swap-in rename fails", async () => {
  const fixture = await createCheckoutFixture();
  const originalCwd = Deno.cwd();
  const contentDir = await Deno.makeTempDir();
  const originalRename = Deno.rename.bind(Deno);
  const stagingPath = join(fixture.parent, ".daemon-dev-sync-staging");
  try {
    await writeTree(contentDir, { "main.ts": "// should not land\n" });
    const tarball = await createTarGzFromDir(contentDir);

    Deno.rename = async (from: string | URL, to: string | URL) => {
      const fromPath = typeof from === "string" ? from : from.toString();
      const toPath = typeof to === "string" ? to : to.toString();
      if (fromPath === stagingPath && toPath === fixture.daemonRoot) {
        throw new Error("simulated swap-in failure");
      }
      return await originalRename(from, to);
    };

    await assertRejects(
      async () =>
        await withEnvMap({
          TURBOPANEL_DEV_INSTANCE: undefined,
          TURBOPANEL_DAEMON_ROOT: fixture.daemonRoot,
        }, async () => await applyDevSyncTarball(tarball)),
      Error,
      "simulated swap-in failure",
    );

    const main = await Deno.readTextFile(join(fixture.daemonRoot, "main.ts"));
    assertEquals(main, "// old checkout\n");
  } finally {
    Deno.rename = originalRename;
    await restoreCwd(originalCwd);
    await Deno.remove(contentDir, { recursive: true });
    await fixture.cleanup();
  }
});
