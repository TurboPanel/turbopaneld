import { assertEquals, assertRejects } from "@std/assert";
import { ensureDocker } from "./ensure-docker.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("ensureDocker short-circuits when binary present and Engine reachable", async () => {
  let setupCalls = 0;
  await ensureDocker({
    dockerBinaryPresent: () => Promise.resolve(true),
    dockerEngineReachable: () => Promise.resolve(true),
    runDockerSetup: () => {
      setupCalls += 1;
      return Promise.resolve();
    },
  });
  assertEquals(setupCalls, 0);
});

test("ensureDocker runs docker-setup when binary is missing then rechecks", async () => {
  let setupCalls = 0;
  let reachableCalls = 0;
  await ensureDocker({
    dockerBinaryPresent: () => Promise.resolve(false),
    dockerEngineReachable: () => {
      reachableCalls += 1;
      return Promise.resolve(true);
    },
    runDockerSetup: () => {
      setupCalls += 1;
      return Promise.resolve();
    },
  });
  assertEquals(setupCalls, 1);
  // Present=false skips the pre-check reachable call; only post-setup check runs.
  assertEquals(reachableCalls, 1);
});

test("ensureDocker runs docker-setup when binary present but Engine unreachable", async () => {
  let setupCalls = 0;
  let reachablePhase = 0;
  await ensureDocker({
    dockerBinaryPresent: () => Promise.resolve(true),
    dockerEngineReachable: () => {
      reachablePhase += 1;
      // First call (pre-check) fails; post-setup succeeds.
      return Promise.resolve(reachablePhase > 1);
    },
    runDockerSetup: () => {
      setupCalls += 1;
      return Promise.resolve();
    },
  });
  assertEquals(setupCalls, 1);
  assertEquals(reachablePhase, 2);
});

test("ensureDocker throws when Engine still unreachable after docker-setup", async () => {
  await assertRejects(
    () =>
      ensureDocker({
        dockerBinaryPresent: () => Promise.resolve(false),
        dockerEngineReachable: () => Promise.resolve(false),
        runDockerSetup: () => Promise.resolve(),
      }),
    Error,
    "Docker Engine API still unreachable after docker-setup",
  );
});

function fileInfo(isFile: boolean): Deno.FileInfo {
  return { isFile } as Deno.FileInfo;
}

test("ensureDocker default binary probe treats isFile as present", async () => {
  let setupCalls = 0;
  let statPath: string | undefined;
  await ensureDocker({
    // Omit dockerBinaryPresent — exercise dockerBinaryPresentDefault + stat seam.
    stat: (path) => {
      statPath = path;
      return Promise.resolve(fileInfo(true));
    },
    dockerEngineReachable: () => Promise.resolve(true),
    runDockerSetup: () => {
      setupCalls += 1;
      return Promise.resolve();
    },
  });
  assertEquals(statPath, "/usr/bin/docker");
  assertEquals(setupCalls, 0);
});

test("ensureDocker default binary probe returns false on NotFound then runs setup", async () => {
  let setupCalls = 0;
  await ensureDocker({
    stat: () => Promise.reject(new Deno.errors.NotFound("missing")),
    dockerEngineReachable: () => Promise.resolve(true),
    runDockerSetup: () => {
      setupCalls += 1;
      return Promise.resolve();
    },
  });
  assertEquals(setupCalls, 1);
});

test("ensureDocker default binary probe treats non-file as missing", async () => {
  let setupCalls = 0;
  await ensureDocker({
    stat: () => Promise.resolve(fileInfo(false)),
    dockerEngineReachable: () => Promise.resolve(true),
    runDockerSetup: () => {
      setupCalls += 1;
      return Promise.resolve();
    },
  });
  assertEquals(setupCalls, 1);
});

test("ensureDocker default binary probe rethrows unexpected stat errors", async () => {
  await assertRejects(
    () =>
      ensureDocker({
        stat: () => Promise.reject(new TypeError("stat failed")),
        dockerEngineReachable: () => Promise.resolve(false),
        runDockerSetup: () => Promise.resolve(),
      }),
    TypeError,
    "stat failed",
  );
});
