/**
 * Host-free coverage for the per-release manifest at
 * `releases/<releaseId>/.turbopanel/release.json`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  readReleaseManifest,
  releaseManifestPath,
  type ReleaseManifestV1,
  writeReleaseManifest,
} from "./deployment-json.ts";
import { RELEASE_METADATA_DIRNAME } from "./release-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const BASE: ReleaseManifestV1 = {
  version: 1,
  serviceId: "svc-1",
  composeServiceName: "web",
  releaseId: "rel-1",
  sourceId: "src-1",
  commitSha: "abc123def456",
  ref: "main",
  promotedAt: "2026-01-15T12:00:00.000Z",
};

async function withReleaseDir(
  fn: (releaseDir: string) => Promise<void>,
): Promise<void> {
  const releaseDir = await Deno.makeTempDir({ prefix: "tp-release-manifest-" });
  try {
    await fn(releaseDir);
  } finally {
    await Deno.remove(releaseDir, { recursive: true });
  }
}

test("writeReleaseManifest / readReleaseManifest round-trip", async () => {
  await withReleaseDir(async (releaseDir) => {
    await writeReleaseManifest(releaseDir, BASE);
    assertEquals(await readReleaseManifest(releaseDir), BASE);
    assertEquals(
      releaseManifestPath(releaseDir),
      join(releaseDir, RELEASE_METADATA_DIRNAME, "release.json"),
    );
  });
});

test("readReleaseManifest returns null when the file is missing", async () => {
  await withReleaseDir(async (releaseDir) => {
    assertEquals(await readReleaseManifest(releaseDir), null);
  });
});

test("readReleaseManifest returns null for invalid JSON", async () => {
  await withReleaseDir(async (releaseDir) => {
    await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
      recursive: true,
    });
    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      "{ not-json",
    );
    assertEquals(await readReleaseManifest(releaseDir), null);
  });
});

test("readReleaseManifest rejects a wrong version or empty required fields", async () => {
  await withReleaseDir(async (releaseDir) => {
    await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
      recursive: true,
    });
    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      JSON.stringify({ ...BASE, version: 2 }),
    );
    assertEquals(await readReleaseManifest(releaseDir), null);

    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      JSON.stringify({ ...BASE, commitSha: "" }),
    );
    assertEquals(await readReleaseManifest(releaseDir), null);

    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      JSON.stringify([BASE]),
    );
    assertEquals(await readReleaseManifest(releaseDir), null);
  });
});

test("readReleaseManifest accepts optional native and railpack fields", async () => {
  await withReleaseDir(async (releaseDir) => {
    const full: ReleaseManifestV1 = {
      ...BASE,
      commitMessage: "ship it",
      commitAuthor: "ops@example.com",
      standaloneOutput: true,
      staticExport: false,
      nativeStart: { kind: "file", path: "server.js" },
      startCommand: "node dist/main.js",
      startupFile: "dist/main.js",
      imageTag: "tp-svc-1:rel-1",
      imageDigest: "sha256:deadbeef",
      railpackFrontendVersion: "0.9.0",
      railpackPlanVersion: "1",
    };
    await writeReleaseManifest(releaseDir, full);
    assertEquals(await readReleaseManifest(releaseDir), full);
  });
});

test("readReleaseManifest ignores unknown extra fields but keeps known ones", async () => {
  await withReleaseDir(async (releaseDir) => {
    await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
      recursive: true,
    });
    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      JSON.stringify({ ...BASE, futureFlag: true, imageTag: "img:1" }),
    );
    const read = await readReleaseManifest(releaseDir);
    assertEquals(read?.imageTag, "img:1");
    assertEquals(read?.releaseId, BASE.releaseId);
  });
});

test("readReleaseManifest rejects non-boolean standalone/static flags", async () => {
  await withReleaseDir(async (releaseDir) => {
    await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
      recursive: true,
    });
    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      JSON.stringify({ ...BASE, standaloneOutput: "yes" }),
    );
    assertEquals(await readReleaseManifest(releaseDir), null);
  });
});

test("readReleaseManifest rejects a recorded start it could not render safely", async () => {
  const unsafe = [
    "next-start",
    { kind: "file", path: "../../etc/x.js" },
    { kind: "shell", command: "id" },
  ];
  await Promise.all(
    unsafe.map((nativeStart) =>
      withReleaseDir(async (releaseDir) => {
        await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
          recursive: true,
        });
        await Deno.writeTextFile(
          releaseManifestPath(releaseDir),
          JSON.stringify({ ...BASE, nativeStart }),
        );
        assertEquals(await readReleaseManifest(releaseDir), null);
      })
    ),
  );
});

test("readReleaseManifest rejects non-string railpack version fields", async () => {
  await withReleaseDir(async (releaseDir) => {
    await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
      recursive: true,
    });
    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      JSON.stringify({ ...BASE, startCommand: ["sh"] }),
    );
    assertEquals(await readReleaseManifest(releaseDir), null);
    await Deno.writeTextFile(
      releaseManifestPath(releaseDir),
      JSON.stringify({ ...BASE, railpackFrontendVersion: 9 }),
    );
    assertEquals(await readReleaseManifest(releaseDir), null);
  });
});

test("readReleaseManifest rethrows a non-NotFound read error", async () => {
  await withReleaseDir(async (releaseDir) => {
    await Deno.mkdir(join(releaseDir, RELEASE_METADATA_DIRNAME), {
      recursive: true,
    });
    await Deno.mkdir(releaseManifestPath(releaseDir), { recursive: true });
    await assertRejects(
      () => readReleaseManifest(releaseDir),
      Error,
    );
  });
});

test("writeReleaseManifest replaces atomically and leaves no temp file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-rel-atomic-" });
  try {
    await writeReleaseManifest(dir, { ...BASE, commitSha: "aaa" });
    await writeReleaseManifest(dir, { ...BASE, commitSha: "bbb" });
    assertEquals((await readReleaseManifest(dir))?.commitSha, "bbb");
    const names = [];
    for await (
      const e of Deno.readDir(join(dir, RELEASE_METADATA_DIRNAME))
    ) names.push(e.name);
    assertEquals(names, ["release.json"]);
    const mode = (await Deno.stat(releaseManifestPath(dir))).mode! & 0o777;
    assertEquals(mode, 0o640);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
