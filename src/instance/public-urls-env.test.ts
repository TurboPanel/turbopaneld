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
    "upsertPublicUrlsInEnv falls back to sudo install when config dir is not writable",
  permissions: { read: true, write: true, run: ["sudo"] },
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-public-urls-ro-" });
    const configDir = join(tmpDir, "instance");
    const runtimeEnvPath = join(configDir, "runtime.env");
    await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(runtimeEnvPath, "KEEP=1\n", { mode: 0o640 });
    // Drop directory write so the unprivileged .write-tmp path hits EACCES —
    // mirrors /etc/turbopanel/instance (root:group 0750).
    await Deno.chmod(configDir, 0o550);

    const sudoProbe = await new Deno.Command("sudo", {
      args: ["-n", "true"],
      stdout: "null",
      stderr: "null",
    }).output();
    if (!sudoProbe.success) {
      await Deno.chmod(configDir, 0o750);
      await Deno.remove(tmpDir, { recursive: true });
      return;
    }

    try {
      await upsertPublicUrlsInEnv(["https://ro.example"], { runtimeEnvPath });
      // Restore write so we can read/assert/cleanup as the test user.
      await Deno.chmod(configDir, 0o750);
      const content = await Deno.readTextFile(runtimeEnvPath);
      assertEquals(content.includes("KEEP=1"), true);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://ro.example"),
        true,
      );
    } finally {
      try {
        await Deno.chmod(configDir, 0o750);
      } catch {
        // already restored or removed
      }
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
