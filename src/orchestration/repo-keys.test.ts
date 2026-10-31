import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";
import {
  checkKey,
  exitCodeFor,
  type KeyMeta,
  renderIssueBody,
  runKeyChecks,
} from "../../scripts/check-repo-keys.ts";
import { readPgpKey, sha256Hex } from "../../scripts/lib/pgp-key.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const DOCKER_FILES = join(DAEMON_ROOT, "orchestration/roles/docker/files");
const PHP_FPM = join(DAEMON_ROOT, "orchestration/roles/php-fpm");

async function bundledDocker(): Promise<{ meta: KeyMeta; key: Uint8Array }> {
  const meta = JSON.parse(
    await Deno.readTextFile(join(DOCKER_FILES, "docker.asc.json")),
  ) as KeyMeta;
  const key = await Deno.readFile(join(DOCKER_FILES, "docker.asc"));
  return { meta, key };
}

async function bundledSury(): Promise<{ meta: KeyMeta; key: Uint8Array }> {
  const meta = JSON.parse(
    await Deno.readTextFile(join(PHP_FPM, "files/sury-php.gpg.json")),
  ) as KeyMeta;
  const key = await Deno.readFile(join(PHP_FPM, "files/sury-php.gpg"));
  return { meta, key };
}

/** Every shipped key by its source URL, so a fake fetch can answer "live". */
async function bundledBySource(): Promise<Map<string, Uint8Array>> {
  const docker = await bundledDocker();
  const sury = await bundledSury();
  return new Map([
    [docker.meta.source, docker.key],
    [sury.meta.source, sury.key],
  ]);
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

test("the bundled PHP repository key matches its metadata", async () => {
  const { meta, key } = await bundledSury();
  const info = await readPgpKey(key);
  assertEquals(info.fingerprint, meta.fingerprint);
  assertEquals(
    info.expires?.toISOString(),
    new Date(meta.expires!).toISOString(),
  );
  assertEquals(await sha256Hex(key), meta.sha256);
  const report = await checkKey(meta, key, null, new Date("2026-10-22"));
  assertEquals(report.problems, []);
});

test("the php-fpm role installs its key through repo-key with the warn policy", async () => {
  const { meta } = await bundledSury();
  const defaults = await Deno.readTextFile(join(PHP_FPM, "defaults/main.yml"));
  assertStringIncludes(defaults, `"${meta.fingerprint}"`);
  assertStringIncludes(defaults, "php_fpm_key_policy: warn");
  assertStringIncludes(defaults, `php_fpm_sury_key_url: "${meta.source}"`);
  const tasks = await Deno.readTextFile(join(PHP_FPM, "tasks/main.yml"));
  assertStringIncludes(tasks, "name: repo-key");
  assertStringIncludes(tasks, '"{{ role_path }}/files/sury-php.gpg"');
  assertStringIncludes(tasks, "repo_key_changed | default(false)");
  assertStringIncludes(tasks, "- gnupg");
  assertEquals(tasks.includes("tp-apt-key"), false);
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
  const bySource = await bundledBySource();
  const now = new Date("2026-10-22");
  const same = await runKeyChecks(
    DAEMON_ROOT,
    (url) => Promise.resolve(bySource.get(url) ?? null),
    now,
  );
  assertEquals(same.map((r) => r.name).sort(), ["docker", "sury-php"]);
  assertEquals(same.map((r) => r.problems), [[], []]);

  const offline = await runKeyChecks(
    DAEMON_ROOT,
    () => Promise.resolve(null),
    now,
  );
  for (const report of offline) {
    assertEquals(report.problems.length, 1);
    assertStringIncludes(report.problems[0]!, "could not fetch");
  }
  assertEquals(exitCodeFor(same), 0);
  assertEquals(exitCodeFor(offline), 2);

  const other = syntheticKey(1_700_000_000, null);
  const changed = await runKeyChecks(
    DAEMON_ROOT,
    () => Promise.resolve(other),
    now,
  );
  for (const report of changed) {
    assertStringIncludes(report.problems.join("\n"), "live key fingerprint");
  }
  assertEquals(exitCodeFor(changed), 1);
  assertEquals(exitCodeFor([...offline, ...changed]), 1);
  const body = renderIssueBody(changed);
  assertStringIncludes(body, "### docker");
  assertStringIncludes(body, "live key fingerprint");
  assertEquals(renderIssueBody(same).includes("###"), false);
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
