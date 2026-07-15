import { assertEquals } from "jsr:@std/assert";
import { join } from "@std/path";
import { upsertPublicUrlsInEnv } from "./public-urls-env.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

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
  const checkoutDir = join(root, "checkout", "instance");
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
  const checkoutDir = join(root, "checkout", "instance");
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
