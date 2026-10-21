import { assertEquals } from "@std/assert";
import {
  type DeployedThings,
  type HostProbe,
  hostStillRunsDeploy,
  usesMutableImageTag,
} from "./unchanged-deploy.ts";

const test = Deno.test.bind(Deno);

const THINGS: DeployedThings = {
  environmentId: "env1",
  projects: ["proj"],
  nativeServiceIds: ["svc1"],
  siteNames: ["blog"],
  currentLinks: ["/srv/users/a/production/services/svc1/current"],
};

function probe(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    composeStates: () =>
      Promise.resolve({
        expected: ["web"],
        containers: [{ service: "web", state: "running", health: "healthy" }],
      }),
    unitActive: () => Promise.resolve(true),
    pathExists: () => Promise.resolve(true),
    siteConfigNames: () => Promise.resolve(["tp-env1-blog.conf"]),
    ...overrides,
  };
}

test("a host with everything up may skip", async () => {
  assertEquals(await hostStillRunsDeploy(THINGS, probe()), true);
});

test("a stopped, missing or unhealthy container does not allow a skip", async () => {
  for (
    const containers of [
      [{ service: "web", state: "exited" }],
      [],
      [{ service: "web", state: "running", health: "unhealthy" }],
    ]
  ) {
    assertEquals(
      await hostStillRunsDeploy(
        THINGS,
        probe({
          composeStates: () =>
            Promise.resolve({ expected: ["web"], containers }),
        }),
      ),
      false,
    );
  }
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ composeStates: () => Promise.resolve(null) }),
    ),
    false,
  );
});

test("an inactive unit does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ unitActive: () => Promise.resolve(false) }),
    ),
    false,
  );
});

test("a missing current link does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ pathExists: () => Promise.resolve(false) }),
    ),
    false,
  );
});

test("a missing site config does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ siteConfigNames: () => Promise.resolve(["tp-env1-other.conf"]) }),
    ),
    false,
  );
});

test("a probe that throws does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ unitActive: () => Promise.reject(new Error("no systemd")) }),
    ),
    false,
  );
});

test("images without a tag, on latest or set by a variable are mutable; pinned ones are not", () => {
  const compose = (
    image: string,
  ) => [`services:\n  web:\n    image: ${image}\n`];
  assertEquals(usesMutableImageTag(compose("nginx")), true);
  assertEquals(usesMutableImageTag(compose("nginx:latest")), true);
  assertEquals(usesMutableImageTag(compose("ghcr.io/x/y")), true);
  assertEquals(usesMutableImageTag(compose("nginx:${TAG}")), true);
  assertEquals(usesMutableImageTag(compose("nginx:1.27.5")), false);
  assertEquals(usesMutableImageTag(compose("localhost:5000/app:v2")), false);
  assertEquals(
    usesMutableImageTag(compose("nginx@sha256:" + "a".repeat(64))),
    false,
  );
});
