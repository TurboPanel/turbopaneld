import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployStorageMaterial,
} from "./contracts.ts";
import {
  validateDeployHostnameRouting,
  validateDeployStorageMaterial,
  validateDeployStorageMaterialList,
} from "./deploy-validation.ts";

function hosting(
  overrides: Partial<EnvironmentDeployHosting> = {},
): EnvironmentDeployHosting {
  return {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.203.0.113.10"],
    ...overrides,
  };
}

function storage(
  overrides: Partial<EnvironmentDeployStorageMaterial> = {},
): EnvironmentDeployStorageMaterial {
  return {
    storageId: "stor-1",
    locationId: "loc-1",
    kind: "volume",
    name: "data",
    provider: "docker",
    volumeName: "tp-data",
    serverId: "srv-1",
    mounts: [{
      composeServiceName: "web",
      destinationPath: "/data",
    }],
    ...overrides,
  };
}

describe("deploy-validation leftover branches", () => {
  it("allows the same bindAddress twice and catch-all plus a prefixed sibling", () => {
    assertEquals(
      validateDeployHostnameRouting([
        hosting({ bindAddress: "203.0.113.1", pathPrefix: "/api" }),
        hosting({
          hostingId: "h2",
          bindAddress: "203.0.113.1",
        }),
      ]),
      null,
    );
  });

  it("rejects a normalized pathPrefix that does not start with /", () => {
    assertEquals(
      validateDeployHostnameRouting([hosting({ pathPrefix: "metrics" })]),
      "pathPrefix must start with /",
    );
  });

  it("accepts directory and file kinds with the path provider", () => {
    assertEquals(
      validateDeployStorageMaterial(storage({
        kind: "directory",
        provider: "path",
        volumeName: undefined,
      })),
      null,
    );
    assertEquals(
      validateDeployStorageMaterial(storage({
        kind: "file",
        provider: "path",
        volumeName: undefined,
      })),
      null,
    );
  });

  it("rejects a docker volume whose volumeName is omitted", () => {
    assertEquals(
      validateDeployStorageMaterial(storage({ volumeName: undefined })),
      "storage stor-1 missing volumeName",
    );
  });

  it("accepts an empty storage material list", () => {
    assertEquals(validateDeployStorageMaterialList([]), null);
  });
});
