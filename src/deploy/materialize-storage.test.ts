import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  materializeLocation,
  materializeStorageEntries,
  storageHostPath,
} from "./materialize-storage.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withTempLayout(
  fn: (layout: LayoutPaths) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-storage-test-" });
  try {
    await fn({ stateDir: root } as LayoutPaths);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("storageHostPath includes org, storage, location, and data", () => {
  const layout = { stateDir: "/var/lib/turbopanel" } as LayoutPaths;
  assertEquals(
    storageHostPath(layout, "org-1", "stor-1", "loc-1"),
    join("/var/lib/turbopanel", "storage", "org-1", "stor-1", "loc-1", "data"),
  );
});

test("materializeLocation creates a directory copy under the location data dir", async () => {
  await withTempLayout(async (layout) => {
    const hostPath = await materializeLocation(
      layout,
      "org-1",
      {
        storageId: "stor-1",
        locationId: "loc-1",
        kind: "directory",
        name: "data",
        provider: "path",
        serverId: "srv",
        mounts: [],
      },
      undefined,
      "",
    );
    const expected = storageHostPath(layout, "org-1", "stor-1", "loc-1");
    assertEquals(hostPath, expected);
    const stat = await Deno.stat(expected);
    assertEquals(stat.isDirectory, true);
  });
});

test("materializeStorageEntries keys mount paths by locationId and writes files", async () => {
  await withTempLayout(async (layout) => {
    const paths = await materializeStorageEntries(
      layout,
      "org-1",
      [
        {
          storageId: "stor-file",
          locationId: "loc-file",
          kind: "file",
          name: "notes.txt",
          provider: "path",
          serverId: "srv",
          contentEnvelope: "hello",
          mounts: [],
        },
      ],
    );
    const filePath = paths.get("loc-file");
    if (filePath === undefined) {
      throw new TypeError("expected mount path for loc-file");
    }
    assertEquals(filePath, join(
      storageHostPath(layout, "org-1", "stor-file", "loc-file"),
      "notes.txt",
    ));
    assertEquals(await Deno.readTextFile(filePath), "hello");
  });
});

test("materializeLocation rejects docker volumes without volumeName", async () => {
  await withTempLayout(async (layout) => {
    await assertRejects(
      () =>
        materializeLocation(
          layout,
          "org-1",
          {
            storageId: "stor-vol",
            locationId: "loc-vol",
            kind: "volume",
            name: "data",
            provider: "docker",
            serverId: "srv",
            mounts: [],
          },
          undefined,
          "",
        ),
      Error,
      "missing volumeName",
    );
  });
});
