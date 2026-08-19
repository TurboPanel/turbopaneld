import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployStorageMaterial,
} from "./contracts.ts";
import {
  normalizeDeployPathPrefix,
  pathPrefixHasUnsupportedCharacters,
  validateDeployHostingEntry,
  validateDeployHostings,
  validateDeployHostnameRouting,
  validateDeployPathPrefix,
  validateDeployStorageMaterial,
  validateDeployStorageMaterialList,
  validateDeployTargetPort,
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

describe("daemon deploy-validation parity", () => {
  it("matches instance pathPrefix rules", () => {
    assertEquals(validateDeployPathPrefix("/metrics"), true);
    assertEquals(validateDeployPathPrefix("metrics"), false);
    assertEquals(validateDeployPathPrefix(undefined), true);
  });

  it("normalizes deploy path prefixes", () => {
    assertEquals(normalizeDeployPathPrefix(undefined), undefined);
    assertEquals(normalizeDeployPathPrefix("  "), undefined);
    assertEquals(normalizeDeployPathPrefix("/"), undefined);
    assertEquals(normalizeDeployPathPrefix(" /api "), "/api");
  });

  it("detects unsupported characters in path prefixes", () => {
    assertEquals(pathPrefixHasUnsupportedCharacters("/api"), false);
    assertEquals(pathPrefixHasUnsupportedCharacters("/api`"), true);
    assertEquals(pathPrefixHasUnsupportedCharacters("/api\n"), true);
  });

  it("validates deploy target ports", () => {
    assertEquals(validateDeployTargetPort(undefined), true);
    assertEquals(validateDeployTargetPort(8080), true);
    assertEquals(validateDeployTargetPort(1), true);
    assertEquals(validateDeployTargetPort(65535), true);
    assertEquals(validateDeployTargetPort(0), false);
    assertEquals(validateDeployTargetPort(65536), false);
    assertEquals(validateDeployTargetPort(1.5), false);
  });

  it("rejects invalid hostnames in hosting entries", () => {
    const error = validateDeployHostings([hosting({
      hostnames: ["bad hostname"],
    })]);
    assertEquals(typeof error, "string");
    assertEquals(error?.includes("invalid hostname"), true);
  });

  it("rejects invalid pathPrefix and targetPort on hosting entries", () => {
    assertEquals(
      validateDeployHostingEntry(hosting({ pathPrefix: "metrics" })),
      "pathPrefix must start with /",
    );
    assertEquals(
      validateDeployHostingEntry(hosting({ targetPort: 70000 })),
      "targetPort must be an integer between 1 and 65535",
    );
    assertEquals(validateDeployHostingEntry(hosting()), null);
  });

  it("rejects duplicate path prefixes and catch-all hostings", () => {
    const duplicate = validateDeployHostnameRouting([
      hosting({ pathPrefix: "/api" }),
      hosting({ hostingId: "h2", pathPrefix: "/api" }),
    ]);
    assertEquals(
      duplicate,
      "duplicate pathPrefix /api for hostname app.203.0.113.10",
    );

    const catchAll = validateDeployHostnameRouting([
      hosting(),
      hosting({ hostingId: "h2" }),
    ]);
    assertEquals(
      catchAll,
      "multiple catch-all hostings for hostname app.203.0.113.10",
    );
  });

  it("rejects conflicting bindAddress for the same hostname", () => {
    const error = validateDeployHostnameRouting([
      hosting({ bindAddress: "203.0.113.1" }),
      hosting({
        hostingId: "h2",
        bindAddress: "203.0.113.2",
      }),
    ]);
    assertEquals(
      error,
      "conflicting bindAddress for hostname app.203.0.113.10",
    );
  });

  it("skips non-http protocol rows for hostname routing", () => {
    assertEquals(
      validateDeployHostnameRouting([
        hosting({
          protocol: "tcp",
          ports: [{ published: 5432, target: 5432 }],
          pathPrefix: "bad",
        }),
      ]),
      null,
    );
  });

  it("rejects unsupported characters in hostname routing pathPrefix", () => {
    const error = validateDeployHostnameRouting([
      hosting({ pathPrefix: "/api`" }),
    ]);
    assertEquals(
      error,
      "pathPrefix contains unsupported characters for hostname app.203.0.113.10",
    );
  });

  it("validates storage material kinds and providers", () => {
    assertEquals(
      validateDeployStorageMaterial(storage({ kind: "blob" as "volume" })),
      "invalid storage kind: blob",
    );
    assertEquals(
      validateDeployStorageMaterial(storage({ provider: "s3" as "docker" })),
      "invalid storage provider: s3",
    );
    assertEquals(
      validateDeployStorageMaterial(storage({
        kind: "volume",
        provider: "path",
      })),
      "storage stor-1 volume kind requires docker provider",
    );
    assertEquals(
      validateDeployStorageMaterial(storage({
        kind: "directory",
        provider: "docker",
      })),
      "storage stor-1 directory kind requires path provider",
    );
  });

  it("validates docker volume names and mount rows", () => {
    assertEquals(
      validateDeployStorageMaterial(storage({ volumeName: "" })),
      "storage stor-1 missing volumeName",
    );
    assertEquals(
      validateDeployStorageMaterial(storage({ volumeName: "bad name" })),
      "storage stor-1 has invalid volumeName",
    );
    assertEquals(
      validateDeployStorageMaterial(storage({
        mounts: [{ composeServiceName: "web", destinationPath: "" }],
      })),
      "storage stor-1 mount missing destinationPath",
    );
    assertEquals(
      validateDeployStorageMaterial(storage({
        mounts: [{
          destinationPath: "/data",
        }],
      })),
      "storage stor-1 missing composeServiceName for mount",
    );
    assertEquals(validateDeployStorageMaterial(storage()), null);
  });

  it("validates storage material lists", () => {
    assertEquals(
      validateDeployStorageMaterialList([
        storage(),
        storage({
          storageId: "stor-2",
          volumeName: "tp-other",
        }),
      ]),
      null,
    );
    assertEquals(
      validateDeployStorageMaterialList([storage({ volumeName: "" })]),
      "storage stor-1 missing volumeName",
    );
  });
});
