import { assertEquals, assertThrows } from "@std/assert";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import {
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

test("a service folder comes from the planned serviceFolders entry", () => {
  const folder = { owner: "appuser", scope: "production", slug: "app" };
  const payload = basePayload({
    sourceMaterial: [
      baseSource({
        composeServiceName: "app",
        releaseServiceId: "svc-env-uuid",
      }),
    ],
    serviceFolders: [{ serviceId: "svc-env-uuid", folder }],
  });
  assertEquals(serviceFolderFromPayload(payload, "svc-env-uuid"), folder);
});

test("a service with no serviceFolders entry is refused, not served from another tree", () => {
  const payload = basePayload({
    sourceMaterial: [
      baseSource({
        composeServiceName: "app",
        releaseServiceId: "svc-env-uuid",
      }),
    ],
  });
  assertThrows(
    () => serviceFolderFromPayload(payload, "svc-env-uuid"),
    Error,
    "no serviceFolders entry",
  );
  assertThrows(
    () => serviceFolderForCompose(payload, "app"),
    Error,
    "no serviceFolders entry",
  );
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
  // No folder for either id, or another compose service: refused.
  assertThrows(
    () =>
      serviceFolderForCompose(
        basePayload({
          sourceMaterial: [baseSource({ releaseServiceId: releaseId })],
          nativeAppServices: [native(appId)],
          serviceFolders: [{ serviceId: "other", folder }],
        } as Partial<EnvironmentDeployPayload>),
        "web",
      ),
    Error,
    "no serviceFolders entry",
  );
});
