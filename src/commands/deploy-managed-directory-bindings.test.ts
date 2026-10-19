import { assertEquals } from "@std/assert";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySite,
} from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { deployManagedDirectoryBindings } from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVICE_ID = "01936b3e-1111-2222-3333-444455556666";
const layout = resolveLayout({}, {
  skipDiscovery: true,
  forceMode: "production",
});
const run = () => Promise.resolve({ success: false, stdout: "", stderr: "" });

function site(
  overrides: Partial<EnvironmentDeploySite> = {},
): EnvironmentDeploySite {
  return {
    composeServiceName: "php",
    engine: "caddy",
    root: "public",
    listenPort: 18557,
    principal: { principalId: "p-1", username: "owner" },
    ...overrides,
  };
}

function payload(
  overrides: Partial<EnvironmentDeployPayload> = {},
): EnvironmentDeployPayload {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "test",
    composeFiles: [],
    hostings: [{
      hostingId: "h-1",
      serviceId: SERVICE_ID,
      composeServiceName: "php",
      hostnames: ["php.example.test"],
    }],
    sites: [site()],
    serviceFolders: [{
      serviceId: SERVICE_ID,
      folder: { owner: "owner", scope: "prod", slug: "php.example.test" },
    }],
    ...overrides,
  };
}

test("a site with a planned folder and no source is served from its folder", async () => {
  const bindings = await deployManagedDirectoryBindings(
    payload(),
    new Map(),
    layout,
    run,
  );
  assertEquals(bindings.get("php")?.serviceId, SERVICE_ID);
  assertEquals(bindings.get("php")?.folder, {
    owner: "owner",
    scope: "prod",
    slug: "php.example.test",
  });
});

test("a site with no planned folder keeps the daemon-owned tree", async () => {
  const bindings = await deployManagedDirectoryBindings(
    payload({ serviceFolders: [] }),
    new Map(),
    layout,
    run,
  );
  assertEquals(bindings.size, 0);
});

test("a site with no owner is never given a folder", async () => {
  const bindings = await deployManagedDirectoryBindings(
    payload({ sites: [site({ principal: undefined })] }),
    new Map(),
    layout,
    run,
  );
  assertEquals(bindings.size, 0);
});

test("a site that has a release stays on the release lane", async () => {
  const bindings = await deployManagedDirectoryBindings(
    payload(),
    new Map([["php", { serviceId: SERVICE_ID, username: "owner" }]]),
    layout,
    run,
  );
  assertEquals(bindings.size, 0);
});
