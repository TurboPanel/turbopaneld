import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import {
  resolveInstanceConfigDir,
  resolveInstanceRuntimeEnvPath,
  upsertPublicUrlsInEnv,
} from "./public-urls-env.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "upsertPublicUrlsInEnv creates TURBOPANEL_PUBLIC_URLS on missing file",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-" });
    try {
      const runtimeEnvPath = join(tmpDir, "runtime.env");
      await upsertPublicUrlsInEnv(["https://a.example"], { runtimeEnvPath });
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(content, "TURBOPANEL_PUBLIC_URLS=https://a.example\n");
      const stat = await Deno.stat(runtimeEnvPath);
      assertEquals(stat.mode! & 0o777, 0o640);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name:
    "upsertPublicUrlsInEnv replaces target line in place without duplicates",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-" });
    try {
      const runtimeEnvPath = join(tmpDir, "runtime.env");
      await Deno.writeTextFile(
        runtimeEnvPath,
        [
          "FOO=1",
          "TURBOPANEL_PUBLIC_URLS=https://old.example",
          "BAR=2",
          "",
        ].join("\n"),
      );
      await upsertPublicUrlsInEnv(["https://new.example"], { runtimeEnvPath });
      const lines = (await Deno.readTextFile(runtimeEnvPath)).split("\n");
      assertEquals(lines[0], "FOO=1");
      assertEquals(lines[1], "TURBOPANEL_PUBLIC_URLS=https://new.example");
      assertEquals(lines[2], "BAR=2");
      assertEquals(
        lines.filter((line) => line.startsWith("TURBOPANEL_PUBLIC_URLS="))
          .length,
        1,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv comma-joins multiple URLs",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-" });
    try {
      const runtimeEnvPath = join(tmpDir, "runtime.env");
      const urls = ["https://a.example", "https://b.example"];
      await upsertPublicUrlsInEnv(urls, { runtimeEnvPath });
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(
        content.includes(`TURBOPANEL_PUBLIC_URLS=${urls.join(",")}`),
        true,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv preserves existing file mode",
  permissions: { read: true, write: true },
  fn: async () => {
    // uid/gid chown assertions require root — skipped; mode covers meta?.mode.
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-" });
    try {
      const runtimeEnvPath = join(tmpDir, "runtime.env");
      await Deno.writeTextFile(runtimeEnvPath, "KEEP=1\n", { mode: 0o600 });
      await Deno.chmod(runtimeEnvPath, 0o600);
      await upsertPublicUrlsInEnv(["https://c.example"], { runtimeEnvPath });
      const stat = await Deno.stat(runtimeEnvPath);
      assertEquals(stat.mode! & 0o777, 0o600);
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(content.includes("KEEP=1"), true);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://c.example"),
        true,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test("resolveInstanceConfigDir and runtime env path compose layout", () => {
  const env = { TURBOPANEL_CONFIG_DIR: "/custom/config" };
  const layout = resolveLayout(env);
  assertEquals(resolveInstanceConfigDir(env), layout.instanceConfigDir);
  assertEquals(
    resolveInstanceRuntimeEnvPath(env),
    join(layout.instanceConfigDir, "runtime.env"),
  );
});

test({
  name:
    "upsertPublicUrlsInEnv falls back to mocked sudo install on PermissionDenied",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-pd-" });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(runtimeEnvPath, "KEEP=1\n", { mode: 0o640 });

    const OriginalCommand = Deno.Command;
    const sudoArgLists: string[][] = [];
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class MockCommand {
      #args: string[];
      constructor(cmd: string, options?: { args?: string[] }) {
        if (cmd !== "sudo") {
          throw new TypeError(`unexpected command: ${cmd}`);
        }
        this.#args = options?.args ?? [];
      }
      output(): Promise<Deno.CommandOutput> {
        sudoArgLists.push([...this.#args]);
        // Mimic `sudo install … staging dest` by copying the staged file.
        const args = this.#args;
        if (args[0] === "-n" && args[1] === "install" && args.length >= 4) {
          const staging = args.at(-2)!;
          const dest = args.at(-1)!;
          if (args.includes("-d")) {
            // directory ensure — no-op for the already-created configDir
            return Promise.resolve({
              success: true,
              code: 0,
              signal: null,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          }
          const bytes = Deno.readFileSync(staging);
          Deno.writeFileSync(dest, bytes);
        }
        return Promise.resolve({
          success: true,
          code: 0,
          signal: null,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
    };

    const originalWriteTextFile = Deno.writeTextFile;
    Deno.writeTextFile = ((
      path: string | URL,
      data: string | ReadableStream<string>,
      options?: Deno.WriteFileOptions,
    ) => {
      const p = String(path);
      if (p.includes(".write-tmp") || p.includes("/write-")) {
        return Promise.reject(
          new Deno.errors.PermissionDenied("mocked unprivileged write"),
        );
      }
      return originalWriteTextFile.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;

    try {
      await upsertPublicUrlsInEnv(["https://pd.example"], { runtimeEnvPath });
      assertEquals(sudoArgLists.length >= 1, true);
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(content.includes("KEEP=1"), true);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://pd.example"),
        true,
      );
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = OriginalCommand;
      Deno.writeTextFile = originalWriteTextFile;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv sudo failure surfaces stderr",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "tp-public-urls-sudo-fail-",
    });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true });

    const OriginalCommand = Deno.Command;
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class MockCommand {
      output(): Promise<Deno.CommandOutput> {
        return Promise.resolve({
          success: false,
          code: 1,
          signal: null,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("sudo mocked failure\n"),
        });
      }
    };
    const originalWriteTextFile = Deno.writeTextFile;
    Deno.writeTextFile = ((
      path: string | URL,
      data: string | ReadableStream<string>,
      options?: Deno.WriteFileOptions,
    ) => {
      if (
        String(path).includes(".write-tmp") || String(path).includes("/write-")
      ) {
        return Promise.reject(
          new Deno.errors.PermissionDenied("mocked"),
        );
      }
      return originalWriteTextFile.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;

    try {
      let message = "";
      try {
        await upsertPublicUrlsInEnv(["https://fail.example"], {
          runtimeEnvPath,
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assertEquals(message.includes("sudo mocked failure"), true);
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = OriginalCommand;
      Deno.writeTextFile = originalWriteTextFile;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv falls back to sudo chown on PermissionDenied",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-chown-" });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(runtimeEnvPath, "KEEP=1\n", { mode: 0o640 });
    const meta = await Deno.stat(runtimeEnvPath);
    if (meta.uid === undefined || meta.gid === undefined) {
      throw new TypeError("expected uid/gid on runtime.env for chown test");
    }

    const OriginalCommand = Deno.Command;
    const sudoArgLists: string[][] = [];
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class MockCommand {
      #args: string[];
      constructor(cmd: string, options?: { args?: string[] }) {
        if (cmd !== "sudo") {
          throw new TypeError(`unexpected command: ${cmd}`);
        }
        this.#args = options?.args ?? [];
      }
      output(): Promise<Deno.CommandOutput> {
        sudoArgLists.push([...this.#args]);
        return Promise.resolve({
          success: true,
          code: 0,
          signal: null,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
    };

    const originalChown = Deno.chown;
    Deno.chown = ((_path, _uid, _gid) =>
      Promise.reject(
        new Deno.errors.PermissionDenied("mocked chown"),
      )) as typeof Deno.chown;

    try {
      await upsertPublicUrlsInEnv(["https://chown.example"], {
        runtimeEnvPath,
      });
      assertEquals(sudoArgLists.length >= 1, true);
      const chownCall = sudoArgLists.find((args) =>
        args[0] === "-n" && args[1] === "chown"
      );
      assertEquals(chownCall !== undefined, true);
      assertEquals(
        chownCall?.[2],
        `${meta.uid}:${meta.gid}`,
      );
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(content.includes("KEEP=1"), true);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://chown.example"),
        true,
      );
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = OriginalCommand;
      Deno.chown = originalChown;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv rethrows non-PermissionDenied chown errors",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "tp-public-urls-chown-err-",
    });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(runtimeEnvPath, "KEEP=1\n", { mode: 0o640 });

    const originalChown = Deno.chown;
    Deno.chown = ((_path, _uid, _gid) =>
      Promise.reject(new Error("chown blew up"))) as typeof Deno.chown;

    try {
      let message = "";
      try {
        await upsertPublicUrlsInEnv(["https://chown-err.example"], {
          runtimeEnvPath,
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assertEquals(message.includes("chown blew up"), true);
    } finally {
      Deno.chown = originalChown;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name:
    "upsertPublicUrlsInEnv privileged install derives parent gid when meta lacks owner",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "tp-public-urls-priv-gid-",
    });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
    // No existing runtime.env → meta is null (no uid/gid on install).

    const OriginalCommand = Deno.Command;
    const sudoArgLists: string[][] = [];
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class MockCommand {
      #args: string[];
      constructor(cmd: string, options?: { args?: string[] }) {
        if (cmd !== "sudo") {
          throw new TypeError(`unexpected command: ${cmd}`);
        }
        this.#args = options?.args ?? [];
      }
      output(): Promise<Deno.CommandOutput> {
        sudoArgLists.push([...this.#args]);
        const args = this.#args;
        if (args[0] === "-n" && args[1] === "install" && args.length >= 4) {
          if (args.includes("-d")) {
            return Promise.resolve({
              success: true,
              code: 0,
              signal: null,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          }
          const staging = args.at(-2)!;
          const dest = args.at(-1)!;
          const bytes = Deno.readFileSync(staging);
          Deno.writeFileSync(dest, bytes);
          // Staging already gone → removeTempFile NotFound path.
          try {
            Deno.removeSync(staging);
          } catch {
            // ignore
          }
        }
        return Promise.resolve({
          success: true,
          code: 0,
          signal: null,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
    };

    const originalWriteTextFile = Deno.writeTextFile;
    Deno.writeTextFile = ((
      path: string | URL,
      data: string | ReadableStream<string>,
      options?: Deno.WriteFileOptions,
    ) => {
      const p = String(path);
      if (p.includes(".write-tmp") || p.includes("/write-")) {
        return Promise.reject(
          new Deno.errors.PermissionDenied("mocked unprivileged write"),
        );
      }
      return originalWriteTextFile.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;

    try {
      await upsertPublicUrlsInEnv(["https://priv-gid.example"], {
        runtimeEnvPath,
      });
      const fileInstall = sudoArgLists.find((args) =>
        args[0] === "-n" && args[1] === "install" && !args.includes("-d")
      );
      assertEquals(fileInstall !== undefined, true);
      assertEquals(fileInstall?.includes("-o"), true);
      assertEquals(fileInstall?.includes("0"), true);
      assertEquals(fileInstall?.includes("-g"), true);
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://priv-gid.example"),
        true,
      );
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = OriginalCommand;
      Deno.writeTextFile = originalWriteTextFile;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv rethrows non-PermissionDenied write errors",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "tp-public-urls-write-err-",
    });
    const runtimeEnvPath = join(tmpDir, "runtime.env");

    const originalWriteTextFile = Deno.writeTextFile;
    Deno.writeTextFile = ((
      path: string | URL,
      data: string | ReadableStream<string>,
      options?: Deno.WriteFileOptions,
    ) => {
      if (
        String(path).includes(".write-tmp") || String(path).includes("/write-")
      ) {
        return Promise.reject(new Error("disk full"));
      }
      return originalWriteTextFile.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;

    try {
      let message = "";
      try {
        await upsertPublicUrlsInEnv(["https://write-err.example"], {
          runtimeEnvPath,
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assertEquals(message.includes("disk full"), true);
    } finally {
      Deno.writeTextFile = originalWriteTextFile;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv tolerates missing uid/gid on existing env meta",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "tp-public-urls-null-uid-",
    });
    const runtimeEnvPath = join(tmpDir, "runtime.env");
    await Deno.writeTextFile(runtimeEnvPath, "KEEP=1\n", { mode: 0o640 });

    const originalStat = Deno.stat;
    Deno.stat = ((path: string | URL) => {
      if (String(path) === runtimeEnvPath) {
        return Promise.resolve({
          isFile: true,
          isDirectory: false,
          isSymlink: false,
          size: 8,
          mtime: null,
          atime: null,
          birthtime: null,
          ctime: null,
          dev: 0,
          ino: 0,
          mode: 0o640,
          nlink: 1,
          uid: null,
          gid: null,
          rdev: 0,
          blksize: 0,
          blocks: 0,
          isBlockDevice: false,
          isCharDevice: false,
          isFifo: false,
          isSocket: false,
        } as unknown as Deno.FileInfo);
      }
      return originalStat.call(Deno, path);
    }) as typeof Deno.stat;

    try {
      await upsertPublicUrlsInEnv(["https://null-uid.example"], {
        runtimeEnvPath,
      });
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(content.includes("KEEP=1"), true);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://null-uid.example"),
        true,
      );
    } finally {
      Deno.stat = originalStat;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv rethrows unexpected stat errors on existing env",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "tp-public-urls-stat-err-",
    });
    const runtimeEnvPath = join(tmpDir, "runtime.env");
    await Deno.writeTextFile(runtimeEnvPath, "KEEP=1\n");

    const originalStat = Deno.stat;
    Deno.stat = ((path: string | URL) => {
      if (String(path) === runtimeEnvPath) {
        return Promise.reject(new Error("stat blew up"));
      }
      return originalStat.call(Deno, path);
    }) as typeof Deno.stat;

    try {
      let message = "";
      try {
        await upsertPublicUrlsInEnv(["https://stat-err.example"], {
          runtimeEnvPath,
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assertEquals(message.includes("stat blew up"), true);
    } finally {
      Deno.stat = originalStat;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name:
    "upsertPublicUrlsInEnv privileged install tolerates parent stat failure",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "tp-public-urls-parent-stat-",
    });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });

    const OriginalCommand = Deno.Command;
    const sudoArgLists: string[][] = [];
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class MockCommand {
      #args: string[];
      constructor(cmd: string, options?: { args?: string[] }) {
        if (cmd !== "sudo") {
          throw new TypeError(`unexpected command: ${cmd}`);
        }
        this.#args = options?.args ?? [];
      }
      output(): Promise<Deno.CommandOutput> {
        sudoArgLists.push([...this.#args]);
        const args = this.#args;
        if (args[0] === "-n" && args[1] === "install" && !args.includes("-d")) {
          const staging = args.at(-2)!;
          const dest = args.at(-1)!;
          Deno.writeFileSync(dest, Deno.readFileSync(staging));
        }
        return Promise.resolve({
          success: true,
          code: 0,
          signal: null,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
    };

    const originalWriteTextFile = Deno.writeTextFile;
    Deno.writeTextFile = ((
      path: string | URL,
      data: string | ReadableStream<string>,
      options?: Deno.WriteFileOptions,
    ) => {
      const p = String(path);
      if (p.includes(".write-tmp") || p.includes("/write-")) {
        return Promise.reject(
          new Deno.errors.PermissionDenied("mocked unprivileged write"),
        );
      }
      return originalWriteTextFile.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;

    const originalStat = Deno.stat;
    Deno.stat = ((path: string | URL) => {
      if (String(path) === configDir) {
        return Promise.reject(new Deno.errors.NotFound("parent gone"));
      }
      return originalStat.call(Deno, path);
    }) as typeof Deno.stat;

    try {
      await upsertPublicUrlsInEnv(["https://parent-stat.example"], {
        runtimeEnvPath,
      });
      const fileInstall = sudoArgLists.find((args) =>
        args[0] === "-n" && args[1] === "install" && !args.includes("-d")
      );
      assertEquals(fileInstall !== undefined, true);
      // Parent stat failed → no -o/-g owner flags.
      assertEquals(fileInstall?.includes("-o"), false);
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://parent-stat.example"),
        true,
      );
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = OriginalCommand;
      Deno.writeTextFile = originalWriteTextFile;
      Deno.stat = originalStat;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test({
  name: "upsertPublicUrlsInEnv rethrows unexpected temp cleanup errors",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-rm-err-" });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true });

    const OriginalCommand = Deno.Command;
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class MockCommand {
      #args: string[];
      constructor(cmd: string, options?: { args?: string[] }) {
        if (cmd !== "sudo") {
          throw new TypeError(`unexpected command: ${cmd}`);
        }
        this.#args = options?.args ?? [];
      }
      output(): Promise<Deno.CommandOutput> {
        const args = this.#args;
        if (args[0] === "-n" && args[1] === "install" && !args.includes("-d")) {
          const staging = args.at(-2)!;
          const dest = args.at(-1)!;
          Deno.writeFileSync(dest, Deno.readFileSync(staging));
        }
        return Promise.resolve({
          success: true,
          code: 0,
          signal: null,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
    };

    const originalWriteTextFile = Deno.writeTextFile;
    Deno.writeTextFile = ((
      path: string | URL,
      data: string | ReadableStream<string>,
      options?: Deno.WriteFileOptions,
    ) => {
      const p = String(path);
      if (p.includes(".write-tmp") || p.includes("/write-")) {
        return Promise.reject(
          new Deno.errors.PermissionDenied("mocked unprivileged write"),
        );
      }
      return originalWriteTextFile.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;

    const originalRemove = Deno.remove;
    Deno.remove = ((path: string | URL, options?: Deno.RemoveOptions) => {
      const p = String(path);
      if (p.includes("tp-runtime-env-")) {
        return Promise.reject(new Error("cleanup failed"));
      }
      return originalRemove.call(Deno, path, options);
    }) as typeof Deno.remove;

    try {
      let message = "";
      try {
        await upsertPublicUrlsInEnv(["https://rm-err.example"], {
          runtimeEnvPath,
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assertEquals(message.includes("cleanup failed"), true);
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = OriginalCommand;
      Deno.writeTextFile = originalWriteTextFile;
      Deno.remove = originalRemove;
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
