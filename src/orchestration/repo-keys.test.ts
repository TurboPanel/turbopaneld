import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";
import {
  checkKey,
  type KeyMeta,
  runKeyChecks,
} from "../../scripts/check-repo-keys.ts";
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

test("runKeyChecks passes when the live key matches and flags a missing or changed live key", async () => {
  const { key } = await bundledDocker();
  const same = await runKeyChecks(DAEMON_ROOT, () => Promise.resolve(key));
  assertEquals(same.map((r) => r.problems), [[]]);

  const offline = await runKeyChecks(DAEMON_ROOT, () => Promise.resolve(null));
  assertEquals(offline[0]!.problems.length, 1);
  assertStringIncludes(offline[0]!.problems[0]!, "could not fetch");

  const other = syntheticKey(1_700_000_000, null);
  const changed = await runKeyChecks(DAEMON_ROOT, () => Promise.resolve(other));
  assertStringIncludes(changed[0]!.problems.join("\n"), "live key fingerprint");
});

test("the key reader handles old-format, long and five-byte packet lengths", async () => {
  const created = 1_700_000_000;
  const base = syntheticKey(created, null);
  const reference = await readPgpKey(base);

  const big = new Array(300).fill(0x11);
  const keyBody = (n: number[]) => [
    4,
    created >>> 24,
    (created >>> 16) & 255,
    (created >>> 8) & 255,
    created & 255,
    1,
    ...n,
  ];
  const body = keyBody([0x08, 0x00, ...big]);
  // Two-byte new-format length.
  const twoByte = Uint8Array.from([
    0xc0 | 6,
    192 + ((body.length - 192) >> 8),
    (body.length - 192) & 255,
    ...body,
  ]);
  // Five-byte new-format length and old-format one-byte / two-byte lengths.
  const fiveByte = Uint8Array.from([
    0xc0 | 6,
    255,
    0,
    0,
    body.length >> 8,
    body.length & 255,
    ...body,
  ]);
  const oldTwo = Uint8Array.from([
    0x80 | (6 << 2) | 1,
    body.length >> 8,
    body.length & 255,
    ...body,
  ]);
  const small = keyBody([0, 16, 0xab, 0xcd, 0, 17, 1, 0, 1]);
  const oldOne = Uint8Array.from([0x80 | (6 << 2), small.length, ...small]);
  const prints = await Promise.all(
    [twoByte, fiveByte, oldTwo].map((k) => readPgpKey(k)),
  );
  assertEquals(new Set(prints.map((p) => p.fingerprint)).size, 1);
  assertEquals((await readPgpKey(oldOne)).fingerprint, reference.fingerprint);
});
