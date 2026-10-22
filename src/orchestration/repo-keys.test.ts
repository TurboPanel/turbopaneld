import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";
import { checkKey, type KeyMeta } from "../../scripts/check-repo-keys.ts";
import { readPgpKey, sha256Hex } from "../../scripts/lib/pgp-key.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const DOCKER_FILES = join(DAEMON_ROOT, "orchestration/roles/docker/files");

async function bundledDocker(): Promise<{ meta: KeyMeta; key: Uint8Array }> {
  const meta = JSON.parse(
    await Deno.readTextFile(join(DOCKER_FILES, "docker.asc.json")),
  ) as KeyMeta;
  const key = await Deno.readFile(join(DOCKER_FILES, "docker.asc"));
  return { meta, key };
}

/** A tiny v4 key packet plus a self-signature carrying creation and expiry. */
function syntheticKey(
  created: number,
  expirySeconds: number | null,
): Uint8Array {
  const u32 = (
    n: number,
  ) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const keyBody = [4, ...u32(created), 1, 0, 16, 0xab, 0xcd, 0, 17, 1, 0, 1];
  const subpackets = [5, 2, ...u32(created + 10)];
  if (expirySeconds !== null) subpackets.push(5, 9, ...u32(expirySeconds));
  const sigBody = [
    4,
    0x13,
    1,
    8,
    subpackets.length >> 8,
    subpackets.length & 255,
    ...subpackets,
    0,
    0,
    0x12,
    0x34,
    0,
    8,
    0xff,
  ];
  return Uint8Array.from([
    0xc0 | 6,
    keyBody.length,
    ...keyBody,
    0xc0 | 2,
    sigBody.length,
    ...sigBody,
  ]);
}

test("the bundled Docker key matches its metadata and never expires", async () => {
  const { meta, key } = await bundledDocker();
  const info = await readPgpKey(key);
  assertEquals(info.fingerprint, meta.fingerprint);
  assertEquals(info.expires, null);
  assertEquals(await sha256Hex(key), meta.sha256);
  const report = await checkKey(meta, key, null);
  assertEquals(report.problems, []);
});

test("the role's fingerprint list contains the bundled key's fingerprint", async () => {
  const { meta } = await bundledDocker();
  const vars = await Deno.readTextFile(
    join(DAEMON_ROOT, "orchestration/roles/docker/vars/main.yml"),
  );
  assertStringIncludes(vars, `'${meta.fingerprint}'`);
});

test("checkKey reports metadata drift, live-key drift and near expiry", async () => {
  const { meta, key } = await bundledDocker();
  const wrongPrint = await checkKey(
    { ...meta, fingerprint: "A".repeat(40) },
    key,
    null,
  );
  assertEquals(wrongPrint.problems.length, 1);

  const liveSame = await checkKey(meta, key, key);
  assertEquals(liveSame.problems, []);

  const created = 1_700_000_000;
  const soon = syntheticKey(created, 30 * 86400);
  const info = await readPgpKey(soon);
  assertEquals(info.expires?.getTime(), (created + 30 * 86400) * 1000);
  const near = await checkKey(
    {
      name: "x",
      source: "",
      sha256: await sha256Hex(soon),
      fingerprint: info.fingerprint,
      expires: info.expires!.toISOString(),
    },
    soon,
    null,
    new Date((created + 10 * 86400) * 1000),
  );
  assertEquals(near.problems.length, 1);
  assertStringIncludes(near.problems[0]!, "expires in 20 days");

  const never = await readPgpKey(syntheticKey(created, null));
  assertEquals(never.expires, null);
});
