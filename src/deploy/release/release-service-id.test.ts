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
  serviceFolderForCompose,
  serviceFolderFromPayload,
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

test("resolveReleaseServiceId uses hosting serviceId when no release or native row", () => {
  const payload = basePayload({
    hostings: [{
      hostingId: "host-1",
      composeServiceName: "web",
      serviceId: "svc-hosting-legacy",
      hostnames: ["app.example.com"],
    }],
    nativeAppServices: [],
    ingressServices: [],
  });
  assertEquals(resolveReleaseServiceId(payload, "web"), "svc-hosting-legacy");
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

test("a service with a planned folder never falls back to an older tree", async () => {
  await createTempLayout().then(async (fixture) => {
    const layout = resolveLayout({
      ...fixture.env,
      TURBOPANEL_PRINCIPAL_HOME_ROOT: join(
        fixture.dirs.stateDir,
        "principal-homes",
      ),
    });
    const home = principalHomePath(layout, "appuser");
    // The older tree is there and published, as in the case above.
    await Deno.mkdir(join(siteReleasesDir(home, "app"), "rel-old"), {
      recursive: true,
    });
    await Deno.symlink(
      join("releases", "rel-old"),
      siteCurrentSymlink(home, "app"),
    );
    const payload = basePayload({
      sourceMaterial: [
        baseSource({
          composeServiceName: "app",
          releaseServiceId: "svc-env-uuid",
        }),
      ],
      serviceFolders: [{
        serviceId: "svc-env-uuid",
        folder: { owner: "appuser", scope: "production", slug: "app" },
      }],
    });
    assertEquals(
      await effectiveReleaseServiceId(payload, "app", layout, {
        username: "appuser",
      }),
      "svc-env-uuid",
    );
    assertEquals(
      serviceFolderFromPayload(payload, "svc-env-uuid"),
      { owner: "appuser", scope: "production", slug: "app" },
    );
    assertEquals(serviceFolderFromPayload(payload, "other"), undefined);
  });
});

test("serviceFolderForCompose finds the folder through the release id or the native app's id", () => {
  const folder = { owner: "alice", scope: "production", slug: "api" };
  const releaseId = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c01";
  const appId = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c02";
  const native = (serviceId: string) => ({
    composeServiceName: "web",
    serviceId,
  });
  // The folder is keyed by the id the release is named by.
  assertEquals(
    serviceFolderForCompose(
      basePayload({
        sourceMaterial: [baseSource({ releaseServiceId: releaseId })],
        nativeAppServices: [native(appId)],
        serviceFolders: [{ serviceId: releaseId, folder }],
      } as Partial<EnvironmentDeployPayload>),
      "web",
    ),
    folder,
  );
  // The folder is keyed by the id the unit is named by.
  assertEquals(
    serviceFolderForCompose(
      basePayload({
        sourceMaterial: [baseSource({ releaseServiceId: releaseId })],
        nativeAppServices: [native(appId)],
        serviceFolders: [{ serviceId: appId, folder }],
      } as Partial<EnvironmentDeployPayload>),
      "web",
    ),
    folder,
  );
  // No folder for either id, or another compose service: none.
  assertEquals(
    serviceFolderForCompose(
      basePayload({
        sourceMaterial: [baseSource({ releaseServiceId: releaseId })],
        nativeAppServices: [native(appId)],
        serviceFolders: [{ serviceId: "other", folder }],
      } as Partial<EnvironmentDeployPayload>),
      "web",
    ),
    undefined,
  );
});
