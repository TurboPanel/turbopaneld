import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  applyDeployCachesAndReach,
  removeEnvironmentCachesAndReach,
} from "./deploy-step.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV = "env-0123";
const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SHA = "ab".repeat(32);

const cache = {
  id: ID,
  name: "app-cache",
  username: "alice",
  engine: "valkey" as const,
  version: "8.1",
  access: "socket" as const,
  maxMemoryMb: 64,
  passwordSha256: SHA,
};

async function withHost(
  fn: (host: {
    layout: {
      runtimesDir: string;
      configDir: string;
      stateDir: string;
      principalHomeRoot: string;
    };
    run: RunFn;
    calls: string[];
    staged: string[];
    failOn: Set<string>;
  }) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "cache-step-" });
  const layout = {
    runtimesDir: join(root, "vendor"),
    configDir: join(root, "etc"),
    stateDir: join(root, "state"),
    principalHomeRoot: join(root, "srv"),
  };
  const calls: string[] = [];
  const staged: string[] = [];
  const failOn = new Set<string>();
  const run: RunFn = async (command, args) => {
    if (command === "id") return { success: true, stdout: "", stderr: "" };
    const rest = args.filter((a) => a !== "-n" && a !== "--");
    const [verb, ...tail] = rest[0]?.endsWith("/tp-host")
      ? rest.slice(1)
      : rest;
    calls.push([verb, ...tail.map((a) => a.replace(root, "<root>"))].join(" "));
    if (failOn.has(verb)) {
      return { success: false, stdout: "", stderr: `${verb} refused` };
    }
    if (verb === "reach-ports-install") {
      staged.push(
        await Deno.readTextFile(
          join(layout.stateDir, "reach/.stage", `${tail[0]}.list`),
        ),
      );
    }
    if (verb === "install") {
      await Deno.readTextFile(tail.at(-2) ?? "");
    }
    return { success: true, stdout: "", stderr: "" };
  };
  try {
    await fn({ layout, run, calls, staged, failOn });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const io = {
  binaryExists: () => Promise.resolve(true),
  sleep: () => Promise.resolve(),
  activeTimeoutMs: 1000,
};

test("a deploy with neither field leaves caches and helper ports alone", async () => {
  await withHost(async (host) => {
    const out = await applyDeployCachesAndReach({
      layout: host.layout,
      payload: { environmentId: ENV },
      run: host.run,
      io,
    });
    assertEquals(out, { warnings: [] });
    assertEquals(host.calls, []);
  });
});

test("helper ports are written from the host ports, then the walls are rebuilt", async () => {
  await withHost(async (host) => {
    await applyDeployCachesAndReach({
      layout: host.layout,
      payload: {
        environmentId: ENV,
        helperReach: [
          {
            composeServiceName: "search",
            containerPort: 7700,
            hostPort: 18200,
            username: "alice",
          },
          {
            composeServiceName: "mail",
            containerPort: 25,
            hostPort: 18081,
            username: "alice",
          },
        ],
      },
      run: host.run,
      io,
    });
    assertEquals(host.staged, ["alice 18081\nalice 18200\n"]);
    assertEquals(host.calls, [
      `reach-ports-install ${ENV}`,
      "php-loopback-sync",
    ]);
  });
});

test("an empty helper list removes the environment's list, and a refusal fails the deploy", async () => {
  await withHost(async (host) => {
    await applyDeployCachesAndReach({
      layout: host.layout,
      payload: { environmentId: ENV, helperReach: [] },
      run: host.run,
      io,
    });
    assertEquals(host.calls, [
      `reach-ports-remove ${ENV}`,
      "php-loopback-sync",
    ]);
    host.failOn.add("php-loopback-sync");
    await assertRejects(
      () =>
        applyDeployCachesAndReach({
          layout: host.layout,
          payload: {
            environmentId: ENV,
            helperReach: [{
              composeServiceName: "search",
              containerPort: 7700,
              hostPort: 18200,
              username: "alice",
            }],
          },
          run: host.run,
          io,
        }),
      Error,
      "not reloaded",
    );
  });
});

test("caches are applied and reported; a failed cache is a warning, not a failed deploy", async () => {
  await withHost(async (host) => {
    const okRun = host.run;
    const out = await applyDeployCachesAndReach({
      layout: host.layout,
      payload: { environmentId: ENV, caches: [cache] },
      run: (c, a) =>
        okRun(c, a).then((r) =>
          a.includes("is-active") ? { ...r, success: true } : r
        ),
      io,
    });
    assertEquals(out.caches?.map((c) => c.state), ["ready"]);
    assertEquals(out.warnings, []);

    host.failOn.add("cache-prepare");
    const failed = await applyDeployCachesAndReach({
      layout: host.layout,
      payload: {
        environmentId: ENV,
        caches: [{
          ...cache,
          id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
          name: "other",
        }],
      },
      run: host.run,
      io,
    });
    assertEquals(failed.caches?.map((c) => c.state), ["failed"]);
    assertEquals(failed.warnings.length >= 1, true);
    assertStringIncludes(
      failed.warnings.join("\n"),
      "cache other is not running",
    );
  });
});

test("an empty caches field clears the environment's caches and keeps their data", async () => {
  await withHost(async (host) => {
    await applyDeployCachesAndReach({
      layout: host.layout,
      payload: { environmentId: ENV, caches: [cache] },
      run: host.run,
      io,
    });
    host.calls.length = 0;
    const out = await applyDeployCachesAndReach({
      layout: host.layout,
      payload: { environmentId: ENV, caches: [] },
      run: host.run,
      io,
    });
    assert(host.calls.includes(`cache-remove alice ${ID}`));
    assertEquals(host.calls.some((c) => c.includes("--data")), false);
    assertStringIncludes(out.warnings.join("\n"), "data stayed");
  });
});

test("a destroy removes the caches and the helper ports, and trouble is only a warning", async () => {
  await withHost(async (host) => {
    await applyDeployCachesAndReach({
      layout: host.layout,
      payload: { environmentId: ENV, caches: [cache] },
      run: host.run,
      io,
    });
    host.calls.length = 0;
    const warnings = await removeEnvironmentCachesAndReach({
      layout: host.layout,
      environmentId: ENV,
      run: host.run,
      deleteData: true,
    });
    assertEquals(warnings, []);
    assert(host.calls.includes(`cache-remove alice ${ID} --data`));
    // No helper list was ever written, so the destroy costs no call for it.
    assertEquals(host.calls.includes(`reach-ports-remove ${ENV}`), false);
    await applyDeployCachesAndReach({
      layout: host.layout,
      payload: {
        environmentId: ENV,
        helperReach: [{
          composeServiceName: "search",
          containerPort: 7700,
          hostPort: 18200,
          username: "alice",
        }],
      },
      run: host.run,
      io,
    });
    host.calls.length = 0;
    await removeEnvironmentCachesAndReach({
      layout: host.layout,
      environmentId: ENV,
      run: host.run,
      deleteData: false,
    });
    assert(host.calls.includes(`reach-ports-remove ${ENV}`));
    await applyDeployCachesAndReach({
      layout: host.layout,
      payload: {
        environmentId: ENV,
        helperReach: [{
          composeServiceName: "search",
          containerPort: 7700,
          hostPort: 18200,
          username: "alice",
        }],
      },
      run: host.run,
      io,
    });
    host.failOn.add("reach-ports-remove");
    host.failOn.add("systemctl");
    const trouble = await removeEnvironmentCachesAndReach({
      layout: host.layout,
      environmentId: ENV,
      run: host.run,
      deleteData: false,
    });
    assertStringIncludes(trouble.join("\n"), "helper ports");
  });
});
