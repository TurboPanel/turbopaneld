import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { buildStorageVolumesFragment } from "./apply-storage-volumes.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";

const webResolved: ResolvedComposeModel = {
  serviceNames: ["web"],
  services: { web: { image: "nginx:latest" } },
};

describe("buildStorageVolumesFragment", () => {
  it("patches bind mounts and docker volumes into services fragment", () => {
    const fragment = buildStorageVolumesFragment(
      [
        {
          storageId: "st-bind",
          locationId: "loc-bind",
          kind: "directory",
          name: "data",
          provider: "path",
          serverId: "srv",
          mounts: [{
            composeServiceName: "web",
            destinationPath: "/data",
          }],
        },
        {
          storageId: "st-vol",
          locationId: "loc-vol",
          kind: "volume",
          name: "cache",
          provider: "docker",
          serverId: "srv",
          volumeName: "tp-00000000-cache",
          mounts: [{
            composeServiceName: "web",
            destinationPath: "/cache",
          }],
        },
      ],
      new Map([
        ["loc-bind", "/var/lib/tp/data"],
        ["loc-vol", "tp-00000000-cache"],
      ]),
      webResolved,
    );

    assertEquals(fragment.services?.web?.volumes, [
      {
        type: "bind",
        source: "/var/lib/tp/data",
        target: "/data",
      },
      {
        type: "volume",
        source: "tp-00000000-cache",
        target: "/cache",
      },
    ]);
    assertEquals(fragment.volumes?.["tp-00000000-cache"], {
      name: "tp-00000000-cache",
      external: true,
    });
  });

  it("emits external:true for docker volumes and skips overlay when mounts are empty", () => {
    const volumeId = "01936b3e-8c7a-7b2d-a1f0-123456789abc";
    const fragment = buildStorageVolumesFragment(
      [
        {
          storageId: volumeId,
          locationId: "loc-vol",
          kind: "volume",
          name: "data",
          provider: "docker",
          serverId: "srv",
          volumeName: volumeId,
          mounts: [],
        },
      ],
      new Map([["loc-vol", volumeId]]),
      webResolved,
    );

    assertEquals(fragment.volumes?.[volumeId], {
      name: volumeId,
      external: true,
    });
    assertEquals(fragment.services, undefined);
  });

  it("throws when compose service is missing", () => {
    assertThrows(
      () =>
        buildStorageVolumesFragment(
          [{
            storageId: "st1",
            locationId: "loc1",
            kind: "directory",
            name: "data",
            provider: "path",
            serverId: "srv",
            mounts: [{
              composeServiceName: "missing",
              destinationPath: "/data",
            }],
          }],
          new Map([["loc1", "/host/data"]]),
          webResolved,
        ),
      Error,
      "Compose service missing not found",
    );
  });
});
