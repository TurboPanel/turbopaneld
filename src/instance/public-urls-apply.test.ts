import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/paths.ts";
import { PROD_INSTANCE_DIR_DEFAULT } from "../paths/layout.ts";
import {
  applyPublicUrls,
  resolveInstanceDir,
  runInstanceCertsApply,
  upsertPublicUrlsInEnv,
} from "./public-urls-apply.ts";

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

test("resolveInstanceDir treats TURBOPANEL_DEV_USER as co-located", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_DEV_USER: "dev",
      TURBOPANEL_DEV_ROOT: "/home/dev",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir treats TURBOPANEL_DEV_INSTANCE=1 as co-located", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_DEV_INSTANCE: "1",
      TURBOPANEL_DEV_ROOT: "/home/dev",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir strips repeated trailing slashes including root-only", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_INSTANCE_DIR: "////",
    }),
    "/",
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

test({
  name: "runInstanceCertsApply builds playbook extras via stubbed runPlaybook",
  permissions: { env: true },
  fn: async () => {
    const originalDevUser = Deno.env.get("TURBOPANEL_DEV_USER");
    const originalDevRoot = Deno.env.get("TURBOPANEL_DEV_ROOT");
    Deno.env.set("TURBOPANEL_DEV_USER", "dev");
    Deno.env.set("TURBOPANEL_DEV_ROOT", "/home/dev");
    const calls: Array<{ playbook: string; args: string[] }> = [];
    try {
      await runInstanceCertsApply("/home/dev/turbopanel", [
        "https://a.example",
        "https://b.example",
      ], {
        runPlaybook: (playbook, extraArgs = []) => {
          calls.push({ playbook, args: [...extraArgs] });
          return Promise.resolve();
        },
      });
      assertEquals(calls.length, 1);
      assertEquals(calls[0]!.playbook, INSTANCE_CERTS_APPLY_PLAYBOOK);
      assertEquals(
        calls[0]!.args.includes("turbopanel_instance_dir=/home/dev/turbopanel"),
        true,
      );
      assertEquals(
        calls[0]!.args.includes(
          "turbopanel_public_urls=https://a.example,https://b.example",
        ),
        true,
      );
      assertEquals(
        calls[0]!.args.includes("turbopanel_dev_user=dev"),
        true,
      );
    } finally {
      if (originalDevUser === undefined) Deno.env.delete("TURBOPANEL_DEV_USER");
      else Deno.env.set("TURBOPANEL_DEV_USER", originalDevUser);
      if (originalDevRoot === undefined) Deno.env.delete("TURBOPANEL_DEV_ROOT");
      else Deno.env.set("TURBOPANEL_DEV_ROOT", originalDevRoot);
    }
  },
});

test({
  name: "applyPublicUrls upserts env then invokes certs apply stub",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-apply-urls-" });
    const originalConfigDir = Deno.env.get("TURBOPANEL_CONFIG_DIR");
    const originalInstanceDir = Deno.env.get("TURBOPANEL_INSTANCE_DIR");
    Deno.env.set("TURBOPANEL_INSTANCE_DIR", join(root, "instance-src"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
    await Deno.mkdir(join(root, "instance"), { recursive: true });

    const certCalls: Array<{ dir: string; urls: string[] }> = [];
    try {
      await applyPublicUrls(["https://apply.example"], {
        runCertsApply: (instanceDir, urls) => {
          certCalls.push({ dir: instanceDir, urls: [...urls] });
          return Promise.resolve();
        },
      });
      const expectedEnv = join(root, "instance", "runtime.env");
      const content = await Deno.readTextFile(expectedEnv);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://apply.example"),
        true,
      );
      assertEquals(certCalls.length, 1);
      assertEquals(certCalls[0]!.dir, join(root, "instance-src"));
      assertEquals(certCalls[0]!.urls, ["https://apply.example"]);
    } finally {
      if (originalConfigDir === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", originalConfigDir);
      }
      if (originalInstanceDir === undefined) {
        Deno.env.delete("TURBOPANEL_INSTANCE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_INSTANCE_DIR", originalInstanceDir);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});
