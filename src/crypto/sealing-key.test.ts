import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { decodeBase64Url } from "@std/encoding/base64url";
import { join } from "@std/path";
import { sealingKid } from "./hpke.ts";
import {
  buildSealingKeyPayload,
  loadOrCreateSealingKey,
  SEALING_KEY_FILE,
} from "./sealing-key.ts";

const test = Deno.test.bind(Deno);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-sealing-key-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("the sealing key is created 0600, reused on the next start and fingerprinted like the panel does", async () => {
  await withTempDir(async (dir) => {
    const first = await loadOrCreateSealingKey(dir, "key-1");
    const mode = (await Deno.stat(join(dir, SEALING_KEY_FILE))).mode ?? 0;
    assertEquals(mode & 0o777, 0o600);
    assertEquals(first.privateRaw.length, 32);
    assertEquals(decodeBase64Url(first.pub).length, 32);
    assertEquals(first.kid, await sealingKid(decodeBase64Url(first.pub)));
    assertEquals(first.kid.length, 43);

    const second = await loadOrCreateSealingKey(dir, "key-1");
    assertEquals(second.kid, first.kid);
    assertEquals(second.pub, first.pub);
  });
});

test("a new server key id regenerates the sealing key", async () => {
  await withTempDir(async (dir) => {
    const before = await loadOrCreateSealingKey(dir, "key-1");
    const after = await loadOrCreateSealingKey(dir, "key-2");
    assertNotEquals(after.kid, before.kid);
    assertEquals((await loadOrCreateSealingKey(dir, "key-2")).kid, after.kid);
  });
});

test("an unreadable key file is replaced instead of crashing the daemon", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, SEALING_KEY_FILE), "{not json");
    const key = await loadOrCreateSealingKey(dir, "key-1");
    assert(key.kid.length === 43);
  });
});

test("the registration payload binds the public key bytes", () => {
  assertEquals(buildSealingKeyPayload("abc"), "tp-sealing-key\nabc");
});
