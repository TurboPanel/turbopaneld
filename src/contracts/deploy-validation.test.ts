import { assertEquals } from "@std/assert";
import { hostingWwwNames, wwwSiblingHostname } from "./commands-contracts.ts";
import { describe, it } from "@std/testing/bdd";
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployStorageMaterial,
} from "./commands-contracts.ts";
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
  validateDeployWwwModes,
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

  it("rejects ACME TLS combined with forceHttps:false", () => {
    assertEquals(
      validateDeployHostnameRouting([
        hosting({
          tlsMode: "acme",
          proxy: { forceHttps: false },
        }),
      ]),
      "forceHttps:false is incompatible with ACME TLS on hostname app.203.0.113.10",
    );
    assertEquals(
      validateDeployHostnameRouting([
        hosting({ pathPrefix: "/app", tlsMode: "acme" }),
        hosting({ hostingId: "h2", proxy: { forceHttps: false } }),
      ]),
      "forceHttps:false is incompatible with ACME TLS on hostname app.203.0.113.10",
    );
  });

  it("validates tcp/udp hosting ports instead of hostnames", () => {
    assertEquals(
      validateDeployHostingEntry(hosting({
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 5432, target: 5432 }],
      })),
      null,
    );
    assertEquals(
      validateDeployHostingEntry(hosting({
        hostnames: [],
        protocol: "udp",
        ports: [],
      })),
      "hostings[].ports must not be empty for udp protocol",
    );
    assertEquals(
      validateDeployHostingEntry(hosting({
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 0, target: 5432 }],
      })),
      "hostings[].ports entries must be integers between 1 and 65535",
    );
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

describe("www mode validation", () => {
  it("flips the www spelling and refuses unusable results", () => {
    assertEquals(wwwSiblingHostname("example.com"), "www.example.com");
    assertEquals(wwwSiblingHostname("www.example.com"), "example.com");
    assertEquals(wwwSiblingHostname("www."), null);
    assertEquals(wwwSiblingHostname(`${"a.".repeat(124)}com`), null);
  });

  it("expands each mode the same way whichever spelling was typed", () => {
    assertEquals(hostingWwwNames("example.com"), {
      serve: ["example.com"],
      redirect: null,
    });
    assertEquals(hostingWwwNames("example.com", "both"), {
      serve: ["example.com", "www.example.com"],
      redirect: null,
    });
    for (const typed of ["example.com", "www.example.com"]) {
      assertEquals(hostingWwwNames(typed, "www-to-root"), {
        serve: ["example.com"],
        redirect: { from: "www.example.com", to: "example.com" },
      });
      assertEquals(hostingWwwNames(typed, "root-to-www"), {
        serve: ["www.example.com"],
        redirect: { from: "example.com", to: "www.example.com" },
      });
    }
    assertEquals(hostingWwwNames("www.", "both"), null);
  });

  it("accepts every mode on a lone hostname", () => {
    for (const www of ["both", "www-to-root", "root-to-www"] as const) {
      assertEquals(
        validateDeployHostings([hosting({ hostnames: ["example.com"], www })]),
        null,
      );
    }
  });

  it("refuses www on a tcp hosting", () => {
    assertEquals(
      validateDeployWwwModes([
        hosting({
          hostnames: [],
          protocol: "tcp",
          ports: [{ published: 5432, target: 5432 }],
          www: "both",
        }),
      ]),
      "www requires the http protocol",
    );
  });

  it("refuses a sibling that is already a hostname, in this or another hosting", () => {
    const own = validateDeployWwwModes([
      hosting({
        hostnames: ["example.com", "www.example.com"],
        www: "www-to-root",
      }),
    ]);
    assertEquals(own?.includes("www.example.com"), true);
    const other = validateDeployHostings([
      hosting({ hostnames: ["example.com"], www: "both" }),
      hosting({ hostingId: "h2", hostnames: ["www.example.com"] }),
    ]);
    assertEquals(other?.includes("already a hostname"), true);
  });

  it("refuses paths of one name that make different www choices", () => {
    const error = validateDeployHostings([
      hosting({ hostnames: ["example.com"], www: "root-to-www" }),
      hosting({
        hostingId: "h2",
        hostnames: ["example.com"],
        pathPrefix: "/api",
      }),
    ]);
    assertEquals(
      error,
      "www: every path of example.com must use the same www choice (found root-to-www and off)",
    );
    // `both` on one path and nothing on another is just as mixed.
    assertEquals(
      validateDeployHostings([
        hosting({ hostnames: ["example.com"], www: "both" }),
        hosting({
          hostingId: "h2",
          hostnames: ["example.com"],
          pathPrefix: "/api",
        }),
      ])?.startsWith("www: every path of example.com"),
      true,
    );
  });

  it("refuses www on IP addresses and one-word names", () => {
    assertEquals(wwwSiblingHostname("203.0.113.5"), null);
    assertEquals(wwwSiblingHostname("www.203.0.113.5"), null);
    assertEquals(wwwSiblingHostname("localhost"), null);
    assertEquals(wwwSiblingHostname("www.com"), null);
    assertEquals(wwwSiblingHostname("www.localhost"), null);
    assertEquals(
      validateDeployWwwModes([
        hosting({ hostnames: ["203.0.113.5"], www: "both" }),
      ]),
      "www: 203.0.113.5 has no www or bare spelling to use",
    );
  });

  it("lets paths of one name agree on a www mode", () => {
    assertEquals(
      validateDeployHostings([
        hosting({ hostnames: ["example.com"], www: "root-to-www" }),
        hosting({
          hostingId: "h2",
          hostnames: ["example.com"],
          pathPrefix: "/api",
          www: "root-to-www",
        }),
      ]),
      null,
    );
  });

  it("ignores hostings without a mode", () => {
    assertEquals(
      validateDeployHostings([
        hosting({ hostnames: ["example.com"] }),
        hosting({ hostingId: "h2", hostnames: ["www.example.com"] }),
      ]),
      null,
    );
  });
});
