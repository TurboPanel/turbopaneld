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
