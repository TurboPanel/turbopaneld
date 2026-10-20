import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  buildStorageVolumesFragment,
  declaredVolumeUsers,
  numericComposeUser,
} from "./apply-storage-volumes.ts";
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

  it("returns an empty fragment when there are no storage entries", () => {
    assertEquals(
      buildStorageVolumesFragment([], new Map(), webResolved),
      {},
    );
  });

  it("skips bind overlay when mounts are empty and stamps read-only plus volume subpath", () => {
    const volumeId = "01936b3e-8c7a-7b2d-a1f0-123456789abd";
    const fragment = buildStorageVolumesFragment(
      [
        {
          storageId: "st-bind-empty",
          locationId: "loc-bind-empty",
          kind: "directory",
          name: "empty",
          provider: "path",
          serverId: "srv",
          mounts: [],
        },
        {
          storageId: "st-vol-sub",
          locationId: "loc-vol-sub",
          kind: "volume",
          name: "cache",
          provider: "docker",
          serverId: "srv",
          mounts: [
            { destinationPath: "/skipped" },
            {
              composeServiceName: "web",
              destinationPath: "/cache",
              readOnly: true,
              subpath: "nested",
            },
          ],
        },
      ],
      new Map([
        ["loc-bind-empty", "/unused"],
        ["loc-vol-sub", volumeId],
      ]),
      webResolved,
    );

    assertEquals(fragment.services?.web?.volumes, [
      {
        type: "volume",
        source: volumeId,
        target: "/cache",
        read_only: true,
        volume: { subpath: "nested" },
      },
    ]);
    assertEquals(fragment.volumes?.[volumeId], {
      name: volumeId,
      external: true,
    });
  });

  it("throws when a bind mount is missing its host path", () => {
    assertThrows(
      () =>
        buildStorageVolumesFragment(
          [{
            storageId: "st-bind",
            locationId: "loc-missing",
            kind: "directory",
            name: "data",
            provider: "path",
            serverId: "srv",
            mounts: [{
              composeServiceName: "web",
              destinationPath: "/data",
            }],
          }],
          new Map(),
          webResolved,
        ),
      Error,
      "Missing host path for location loc-missing",
    );
  });

  it("falls back to the mount-path map when volumeName is omitted", () => {
    const fragment = buildStorageVolumesFragment(
      [{
        storageId: "st-vol",
        locationId: "loc-vol",
        kind: "volume",
        name: "data",
        provider: "docker",
        serverId: "srv",
        volumeName: "",
        mounts: [{
          composeServiceName: "web",
          destinationPath: "/vol",
        }],
      }],
      new Map([["loc-vol", "tp-from-map"]]),
      webResolved,
    );
    assertEquals(fragment.volumes?.["tp-from-map"], {
      name: "tp-from-map",
      external: true,
    });
  });

  it("throws when a docker volume has neither volumeName nor a mapped path", () => {
    assertThrows(
      () =>
        buildStorageVolumesFragment(
          [{
            storageId: "st-vol",
            locationId: "loc-vol",
            kind: "volume",
            name: "data",
            provider: "docker",
            serverId: "srv",
            mounts: [{
              composeServiceName: "web",
              destinationPath: "/data",
            }],
          }],
          new Map(),
          webResolved,
        ),
      Error,
      "Missing docker volume path for location loc-vol",
    );
  });
});

describe("declaredVolumeUsers", () => {
  const owner = new Map([["st-1", { uid: 15001, gid: 15001 }]]);
  const entry = (
    over: Partial<Parameters<typeof declaredVolumeUsers>[0][number]> = {},
  ) => ({
    storageId: "st-1",
    locationId: "loc-1",
    kind: "directory" as const,
    name: "uploads",
    provider: "path" as const,
    serverId: "srv",
    folder: { owner: "alice", scope: "production", slug: "uploads" },
    mounts: [{ composeServiceName: "db", destinationPath: "/data" }],
    ...over,
  });
  const resolvedWith = (user: unknown): ResolvedComposeModel => ({
    serviceNames: ["db"],
    services: { db: { image: "db:1", user } },
  });

  it("reads a number or uid:gid and ignores a name", () => {
    assertEquals(numericComposeUser(999), 999);
    assertEquals(numericComposeUser("999"), 999);
    assertEquals(numericComposeUser("999:70"), 999);
    assertEquals(numericComposeUser("postgres"), null);
    assertEquals(numericComposeUser("postgres:postgres"), null);
    assertEquals(numericComposeUser(""), null);
    assertEquals(numericComposeUser("-1"), null);
    assertEquals(numericComposeUser("99999999999"), null);
    assertEquals(numericComposeUser(undefined), null);
  });

  it("returns the declared uid of a container that mounts the volume", () => {
    assertEquals(
      declaredVolumeUsers([entry()], resolvedWith("999:999"), owner),
      { users: [{ storageId: "st-1", uid: 999 }], named: [] },
    );
  });

  it("needs no entry for the owner's own uid, root, or no declared user", () => {
    for (const user of [15001, "15001:15001", 0, "0", undefined, ""]) {
      assertEquals(
        declaredVolumeUsers([entry()], resolvedWith(user), owner),
        { users: [], named: [] },
        String(user),
      );
    }
  });

  it("lists a named user so the caller can say it was not handled", () => {
    assertEquals(
      declaredVolumeUsers([entry()], resolvedWith("postgres"), owner),
      {
        users: [],
        named: [{
          storageId: "st-1",
          composeServiceName: "db",
          user: "postgres",
        }],
      },
    );
  });

  it("lists a uid once per volume, and skips volumes without an owner folder", () => {
    const twice = entry({
      mounts: [
        { composeServiceName: "db", destinationPath: "/data" },
        { composeServiceName: "db", destinationPath: "/backup" },
      ],
    });
    assertEquals(
      declaredVolumeUsers([twice], resolvedWith(999), owner).users.length,
      1,
    );
    assertEquals(
      declaredVolumeUsers(
        [entry({ folder: undefined })],
        resolvedWith(999),
        owner,
      )
        .users,
      [],
    );
    assertEquals(
      declaredVolumeUsers(
        [entry({ kind: "volume" as never })],
        resolvedWith(999),
        owner,
      )
        .users,
      [],
    );
  });
});
