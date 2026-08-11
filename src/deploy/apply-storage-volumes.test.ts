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
          kind: "bind_mount",
          name: "data",
          destinationPath: "/data",
          composeServiceName: "web",
          serverId: "srv",
        },
        {
          storageId: "st-vol",
          kind: "docker_volume",
          name: "cache",
          destinationPath: "/cache",
          composeServiceName: "web",
          serverId: "srv",
          volumeName: "tp-00000000-cache",
        },
      ],
      new Map([
        ["st-bind", "/var/lib/tp/data"],
        ["st-vol", "tp-00000000-cache"],
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

  it("emits external:true for docker_volume and skips mount without destinationPath", () => {
    const volumeId = "01936b3e-8c7a-7b2d-a1f0-123456789abc";
    const fragment = buildStorageVolumesFragment(
      [
        {
          storageId: volumeId,
          kind: "docker_volume",
          name: "data",
          serverId: "srv",
          volumeName: volumeId,
        },
      ],
      new Map([[volumeId, volumeId]]),
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
            kind: "bind_mount",
            name: "data",
            destinationPath: "/data",
            composeServiceName: "missing",
            serverId: "srv",
          }],
          new Map([["st1", "/host/data"]]),
          webResolved,
        ),
      Error,
      "Compose service missing not found",
    );
  });
});
