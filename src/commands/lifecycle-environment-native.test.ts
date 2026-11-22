import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { RUNTIME_COMPOSE_FILENAME } from "../deploy/compose-files.ts";
import {
  writePhpRuntimeRecord,
  writePhpSharedSiteRecord,
} from "../deploy/site/php-patch-restart.ts";
import type { EnvironmentLifecyclePayload } from "../contracts/commands-contracts.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV_ID = "envnative1";
const OTHER_ENV_ID = "envnative2";

type RunCall = { command: string; args: string[] };

/** A native-only host: no Docker, a runtime compose file with no services. */
async function withNativeHost(
  body: (ctx: { stateDir: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-lifecycle-native-" });
  const keys = ["TURBOPANEL_STATE_DIR", "TURBOPANEL_CONFIG_DIR"] as const;
  const previous = keys.map((key) => Deno.env.get(key));
  const stateDir = join(root, "state");
  Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  try {
    const deploymentDir = join(stateDir, "deployments", "proj-1", ENV_ID);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services: {}\n",
      { mode: 0o640 },
    );
    await writePhpRuntimeRecord({ stateDir }, {
      id: "fcgi-site-aaaaaaaaaaaa",
      series: "8.4",
      mode: "fastcgi",
      environmentId: ENV_ID,
      composeServiceName: "web",
      probeUrl: "http://127.0.0.1:1/",
    });
    await writePhpRuntimeRecord({ stateDir }, {
      id: "fpm-site-bbbbbbbbbbbb",
      series: "8.4",
      mode: "fpm",
      environmentId: ENV_ID,
      composeServiceName: "api",
      probeUrl: "http://127.0.0.1:2/",
    });
    await writePhpRuntimeRecord({ stateDir }, {
      id: "other-site-cccccccccccc",
      series: "8.4",
      mode: "fpm",
      environmentId: OTHER_ENV_ID,
      composeServiceName: "web",
      probeUrl: "http://127.0.0.1:3/",
    });
    await writePhpSharedSiteRecord({ stateDir }, {
      environmentId: ENV_ID,
      composeServiceName: "shared",
      series: "8.3",
    });
    await writePhpSharedSiteRecord({ stateDir }, {
      environmentId: OTHER_ENV_ID,
      composeServiceName: "shared",
      series: "8.2",
    });
    await body({ stateDir });
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
    await Deno.remove(root, { recursive: true });
  }
}

function payload(
  action: EnvironmentLifecyclePayload["action"],
): EnvironmentLifecyclePayload {
  return {
    environmentId: ENV_ID,
    projectId: "proj-1",
    projectName: "tp-demo-envnativ",
    action,
  };
}

function noDockerDeps(
  calls: RunCall[],
  fail?: (args: string[]) => boolean,
) {
  return {
    dockerInstalled: () => Promise.resolve(false),
    runDocker: () => {
      throw new Error("docker must not run on a host without Docker");
    },
    runHost: (command: string, args: string[]) => {
      calls.push({ command, args });
      const failed = fail?.(args) === true;
      return Promise.resolve({
        success: !failed,
        stdout: "",
        stderr: failed ? "unit failed" : "",
      });
    },
  };
}

/** The systemctl words of each sudo call (tp-host framing dropped). */
function systemctlWords(calls: RunCall[]): string[] {
  return calls.flatMap((call) => {
    const at = call.args.indexOf("systemctl");
    return at < 0 ? [] : [call.args.slice(at + 1).join(" ")];
  });
}

const permissions = { env: true, read: true, write: true, run: true };

test({
  name:
    "handleEnvironmentLifecycle restart reloads and restarts native PHP without Docker",
  permissions,
  fn: async () => {
    await withNativeHost(async () => {
      const calls: RunCall[] = [];
      const result = await handleEnvironmentLifecycle(
        payload("restart"),
        new Date().toISOString(),
        noDockerDeps(calls),
      );
      assertEquals(result.containers, undefined);
      assertEquals(systemctlWords(calls), [
        "start turbopanel-php-fcgi-site-aaaaaaaaaaaa.socket",
        "restart turbopanel-php-fcgi-site-aaaaaaaaaaaa.service",
        "restart turbopanel-php-fpm-site-bbbbbbbbbbbb.service",
        "reload turbopanel-php-fpm@8.3",
      ]);
    });
  },
});

test({
  name:
    "handleEnvironmentLifecycle stop stops this environment's runtimes only",
  permissions,
  fn: async () => {
    await withNativeHost(async () => {
      const calls: RunCall[] = [];
      await handleEnvironmentLifecycle(
        payload("stop"),
        new Date().toISOString(),
        noDockerDeps(calls),
      );
      assertEquals(systemctlWords(calls), [
        "stop turbopanel-php-fcgi-site-aaaaaaaaaaaa.service",
        "stop turbopanel-php-fcgi-site-aaaaaaaaaaaa.socket",
        "stop turbopanel-php-fpm-site-bbbbbbbbbbbb.service",
      ]);
    });
  },
});

test({
  name: "handleEnvironmentLifecycle start brings native PHP up without Docker",
  permissions,
  fn: async () => {
    await withNativeHost(async () => {
      const calls: RunCall[] = [];
      await handleEnvironmentLifecycle(
        payload("start"),
        new Date().toISOString(),
        noDockerDeps(calls),
      );
      assertEquals(systemctlWords(calls), [
        "start turbopanel-php-fcgi-site-aaaaaaaaaaaa.socket",
        "start turbopanel-php-fcgi-site-aaaaaaaaaaaa.service",
        "start turbopanel-php-fpm-site-bbbbbbbbbbbb.service",
        "start turbopanel-php-fpm@8.3",
      ]);
    });
  },
});

test({
  name:
    "handleEnvironmentLifecycle fails a restart whose PHP unit did not restart",
  permissions,
  fn: async () => {
    await withNativeHost(async () => {
      const calls: RunCall[] = [];
      await assertRejects(
        () =>
          handleEnvironmentLifecycle(
            payload("restart"),
            new Date().toISOString(),
            noDockerDeps(
              calls,
              (args) =>
                args.includes("restart") &&
                args.includes("turbopanel-php-fpm-site-bbbbbbbbbbbb.service"),
            ),
          ),
        Error,
        "PHP restart failed",
      );
      // The other units were still tried.
      assertEquals(systemctlWords(calls).length, 4);
    });
  },
});

test({
  name:
    "handleEnvironmentLifecycle runs compose and native PHP when Docker is present",
  permissions,
  fn: async () => {
    await withNativeHost(async () => {
      const calls: RunCall[] = [];
      const dockerCalls: string[][] = [];
      await handleEnvironmentLifecycle(
        payload("restart"),
        new Date().toISOString(),
        {
          runDocker: (args) => {
            dockerCalls.push(args);
            return Promise.resolve({
              success: true,
              stdout: args.includes("ps") ? "[]" : "",
              stderr: "",
              code: 0,
            });
          },
          runHost: (command, args) => {
            calls.push({ command, args });
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          },
        },
      );
      assertEquals(dockerCalls.some((args) => args.includes("restart")), true);
      assertEquals(systemctlWords(calls), [
        "start turbopanel-php-fcgi-site-aaaaaaaaaaaa.socket",
        "restart turbopanel-php-fcgi-site-aaaaaaaaaaaa.service",
        "restart turbopanel-php-fpm-site-bbbbbbbbbbbb.service",
        "reload turbopanel-php-fpm@8.3",
      ]);
    });
  },
});
