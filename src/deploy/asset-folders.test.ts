import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  assertFolderUnchanged,
  ensureAssetFolder,
  ensureScopeFolders,
  ensureServiceFolder,
  ensureVolumeFolder,
  FolderChangedError,
  listAssetFolders,
  readFolderRecord,
  recordAssetFolder,
  removeFolderRecord,
} from "./asset-folders.ts";
import type { RunFn } from "./ensure-principal.ts";
import { FolderSymlinkError } from "../paths/layout.ts";
import type { FolderRef } from "../contracts/directory-names.ts";

const test = Deno.test.bind(Deno);

const ASSET = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70";
const parts = { owner: "alice", scope: "production", slug: "example.com" };
const service: FolderRef = { ...parts, kind: "service" };

type Made = { path: string; mode: string; owner: string };

/** A host that records each `install -d` and creates the directory for real. */
function recorder(): { runFn: RunFn; made: Made[] } {
  const made: Made[] = [];
  const runFn: RunFn = async (_command, args) => {
    const at = args.indexOf("install");
    const rest = args.slice(at + 1);
    const mode = rest[rest.indexOf("-m") + 1];
    const owner = `${rest[rest.indexOf("-o") + 1]}:${
      rest[rest.indexOf("-g") + 1]
    }`;
    const path = rest[rest.length - 1];
    await Deno.mkdir(path, { recursive: true });
    made.push({ path, mode, owner });
    return { success: true, stdout: "", stderr: "" };
  };
  return { runFn, made };
}

async function withRoots(
  fn: (
    layout: { principalHomeRoot: string; daemonStateDir: string },
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-assets-" });
  try {
    const layout = {
      principalHomeRoot: join(dir, "users"),
      daemonStateDir: join(dir, "state"),
    };
    await Deno.mkdir(join(layout.principalHomeRoot, "alice"), {
      recursive: true,
    });
    await fn(layout);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("scope folders are root-owned and made parent before child", async () => {
  await withRoots(async (layout) => {
    const { runFn, made } = recorder();
    await ensureScopeFolders(layout, "alice", "production", runFn);
    const root = layout.principalHomeRoot;
    assertEquals(made, [
      { path: `${root}/alice/production`, mode: "0750", owner: "root:alice" },
      {
        path: `${root}/alice/production/services`,
        mode: "0750",
        owner: "root:alice",
      },
      {
        path: `${root}/alice/production/volumes`,
        mode: "0750",
        owner: "root:alice",
      },
    ]);
  });
});

test("a service folder is root's with releases/, and shared/ and logs/ the owner's", async () => {
  await withRoots(async (layout) => {
    const { runFn, made } = recorder();
    const folder = await ensureServiceFolder(layout, parts, runFn);
    const base =
      `${layout.principalHomeRoot}/alice/production/services/example.com`;
    assertEquals(folder, base);
    assertEquals(made.slice(3), [
      { path: base, mode: "0750", owner: "root:alice" },
      { path: `${base}/releases`, mode: "0750", owner: "root:alice" },
      { path: `${base}/shared`, mode: "0750", owner: "alice:alice" },
      { path: `${base}/logs`, mode: "0750", owner: "alice:alice" },
    ]);
  });
});

test("a volume folder belongs to the owner, in the common scope too", async () => {
  await withRoots(async (layout) => {
    const { runFn, made } = recorder();
    const folder = await ensureVolumeFolder(
      layout,
      { owner: "alice", scope: "common", slug: "uploads" },
      runFn,
    );
    assertEquals(
      folder,
      `${layout.principalHomeRoot}/alice/common/volumes/uploads`,
    );
    assertEquals(made.at(-1), {
      path: folder,
      mode: "0750",
      owner: "alice:alice",
    });
  });
});

test("names outside the shared rules never reach the host", async () => {
  await withRoots(async (layout) => {
    const { runFn, made } = recorder();
    for (
      const bad of [
        { ...parts, slug: ".." },
        { ...parts, slug: "a/b" },
        { ...parts, scope: "home" },
        { ...parts, scope: "Production" },
        { ...parts, owner: "Alice" },
      ]
    ) {
      await assertRejects(
        () => ensureServiceFolder(layout, bad, runFn),
        TypeError,
      );
    }
    assertEquals(made, []);
  });
});

test("a link inside the tree is refused before anything is made", async () => {
  await withRoots(async (layout) => {
    const { runFn, made } = recorder();
    const outside = join(layout.principalHomeRoot, "..", "outside");
    await Deno.mkdir(outside);
    await Deno.symlink(
      outside,
      join(layout.principalHomeRoot, "alice", "production"),
    );
    await assertRejects(
      () => ensureServiceFolder(layout, parts, runFn),
      FolderSymlinkError,
    );
    assertEquals(made, []);
  });
});

test("a failed host call is an error", async () => {
  await withRoots(async (layout) => {
    const runFn: RunFn = () =>
      Promise.resolve({
        success: false,
        stdout: "",
        stderr: "refused by host",
      });
    await assertRejects(
      () => ensureVolumeFolder(layout, { ...parts, slug: "uploads" }, runFn),
      Error,
      "refused by host",
    );
  });
});

test("the record keeps the components an asset was first created with", async () => {
  await withRoots(async (layout) => {
    const now = () => new Date("2026-10-17T12:00:00Z");
    assertEquals(await readFolderRecord(layout, ASSET), null);
    assertEquals(await recordAssetFolder(layout, ASSET, service, now), true);
    // The same components again: nothing to write.
    assertEquals(await recordAssetFolder(layout, ASSET, service, now), false);
    const record = await readFolderRecord(layout, ASSET);
    assertEquals(record, {
      ...service,
      assetId: ASSET,
      created: "2026-10-17T12:00:00.000Z",
    });
    const path = join(layout.daemonStateDir, "folders", `${ASSET}.json`);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o640);
    await removeFolderRecord(layout, ASSET);
    await removeFolderRecord(layout, ASSET);
    assertEquals(await readFolderRecord(layout, ASSET), null);
  });
});

test("changed components for a known asset are refused with folder_changed", async () => {
  await withRoots(async (layout) => {
    const { runFn, made } = recorder();
    await ensureAssetFolder(layout, ASSET, service, runFn);
    const before = made.length;
    for (
      const changed of [
        { ...service, slug: "other.example" },
        { ...service, scope: "staging" },
        { ...service, owner: "bob" },
        { ...service, kind: "volume" as const },
      ]
    ) {
      const err = await assertRejects(
        () => ensureAssetFolder(layout, ASSET, changed, runFn),
        FolderChangedError,
      );
      assertEquals(err.code, "folder_changed");
      await assertRejects(
        () => assertFolderUnchanged(layout, ASSET, changed),
        FolderChangedError,
      );
    }
    // Refused before any path was touched.
    assertEquals(made.length, before);
    // The same components still pass.
    await ensureAssetFolder(layout, ASSET, service, runFn);
  });
});

test("ensureAssetFolder picks the folders by kind and writes the record", async () => {
  await withRoots(async (layout) => {
    const { runFn } = recorder();
    const volumeId = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71";
    const volume: FolderRef = { ...parts, kind: "volume", slug: "uploads" };
    assertEquals(
      await ensureAssetFolder(layout, volumeId, volume, runFn),
      `${layout.principalHomeRoot}/alice/production/volumes/uploads`,
    );
    assertEquals((await readFolderRecord(layout, volumeId))?.kind, "volume");
    await assertRejects(
      () => ensureAssetFolder(layout, "not-a-uuid", volume, runFn),
      TypeError,
    );
  });
});

const listRun = (stdout: string, success = true): RunFn => () =>
  Promise.resolve({ success, stdout, stderr: "" });

test("listAssetFolders reads the helper's complete listing", async () => {
  assertEquals(
    await listAssetFolders(listRun(
      "alice production service example.com\nalice common volume shared\ncomplete\n",
    )),
    [
      {
        owner: "alice",
        scope: "production",
        kind: "service",
        slug: "example.com",
        present: true,
      },
      {
        owner: "alice",
        scope: "common",
        kind: "volume",
        slug: "shared",
        present: true,
      },
    ],
  );
  assertEquals(await listAssetFolders(listRun("complete\n")), []);
});

test("listAssetFolders says nothing when the listing was cut short or failed", async () => {
  // No closing line: the walk may have stopped early, so no folder is reported.
  assertEquals(
    await listAssetFolders(listRun("alice production volume uploads\n")),
    null,
  );
  assertEquals(await listAssetFolders(listRun("", false)), null);
  assertEquals(
    await listAssetFolders(() => Promise.reject(new Error("no sudo"))),
    null,
  );
});

test("listAssetFolders drops lines that are not folders the rules would make", async () => {
  assertEquals(
    await listAssetFolders(listRun(
      [
        "alice production volume ok",
        "alice volumes volume reserved-scope",
        "Alice production volume bad-owner",
        "alice production other kind",
        "alice production volume too many fields",
        "alice production volume ..",
        "complete",
      ].join("\n"),
    )),
    [{
      owner: "alice",
      scope: "production",
      kind: "volume",
      slug: "ok",
      present: true,
    }],
  );
});
