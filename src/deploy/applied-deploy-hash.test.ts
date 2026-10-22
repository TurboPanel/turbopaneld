import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  clearAppliedDeployHash,
  readAppliedDeployHash,
  writeAppliedDeployHash,
} from "./applied-deploy-hash.ts";

Deno.test("an applied hash is read back, cleared, and ignored when another daemon build wrote it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-applied-hash-" });
  try {
    assertEquals(await readAppliedDeployHash(dir), null);
    await writeAppliedDeployHash(dir, "a".repeat(64));
    assertEquals(await readAppliedDeployHash(dir), "a".repeat(64));
    await Deno.writeTextFile(
      join(dir, "applied-deploy-hash"),
      `0.0.0+old-build\n${"a".repeat(64)}\n`,
    );
    assertEquals(await readAppliedDeployHash(dir), null);
    await writeAppliedDeployHash(dir, "b".repeat(64));
    await clearAppliedDeployHash(dir);
    assertEquals(await readAppliedDeployHash(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
