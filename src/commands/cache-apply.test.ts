import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "../orchestration/assets.ts";
import { handleCacheApply } from "./cache-apply.ts";
import { COMMAND_TYPES } from "../contracts/commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV = "env-0123";
const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const cache = {
  id: ID,
  name: "app-cache",
  username: "alice",
  engine: "valkey" as const,
  version: "8.1",
  access: "socket" as const,
  maxMemoryMb: 64,
  passwordSha256: "ab".repeat(32),
};

async function withLayout(
  fn: (layout: {
    runtimesDir: string;
    configDir: string;
    stateDir: string;
    principalHomeRoot: string;
  }) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "cache-cmd-" });
  try {
    await fn({
      runtimesDir: join(root, "vendor"),
      configDir: join(root, "etc"),
      stateDir: join(root, "state"),
      principalHomeRoot: join(root, "srv"),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const okRun = (calls: string[]) => (command: string, args: string[]) => {
  calls.push(
    command === "sudo"
      ? args.filter((a) => a !== "-n" && a !== "--").join(" ")
      : command,
  );
  return Promise.resolve({ success: true, stdout: "", stderr: "" });
};

test("cache.apply applies the complete set and reports each cache", async () => {
  await withLayout(async (layout) => {
    const calls: string[] = [];
    const out = await handleCacheApply(
      { environmentId: ENV, caches: [cache] },
      "2026-11-11T00:00:00.000Z",
      {
        layout,
        run: okRun(calls),
        io: {
          binaryExists: () => Promise.resolve(true),
          sleep: () => Promise.resolve(),
        },
      },
    );
    assertEquals(out.caches, [{
      id: ID,
      state: "ready",
      runtimeVersion: "8.1.11",
    }]);
    assert(calls.some((c) => c.includes("cache-prepare alice")));
  });
});

test("cache.apply never removes a cache that is merely not listed, and removes a named one", async () => {
  await withLayout(async (layout) => {
    const calls: string[] = [];
    const deps = {
      layout,
      run: okRun(calls),
      io: {
        binaryExists: () => Promise.resolve(true),
        sleep: () => Promise.resolve(),
      },
    };
    await handleCacheApply({ environmentId: ENV, caches: [cache] }, "t", deps);
    calls.length = 0;
    await handleCacheApply({ environmentId: ENV, caches: [] }, "t", deps);
    assertEquals(calls.some((c) => c.includes("cache-remove")), false);
    await handleCacheApply(
      {
        environmentId: ENV,
        caches: [],
        removed: [{ id: ID, username: "alice", deleteData: true }],
      },
      "t",
      deps,
    );
    assert(calls.some((c) => c.includes(`cache-remove alice ${ID} --data`)));
  });
});

test("cache.apply reports a cache whose account is missing as pending", async () => {
  await withLayout(async (layout) => {
    const out = await handleCacheApply(
      { environmentId: ENV, caches: [cache] },
      "t",
      {
        layout,
        run: okRun([]),
        io: { userExists: () => Promise.resolve(false) },
      },
    );
    assertEquals(out.caches.map((c) => c.state), ["pending"]);
  });
});

test("cache.apply refuses a payload that is not a complete set", async () => {
  await assertRejects(
    () => handleCacheApply({ environmentId: ENV } as never, "t"),
    Error,
    "cache.apply",
  );
});

test("COMMAND_TYPES lists cache.apply", () => {
  assert((COMMAND_TYPES as readonly string[]).includes("cache.apply"));
});

test("a deploy applies caches right after the accounts and before anything that uses them, and a destroy removes them before retiring accounts", async () => {
  const deploy = await Deno.readTextFile(
    join(DAEMON_ROOT, "src/commands/deploy-environment.ts"),
  );
  const principals = deploy.indexOf(
    "await ensureDeployPrincipals(\n    layout,",
  );
  const caches = deploy.indexOf("await applyDeployCachesAndReach(");
  const releases = deploy.indexOf(
    "await applySourceReleases(layout, parsedPayload",
  );
  assert(principals > 0 && caches > principals && caches < releases);
  const stop = await Deno.readTextFile(
    join(DAEMON_ROOT, "src/commands/stop-environment.ts"),
  );
  const removeCaches = stop.indexOf("await removeEnvironmentCachesAndReach(");
  const retire = stop.indexOf("await retirePrincipals(");
  const sites = stop.indexOf("await removeSites(layout");
  assert(removeCaches > 0 && removeCaches < retire && sites > 0);
});
