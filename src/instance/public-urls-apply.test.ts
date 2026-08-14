import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { PROD_INSTANCE_DIR_DEFAULT } from "../paths/layout.ts";
import { resolveInstanceDir, upsertPublicUrlsInEnv } from "./public-urls-apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveInstanceDir uses INSTANCE_REPO checkout in development", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_MODE: "development",
      TURBOPANEL_DEV_ROOT: "/home/dev",
      TURBOPANEL_INSTANCE_REPO: "/home/dev/turbopanel",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir falls back to <devRoot>/turbopanel in development", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_MODE: "development",
      TURBOPANEL_DEV_ROOT: "/home/dev",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir uses FHS lib path when not co-located", () => {
  assertEquals(
    resolveInstanceDir({
      // No DEV_USER / INSTANCE_REPO / MODE=development → managed FHS tree.
      HOME: "/root",
      TURBOPANEL_DEV_ROOT: undefined,
    }),
    PROD_INSTANCE_DIR_DEFAULT,
  );
});

test("resolveInstanceDir honors TURBOPANEL_INSTANCE_DIR override", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_MODE: "development",
      TURBOPANEL_INSTANCE_DIR: "/custom/instance/",
      TURBOPANEL_INSTANCE_REPO: "/home/dev/turbopanel",
    }),
    "/custom/instance",
  );
});

async function listEnvTmpFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".env.tmp-")) {
      found.push(entry.name);
    }
  }
  return found;
}

test("upsertPublicUrlsInEnv writes public URLs to protected runtime env", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-public-urls-" });
  const checkoutDir = join(root, "checkout", "turbopanel");
  const configDir = join(root, "config", "instance");
  const runtimeEnvPath = join(configDir, "runtime.env");
  await Deno.mkdir(checkoutDir, { recursive: true });

  try {
    await upsertPublicUrlsInEnv(["https://panel.example.com"], {
      runtimeEnvPath,
    });

    const content = await Deno.readTextFile(runtimeEnvPath);
    assertEquals(
      content.includes("TURBOPANEL_PUBLIC_URLS=https://panel.example.com"),
      true,
    );
    assertEquals(await listEnvTmpFiles(checkoutDir), []);
    assertEquals(await listEnvTmpFiles(configDir), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("upsertPublicUrlsInEnv removes temp files when rename fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-public-urls-fail-" });
  const checkoutDir = join(root, "checkout", "turbopanel");
  const configDir = join(root, "config", "instance");
  const runtimeEnvPath = join(configDir, "runtime.env");
  await Deno.mkdir(checkoutDir, { recursive: true });
  await Deno.mkdir(runtimeEnvPath, { recursive: true });

  try {
    let threw = false;
    try {
      await upsertPublicUrlsInEnv(["https://panel.example.com"], {
        runtimeEnvPath,
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(await listEnvTmpFiles(checkoutDir), []);

    const writeTmpDir = join(configDir, ".write-tmp");
    let leftoverTmp = 0;
    try {
      for await (const entry of Deno.readDir(writeTmpDir)) {
        if (entry.name.startsWith("write-")) leftoverTmp++;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    assertEquals(leftoverTmp, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
