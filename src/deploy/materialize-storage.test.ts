import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { setDockerCliIoForTest } from "./docker-cli.ts";
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
    assertEquals(
      filePath,
      join(
        storageHostPath(layout, "org-1", "stor-file", "loc-file"),
        "notes.txt",
      ),
    );
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

test("materializeLocation creates docker volume via runDocker", async () => {
  await withTempLayout(async (layout) => {
    const calls: string[][] = [];
    const restore = setDockerCliIoForTest({
      runRaw: (_command, args) => {
        calls.push([...args]);
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      },
    });
    try {
      const name = await materializeLocation(
        layout,
        "org-1",
        {
          storageId: "stor-vol",
          locationId: "loc-vol",
          kind: "volume",
          name: "data",
          provider: "docker",
          volumeName: "tp-00000000-cache",
          serverId: "srv",
          mounts: [],
        },
        undefined,
        "",
      );
      assertEquals(name, "tp-00000000-cache");
      assertEquals(calls[0], ["volume", "create", "tp-00000000-cache"]);
    } finally {
      restore();
    }
  });
});

test("materializeLocation surfaces docker volume create failure", async () => {
  await withTempLayout(async (layout) => {
    const restore = setDockerCliIoForTest({
      runRaw: () =>
        Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "volume exists",
        }),
    });
    try {
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
              volumeName: "tp-dup",
              serverId: "srv",
              mounts: [],
            },
            undefined,
            "",
          ),
        Error,
        "volume exists",
      );
    } finally {
      restore();
    }
  });
});

test("materializeStorageEntries decrypts tpdaemon envelopes", async () => {
  await withTempLayout(async (layout) => {
    const paths = await materializeStorageEntries(
      layout,
      "org-1",
      [
        {
          storageId: "stor-sec",
          locationId: "loc-sec",
          kind: "file",
          name: "secret.txt",
          provider: "path",
          serverId: "srv",
          contentEnvelope: "tpdaemon.v1.ciphertext",
          mounts: [],
        },
      ],
      undefined,
      (envelopes) => {
        assertEquals(envelopes, ["tpdaemon.v1.ciphertext"]);
        return Promise.resolve(["decrypted-body"]);
      },
    );
    const filePath = paths.get("loc-sec");
    if (filePath === undefined) {
      throw new TypeError("expected mount path for loc-sec");
    }
    assertEquals(await Deno.readTextFile(filePath), "decrypted-body");
  });
});

test("materializeStorageEntries requires decrypt when envelopes are present", async () => {
  await withTempLayout(async (layout) => {
    await assertRejects(
      () =>
        materializeStorageEntries(layout, "org-1", [
          {
            storageId: "stor-sec",
            locationId: "loc-sec",
            kind: "file",
            name: "secret.txt",
            provider: "path",
            serverId: "srv",
            contentEnvelope: "tpsecret.v1.x",
            mounts: [],
          },
        ]),
      Error,
      "secrets decrypt is unavailable",
    );
  });
});

test("materializeStorageEntries rejects decrypt length mismatch", async () => {
  await withTempLayout(async (layout) => {
    await assertRejects(
      () =>
        materializeStorageEntries(
          layout,
          "org-1",
          [
            {
              storageId: "stor-sec",
              locationId: "loc-sec",
              kind: "file",
              name: "secret.txt",
              provider: "path",
              serverId: "srv",
              contentEnvelope: "tpdaemon.v1.x",
              mounts: [],
            },
          ],
          undefined,
          () => Promise.resolve([]),
        ),
      Error,
      "unexpected length",
    );
  });
});

test("materializeStorageEntries ignores unresolved principalId", async () => {
  await withTempLayout(async (layout) => {
    const paths = await materializeStorageEntries(
      layout,
      "org-1",
      [
        {
          storageId: "stor-dir",
          locationId: "loc-dir",
          kind: "directory",
          name: "data",
          provider: "path",
          serverId: "srv",
          principalId: "missing-principal",
          mounts: [],
        },
      ],
      [
        {
          principalId: "other-id",
          username: "siteuser",
        },
      ],
    );
    const hostPath = paths.get("loc-dir");
    if (hostPath === undefined) {
      throw new TypeError("expected mount path");
    }
    assertEquals(
      hostPath,
      storageHostPath(layout, "org-1", "stor-dir", "loc-dir"),
    );
  });
});
