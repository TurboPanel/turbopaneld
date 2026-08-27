import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../../paths/layout.ts";
import { withTempLayout } from "../../testing/temp-layout.ts";
import {
  APACHE_DRIVER,
  CADDY_DRIVER,
  phpFpmDriver,
  publishStagedConfig,
  rolloutSiteConfigs,
  type SiteRunFn,
  type SiteRunResult,
  stageDaemonConfigFile,
  type StagedConfigWrite,
  stageOwnedConfigFile,
  systemctlReloadOrStart,
  writeOwnedConfigFile,
} from "./engine-driver.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function ok(): SiteRunResult {
  return { success: true, stdout: "", stderr: "" };
}

function fail(stderr = ""): SiteRunResult {
  return { success: false, stdout: "", stderr };
}

test({
  name: "writeOwnedConfigFile skips install when cmp reports a match",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const path = join(fixture.dirs.configDir, "site.conf");
      const calls: string[][] = [];
      const run: SiteRunFn = (command, args) => {
        calls.push([command, ...args]);
        return Promise.resolve(ok());
      };
      assertEquals(
        await writeOwnedConfigFile(run, path, "same\n", "tpnginx"),
        false,
      );
      assertEquals(calls[0]?.includes("cmp"), true);
      assertEquals(calls.some((c) => c.includes("install")), false);
    });
  },
});

test({
  name: "writeOwnedConfigFile throws when privileged install fails",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const path = join(fixture.dirs.configDir, "site.conf");
      const run: SiteRunFn = (_command, args) => {
        if (args.includes("cmp")) return Promise.resolve(fail());
        return Promise.resolve(fail("install denied"));
      };
      await assertRejects(
        () => writeOwnedConfigFile(run, path, "next\n", "tpnginx"),
        Error,
        "install denied",
      );
    });
  },
});

test({
  name: "writeOwnedConfigFile uses a generic error when install is silent",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const path = join(fixture.dirs.configDir, "site.conf");
      const run: SiteRunFn = (_command, args) => {
        if (args.includes("cmp")) return Promise.resolve(fail());
        return Promise.resolve(fail());
      };
      await assertRejects(
        () => writeOwnedConfigFile(run, path, "next\n", "tpnginx"),
        Error,
        `Failed to install config ${path}`,
      );
    });
  },
});

test({
  name: "stageOwnedConfigFile throws when staging install fails",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const path = join(fixture.dirs.configDir, "site.conf");
      const run: SiteRunFn = (_command, args) => {
        if (args.includes("cmp")) return Promise.resolve(fail());
        if (args.includes("install")) {
          return Promise.resolve(fail("stage denied"));
        }
        return Promise.resolve(ok());
      };
      await assertRejects(
        () => stageOwnedConfigFile(run, path, "next\n", "tpnginx"),
        Error,
        "stage denied",
      );
    });
  },
});

test({
  name: "stageOwnedConfigFile uses a generic error when staging is silent",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const path = join(fixture.dirs.configDir, "site.conf");
      const run: SiteRunFn = (_command, args) => {
        if (args.includes("cmp")) return Promise.resolve(fail());
        if (args.includes("install")) return Promise.resolve(fail());
        return Promise.resolve(ok());
      };
      await assertRejects(
        () => stageOwnedConfigFile(run, path, "next\n", "tpnginx"),
        Error,
        `Failed to stage config ${path}`,
      );
    });
  },
});

test({
  name: "stageDaemonConfigFile returns null when the live file already matches",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const path = join(fixture.dirs.configDir, "vhconf.conf");
      await Deno.writeTextFile(path, "same\n");
      assertEquals(await stageDaemonConfigFile(path, "same\n"), null);
    });
  },
});

test({
  name: "publishStagedConfig throws when a privileged mv fails",
  permissions: { read: true, write: true },
  fn: async () => {
    const staged: StagedConfigWrite = {
      kind: "owned",
      path: "/etc/nginx/sites/x.conf",
      candidatePath: "/etc/nginx/sites/x.conf.tpnew",
      previousPath: null,
      published: false,
    };
    const run: SiteRunFn = () => Promise.resolve(fail("mv denied"));
    await assertRejects(
      () => publishStagedConfig(run, staged),
      Error,
      "mv denied",
    );
  },
});

test({
  name: "publishStagedConfig uses a generic error when mv is silent",
  permissions: { read: true, write: true },
  fn: async () => {
    const staged: StagedConfigWrite = {
      kind: "owned",
      path: "/etc/nginx/sites/x.conf",
      candidatePath: "/etc/nginx/sites/x.conf.tpnew",
      previousPath: null,
      published: false,
    };
    const run: SiteRunFn = () => Promise.resolve(fail());
    await assertRejects(
      () => publishStagedConfig(run, staged),
      Error,
      "Failed to install config /etc/nginx/sites/x.conf",
    );
  },
});

test({
  name: "engine configTest helpers use a generic message when stderr is empty",
  permissions: { read: true, env: true },
  fn: async () => {
    const layout = resolveLayout({}, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const silent: SiteRunFn = () => Promise.resolve(fail());
    await assertRejects(
      () => APACHE_DRIVER.configTest(silent, layout),
      Error,
      "httpd -t failed",
    );
    await assertRejects(
      () => CADDY_DRIVER.configTest(silent, layout),
      Error,
      "caddy validate failed",
    );
    await assertRejects(
      () => phpFpmDriver("8.4").configTest(silent, layout),
      Error,
      "php-fpm 8.4 --test failed",
    );
  },
});

test("systemctlReloadOrStart falls back to enable --now then a generic error", async () => {
  const run: SiteRunFn = () => Promise.resolve(fail());
  await assertRejects(
    () => systemctlReloadOrStart(run, "turbopanel-nginx", false, "nginx"),
    Error,
    "Failed to reload/start nginx",
  );
});

test({
  name: "rolloutSiteConfigs rolls back when restore of a published file throws",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const live = join(fixture.dirs.configDir, "vh.conf");
      const candidate = `${live}.tpnew`;
      await Deno.writeTextFile(candidate, "next\n");
      const staged: StagedConfigWrite = {
        kind: "daemon",
        path: live,
        candidatePath: candidate,
        previousPath: join(fixture.dirs.configDir, "missing.tpprev"),
        published: false,
      };
      await assertRejects(
        () =>
          rolloutSiteConfigs({
            run: () => Promise.resolve(ok()),
            layout,
            target: {
              label: "OpenLiteSpeed",
              unit: "turbopanel-openlitespeed",
              configTest: () => Promise.reject(new Error("bad config")),
            },
            restart: false,
            staged: [staged],
          }),
        Error,
        "bad config",
      );
    });
  },
});
