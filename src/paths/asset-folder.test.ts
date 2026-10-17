import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  assertNoSymlinkComponents,
  assetFolder,
  assetKindDir,
  currentLink,
  folderRecordPath,
  FolderSymlinkError,
  hostingFilesDir,
  logsDir,
  ownerRoot,
  publicDir,
  publishStagingDir,
  releaseDir,
  releasesDir,
  scopeDir,
  serviceFolder,
  sharedDir,
  volumeFolder,
} from "./layout.ts";
import type { FolderRef } from "../contracts/directory-names.ts";

const test = Deno.test.bind(Deno);

const layout = { principalHomeRoot: "/srv/users" };
const parts = { owner: "alice", scope: "production", slug: "example.com" };
const RELEASE = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70";

type Vectors = {
  folderRefs: Array<{ ref: FolderRef; host: string }>;
  badFolderRefs: Array<{ why: string; ref: unknown }>;
};

const vectors = JSON.parse(
  Deno.readTextFileSync(
    new URL("../contracts/layout-vectors.json", import.meta.url),
  ),
) as Vectors;

test("assetFolder resolves every shared vector to its host path", () => {
  assertEquals(vectors.folderRefs.length > 3, true);
  for (const row of vectors.folderRefs) {
    assertEquals(assetFolder(layout, row.ref), row.host);
  }
});

test("assetFolder refuses every bad reference in the shared vectors", () => {
  for (const row of vectors.badFolderRefs) {
    assertThrows(
      () => assetFolder(layout, row.ref as FolderRef),
      TypeError,
      undefined,
      row.why,
    );
  }
});

test("assetFolder follows a moved home root", () => {
  assertEquals(
    assetFolder({ principalHomeRoot: "/p" }, {
      ...parts,
      kind: "volume",
      slug: "uploads",
    }),
    "/p/alice/production/volumes/uploads",
  );
});

test("the helpers build the spec tree below a service folder", () => {
  const base = "/srv/users/alice/production/services/example.com";
  assertEquals(serviceFolder(layout, parts), base);
  assertEquals(publicDir(layout, parts), `${base}/public`);
  assertEquals(releasesDir(layout, parts), `${base}/releases`);
  assertEquals(
    releaseDir(layout, parts, RELEASE),
    `${base}/releases/${RELEASE}`,
  );
  assertEquals(currentLink(layout, parts), `${base}/current`);
  assertEquals(sharedDir(layout, parts), `${base}/shared`);
  assertEquals(logsDir(layout, parts), `${base}/logs`);
  assertEquals(hostingFilesDir(layout, parts), `${base}/.turbopanel-hosting`);
  assertEquals(
    volumeFolder(layout, { ...parts, slug: "uploads" }),
    "/srv/users/alice/production/volumes/uploads",
  );
});

test("owner, scope and kind folders", () => {
  assertEquals(ownerRoot(layout, "alice"), "/srv/users/alice");
  assertEquals(scopeDir(layout, "alice", "common"), "/srv/users/alice/common");
  assertEquals(
    assetKindDir(layout, "alice", "staging", "volume"),
    "/srv/users/alice/staging/volumes",
  );
  assertThrows(() => ownerRoot(layout, "Alice"), TypeError);
  assertThrows(() => scopeDir(layout, "alice", "home"), TypeError);
  assertThrows(() => scopeDir(layout, "alice", ".."), TypeError);
});

test("traversal and bad ids are refused", () => {
  for (const slug of ["..", "a/b", "../x", "a..b", ".hidden", "a b", ""]) {
    assertThrows(() => serviceFolder(layout, { ...parts, slug }), TypeError);
  }
  assertThrows(() => releaseDir(layout, parts, "../x"), TypeError);
  assertThrows(() => releaseDir(layout, parts, "r1"), TypeError);
  assertThrows(() => publishStagingDir(layout, "alice.web.r1"), TypeError);
  assertThrows(
    () => folderRecordPath({ daemonStateDir: "/s" }, "x"),
    TypeError,
  );
});

test("staging and record paths are keyed on a UUID only", () => {
  assertEquals(
    publishStagingDir(layout, RELEASE),
    `/srv/users/.tp-staging/${RELEASE}`,
  );
  assertEquals(
    folderRecordPath({ daemonStateDir: "/var/lib/turbopanel" }, RELEASE),
    `/var/lib/turbopanel/folders/${RELEASE}.json`,
  );
});

test("assertNoSymlinkComponents accepts missing and plain paths, refuses a link", async () => {
  const root = await Deno.makeTempDir();
  try {
    const target = join(root, "alice/production/services/example.com");
    await assertNoSymlinkComponents(root, target);
    await Deno.mkdir(join(root, "alice/production"), { recursive: true });
    await assertNoSymlinkComponents(root, target);
    await Deno.mkdir(join(root, "elsewhere"));
    await Deno.symlink(
      join(root, "elsewhere"),
      join(root, "alice/production/services"),
    );
    await assertRejects(
      () => assertNoSymlinkComponents(root, target),
      FolderSymlinkError,
    );
    await assertRejects(
      () => assertNoSymlinkComponents(root, join(root, "..", "x")),
      TypeError,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
