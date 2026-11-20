import { assertEquals, assertRejects } from "@std/assert";
import { assertBuildContextsPresent } from "./compose-build-contexts.ts";
import {
  collectResolvedHostPaths,
  type ComposeHostPathScan,
} from "./compose-host-paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DIRS = {
  stageDir: "/srv/example/deployments/p/e/.staging",
  deploymentDir: "/srv/example/deployments/p/e",
};

function scanOf(services: Record<string, unknown>): ComposeHostPathScan {
  return collectResolvedHostPaths({ services });
}

test("a context present in the deployment directory passes", async () => {
  const looked: string[] = [];
  await assertBuildContextsPresent(
    [scanOf({
      vpn: { build: { context: `${DIRS.stageDir}/vpn` } },
      app: { build: { context: DIRS.stageDir } },
    })],
    DIRS,
    (path) => {
      looked.push(path);
      return Promise.resolve(true);
    },
  );
  // Looked up where the published compose file runs the build.
  assertEquals(looked, [`${DIRS.deploymentDir}/vpn`, DIRS.deploymentDir]);
});

test("a missing context is named with its service and relative path", async () => {
  const error = await assertRejects(
    () =>
      assertBuildContextsPresent(
        [scanOf({
          vpn: { build: { context: `${DIRS.stageDir}/vpn` } },
          qbittorrent: { build: { context: `${DIRS.stageDir}/qbittorrent` } },
          present: { build: { context: `${DIRS.stageDir}/present` } },
        })],
        DIRS,
        (path) => Promise.resolve(path.endsWith("/present")),
      ),
    Error,
  );
  assertEquals(
    error.message.includes(
      "service vpn build context ./vpn; service qbittorrent build context ./qbittorrent.",
    ),
    true,
  );
});

test("remote contexts, extra contexts and Dockerfiles are not checked", async () => {
  await assertBuildContextsPresent(
    [scanOf({
      remote: { build: { context: "https://example.net/repo.git" } },
      extra: {
        build: {
          context: DIRS.stageDir,
          dockerfile: "missing/Dockerfile",
          additional_contexts: { more: `${DIRS.stageDir}/more` },
        },
      },
    })],
    DIRS,
    (path) => Promise.resolve(path === DIRS.deploymentDir),
  );
});

test("a context outside the staging directory is left to the path check", async () => {
  await assertBuildContextsPresent(
    [scanOf({ web: { build: { context: "/elsewhere/app" } } })],
    DIRS,
    () => Promise.resolve(false),
  );
});

test("a service without a build needs nothing", async () => {
  await assertBuildContextsPresent(
    [scanOf({ web: { image: "nginx:alpine" } })],
    DIRS,
    () => Promise.reject(new Error("must not look anything up")),
  );
});
