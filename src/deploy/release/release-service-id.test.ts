import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import {
  principalHomePath,
  resolveLayout,
  siteCurrentSymlink,
  siteReleasesDir,
} from "../../paths/layout.ts";
import {
  effectiveReleaseServiceId,
  resolveReleaseServiceId,
} from "./release-service-id.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function basePayload(
  overrides: Partial<EnvironmentDeployPayload> = {},
): EnvironmentDeployPayload {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "test",
    composeFiles: [],
    hostings: [],
    ...overrides,
  };
}

function baseSource(
  overrides: Partial<EnvironmentDeploySource> = {},
): EnvironmentDeploySource {
  return {
    sourceId: "src-1",
    composeServiceName: "web",
    provider: "github",
    cloneUrl: "https://github.com/example/repo.git",
    ref: "main",
    commitSha: "abc123def456",
    releaseId: "rel-1",
    build: { kind: "native" },
    ...overrides,
  };
}

test("resolveReleaseServiceId falls back to compose key without releaseServiceId", () => {
  const payload = basePayload({ hostings: [], ingressServices: [] });
  assertEquals(resolveReleaseServiceId(payload, "worker"), "worker");
});

test("effectiveReleaseServiceId keeps legacy compose-key tree until canonical exists", async () => {
  await createTempLayout().then(async (fixture) => {
    const principalHomeRoot = join(fixture.dirs.stateDir, "principal-homes");
    const layout = resolveLayout({
      ...fixture.env,
      TURBOPANEL_PRINCIPAL_HOME_ROOT: principalHomeRoot,
    });
    const username = "appuser";
    const home = principalHomePath(layout, username);
    const canonical = "svc-env-uuid";
    const compose = "app";
    const legacyRelease = join(siteReleasesDir(home, compose), "rel-legacy");
    await Deno.mkdir(legacyRelease, { recursive: true });
    await Deno.symlink(
      join("releases", "rel-legacy"),
      siteCurrentSymlink(home, compose),
    );

    const payload = basePayload({
      sourceMaterial: [
        baseSource({
          composeServiceName: compose,
          releaseServiceId: canonical,
          principal: {
            principalId: "p1",
            username,
            uid: 15001,
            gid: 15002,
          },
        }),
      ],
    });

    const segment = await effectiveReleaseServiceId(
      payload,
      compose,
      layout,
      { username },
    );
    assertEquals(segment, compose);
  });
});
