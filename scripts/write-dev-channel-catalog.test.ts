import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ARTIFACTS,
  artifactFromDist,
  writeDevChannelCatalog,
} from "./write-dev-channel-catalog.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("artifactFromDist hashes overlay files and rejects empty or missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-overlay-" });
  try {
    const filename = ARTIFACTS["linux-amd64"];
    await Deno.writeFile(join(dir, filename), new Uint8Array([9, 9, 9]));
    const entry = await artifactFromDist(filename, dir);
    assertEquals(entry.url, `./${filename}`);
    assertEquals(entry.size, 3);

    await Deno.writeFile(join(dir, "empty.bin"), new Uint8Array());
    await assertRejects(
      () => artifactFromDist("empty.bin", dir),
      Error,
      "Empty overlay artifact",
    );
    await assertRejects(
      () => artifactFromDist("missing.bin", dir),
      Error,
      "Missing overlay artifact",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeDevChannelCatalog writes relative catalog files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-overlay-cat-" });
  try {
    for (const filename of Object.values(ARTIFACTS)) {
      await Deno.writeFile(join(dir, filename), new Uint8Array([1]));
    }
    await writeDevChannelCatalog({
      commit: "abc1234+1",
      buildId: "dev-abc1234+1",
      builtAt: "2026-01-01T00:00:00.000Z",
    }, dir);
    const manifest = JSON.parse(await Deno.readTextFile(join(dir, "manifest.json")));
    const catalog = JSON.parse(await Deno.readTextFile(join(dir, "channels.json")));
    assertEquals(manifest.commit, "abc1234+1");
    assertEquals(manifest.binaryArtifacts["linux-amd64"].url, "./turbopaneld-amd64.tar.zst");
    assertEquals(catalog.defaultChannel, "trunk");
    assertEquals(catalog.channels.trunk.manifestUrl, "./manifest.json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
