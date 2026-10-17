import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import type { EnvironmentDeployStorageMaterial } from "../contracts/commands-contracts.ts";
import {
  assertMountShape,
  buildStorageVolumesFragment,
} from "./apply-storage-volumes.ts";
import {
  assertComposeHostPathsConfined,
  collectResolvedHostPaths,
  ComposeHostPathError,
} from "./compose-host-paths.ts";
import { COMPOSE_STAGE_DIRNAME } from "./compose-files.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";
import {
  materializeStorageEntries,
  resolveVolumeOwnerIds,
} from "./materialize-storage.ts";
import { ownedVolumeRoots } from "../commands/deploy-environment.ts";
import type { RunFn } from "./ensure-principal.ts";

const test = Deno.test.bind(Deno);

const STORAGE_ID = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c4d";
const folder = { owner: "alice", scope: "production", slug: "uploads" };

function volume(
  overrides: Partial<EnvironmentDeployStorageMaterial> = {},
): EnvironmentDeployStorageMaterial {
  return {
    storageId: STORAGE_ID,
    locationId: "loc-1",
    kind: "directory",
    name: "uploads",
    provider: "path",
    serverId: "srv",
    principalId: "pr-1",
    folder,
    mounts: [{ composeServiceName: "web", destinationPath: "/data" }],
    ...overrides,
  };
}

const ids = new Map([[STORAGE_ID, { uid: 15007, gid: 15007 }]]);

const resolvedWith = (user?: string): ResolvedComposeModel => ({
  serviceNames: ["web"],
  services: { web: { image: "nginx:latest", ...(user ? { user } : {}) } },
});

// -- the user a container runs as --------------------------------------------

test("a container that mounts an owner's volume runs as the owner's ids", () => {
  const fragment = buildStorageVolumesFragment(
    [volume()],
    new Map([["loc-1", "/srv/users/alice/production/volumes/uploads"]]),
    resolvedWith(),
    ids,
  );
  assertEquals(fragment.services?.web?.user, "15007:15007");
  assertEquals(fragment.services?.web?.volumes, [{
    type: "bind",
    source: "/srv/users/alice/production/volumes/uploads",
    target: "/data",
  }]);
});

test("a compose file that sets its own user keeps it, and is never refused", () => {
  for (const user of ["999", "999:999", "root", "0:0", "postgres"]) {
    const fragment = buildStorageVolumesFragment(
      [volume()],
      new Map([["loc-1", "/srv/users/alice/production/volumes/uploads"]]),
      resolvedWith(user),
      ids,
    );
    assertEquals(fragment.services?.web?.user, undefined);
    assertEquals((fragment.services?.web?.volumes as unknown[]).length, 1);
  }
});

test("a volume without a folder gets no user, as before", () => {
  const fragment = buildStorageVolumesFragment(
    [volume({ folder: undefined, sourcePath: "/srv/users/alice/volumes/x" })],
    new Map([["loc-1", "/srv/users/alice/volumes/x"]]),
    resolvedWith(),
    ids,
  );
  assertEquals(fragment.services?.web?.user, undefined);
});

test("one container cannot run as the owners of two volumes", () => {
  const other = "0192a8f4-3c1e-7a52-9b0d-000000000002";
  assertThrows(
    () =>
      buildStorageVolumesFragment(
        [
          volume(),
          volume({
            storageId: other,
            locationId: "loc-2",
            folder: { ...folder, owner: "bob", slug: "more" },
          }),
        ],
        new Map([["loc-1", "/a"], ["loc-2", "/b"]]),
        resolvedWith(),
        new Map([...ids, [other, { uid: 15008, gid: 15008 }]]),
      ),
    Error,
    "two site owners",
  );
});

test("mount paths must stay inside the container and the volume", () => {
  assertMountShape("s", { destinationPath: "/data/uploads", subpath: "a/b" });
  for (
    const bad of [
      { destinationPath: "data" },
      { destinationPath: "/a/../b" },
      { destinationPath: "/a//b" },
      { destinationPath: "/a/./b" },
      { destinationPath: "/a", subpath: "../x" },
      { destinationPath: "/a", subpath: "/abs" },
      { destinationPath: "/a", subpath: "a//b" },
    ]
  ) {
    assertThrows(() => assertMountShape("s", bad), Error);
  }
  assertThrows(
    () =>
      buildStorageVolumesFragment(
        [volume({
          mounts: [{ composeServiceName: "web", destinationPath: "/a/../b" }],
        })],
        new Map([["loc-1", "/x"]]),
        resolvedWith(),
        ids,
      ),
    Error,
    "absolute container path",
  );
});

// -- ids of the owner ----------------------------------------------------------

test("the owner's ids come from the host account, else from the deploy", async () => {
  const lookup: RunFn = (_command, args) =>
    Promise.resolve(
      args[1] === "alice"
        ? {
          success: true,
          stdout: "alice:x:15007:15007::/srv/users/alice:/usr/sbin/nologin",
          stderr: "",
        }
        : { success: false, stdout: "", stderr: "" },
    );
  assertEquals(
    await resolveVolumeOwnerIds([volume()], undefined, lookup),
    ids,
  );
  const second = volume({
    storageId: "0192a8f4-3c1e-7a52-9b0d-000000000003",
    folder: { ...folder, owner: "bob" },
  });
  assertEquals(
    (await resolveVolumeOwnerIds(
      [second],
      [{ principalId: "pr-1", username: "bob", uid: 15100, gid: 15101 }],
      lookup,
    )).get(second.storageId),
    { uid: 15100, gid: 15101 },
  );
  await assertRejects(
    () => resolveVolumeOwnerIds([second], undefined, lookup),
    Error,
    "no account",
  );
});

// -- the folder on the host ------------------------------------------------------

test("a volume with a folder is made in the scope tree and recorded", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-volume-folder-" });
  const original = Deno.Command;
  Deno.Command = class {
    spawn() {
      return {
        stdin: {
          getWriter: () => ({
            write: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: () =>
          Promise.resolve({
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          }),
      };
    }
  } as unknown as typeof Deno.Command;
  try {
    const layout = {
      stateDir: join(root, "state"),
      daemonStateDir: join(root, "daemon"),
      principalHomeRoot: join(root, "users"),
    } as LayoutPaths;
    const paths = await materializeStorageEntries(
      layout,
      "org-1",
      [volume()],
      [{ principalId: "pr-1", username: "alice" }],
    );
    assertEquals(
      paths.get("loc-1"),
      join(root, "users", "alice", "production", "volumes", "uploads"),
    );
    const record = JSON.parse(
      await Deno.readTextFile(
        join(root, "daemon", "folders", `${STORAGE_ID}.json`),
      ),
    );
    assertEquals(
      [record.owner, record.scope, record.kind, record.slug],
      ["alice", "production", "volume", "uploads"],
    );

    // The same volume named under another folder later is refused.
    await assertRejects(
      () =>
        materializeStorageEntries(
          layout,
          "org-1",
          [volume({ folder: { ...folder, slug: "moved" } })],
          [{ principalId: "pr-1", username: "alice" }],
        ),
      Error,
      "folder_changed",
    );

    // A folder that is not the deploy's site owner's is refused.
    await assertRejects(
      () =>
        materializeStorageEntries(
          layout,
          "org-1",
          [volume({ folder: { ...folder, owner: "bob" } })],
          [{ principalId: "pr-1", username: "alice" }],
        ),
      Error,
      "not the site owner",
    );
  } finally {
    Deno.Command = original;
    await Deno.remove(root, { recursive: true });
  }
});

// -- bind sources ----------------------------------------------------------------

type TreeFixture = { home: string; dir: string; stage: string };

async function withTree(fn: (f: TreeFixture) => Promise<void>): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-owner-tree-" }),
  );
  const home = join(root, "srv", "users");
  const dir = join(root, "deployments", "p", "e");
  const stage = join(dir, COMPOSE_STAGE_DIRNAME);
  await Deno.mkdir(stage, { recursive: true });
  await Deno.mkdir(join(home, "alice", "production", "volumes", "uploads"), {
    recursive: true,
  });
  await Deno.mkdir(
    join(home, "alice", "production", "services", "example.com", "shared"),
    { recursive: true },
  );
  await Deno.mkdir(join(home, "bob", "production", "volumes", "theirs"), {
    recursive: true,
  });
  try {
    await fn({ home, dir, stage });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function confine(
  f: TreeFixture,
  source: string,
  hostLevelApproved: boolean,
  volumes: string[],
): Promise<void> {
  return assertComposeHostPathsConfined(
    [collectResolvedHostPaths({
      services: {
        web: { volumes: [{ type: "bind", source, target: "/data" }] },
      },
    })],
    {
      deploymentDir: f.dir,
      stageDir: f.stage,
      hostLevelApproved,
      ownerTree: { homeRoot: f.home, volumes },
    },
  );
}

test("a bind from the deploy's own volume folder is allowed, whatever else holds", () =>
  withTree(async (f) => {
    const own = join(f.home, "alice", "production", "volumes", "uploads");
    await confine(f, own, false, [own]);
    await confine(f, join(own, "sub"), false, [own]);
  }));

test("a service folder, another owner's volume and a sibling volume are never bind sources", () =>
  withTree(async (f) => {
    const own = join(f.home, "alice", "production", "volumes", "uploads");
    for (
      const source of [
        join(
          f.home,
          "alice",
          "production",
          "services",
          "example.com",
          "shared",
        ),
        join(f.home, "alice", "production", "services"),
        join(f.home, "bob", "production", "volumes", "theirs"),
        join(f.home, "alice", "production", "volumes"),
        f.home,
      ]
    ) {
      // Even with host-level features approved.
      const err = await assertRejects(
        () => confine(f, source, true, [own]),
        ComposeHostPathError,
      );
      assertEquals(
        err.message.includes("not one of this environment's volumes"),
        true,
      );
    }
  }));

test("a link left inside a volume cannot lead a bind out of it", () =>
  withTree(async (f) => {
    const own = join(f.home, "alice", "production", "volumes", "uploads");
    await Deno.symlink(
      join(f.home, "bob", "production", "volumes", "theirs"),
      join(own, "escape"),
    );
    const err = await assertRejects(
      () => confine(f, join(own, "escape"), true, [own]),
      ComposeHostPathError,
    );
    assertEquals(err.message.includes("outside its volume folder"), true);
  }));

test("an older volume path the control plane named stays allowed", () =>
  withTree(async (f) => {
    const older = join(f.home, "alice", "volumes", "st1");
    await Deno.mkdir(older, { recursive: true });
    await confine(f, older, false, [older]);
  }));

test("only a path volume under the owner's volumes folder widens the bind allowlist", () => {
  const layout = { principalHomeRoot: "/srv/users" };
  const roots = ownedVolumeRoots(layout, {
    storageMaterial: [
      volume(),
      volume({ folder: undefined, sourcePath: "/srv/users/bob/volumes/a" }),
      volume({
        folder: undefined,
        sourcePath: "/srv/users/bob/sites/x/releases",
      }),
      volume({
        folder: undefined,
        provider: "docker",
        sourcePath: "/srv/users/bob/volumes/b",
      }),
      volume({
        folder: undefined,
        sourcePath: "/srv/users/bob/volumes/../sites/x",
      }),
    ],
  });
  assertEquals(roots, [
    "/srv/users/alice/production/volumes/uploads",
    "/srv/users/bob/volumes/a",
  ]);
});

test("two binds, one inside the other, are refused as a nested writable bind", () =>
  withTree(async (f) => {
    const own = join(f.home, "alice", "production", "volumes", "uploads");
    await Deno.mkdir(join(own, "sub"));
    const scan = collectResolvedHostPaths({
      services: {
        web: {
          volumes: [
            { type: "bind", source: own, target: "/a" },
            { type: "bind", source: join(own, "sub"), target: "/b" },
          ],
        },
      },
    });
    await assertRejects(
      () =>
        assertComposeHostPathsConfined([scan], {
          deploymentDir: f.dir,
          stageDir: f.stage,
          hostLevelApproved: false,
          ownerTree: { homeRoot: f.home, volumes: [own] },
        }),
      ComposeHostPathError,
      "writable bind",
    );
  }));
