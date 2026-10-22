import { assert } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const role = (path: string) =>
  Deno.readTextFile(new URL(`../orchestration/roles/${path}`, import.meta.url));

const ARCHES = ["amd64", "arm64"];

function assertPinnedDigests(defaults: string, name: string) {
  const at = defaults.indexOf(`\n${name}:`);
  assert(at !== -1, `missing ${name}`);
  const block = defaults.slice(at);
  for (const arch of ARCHES) {
    assert(
      new RegExp(`\\n  ${arch}: "[0-9a-f]{64}"`).test(block),
      `missing sha256 for ${arch} in ${name}`,
    );
  }
}

// The downloaded deb's digest is compared with the pin, and the comparison
// comes before the deb is unpacked.
function assertCheckedBeforeExtraction(tasks: string) {
  const check = tasks.indexOf('[ "$GOT" = "${DEB_SHA256}" ]');
  assert(check !== -1, "missing the digest comparison");
  assert(
    check < tasks.indexOf('dpkg-deb -x "$TMP/'),
    "digest checked after extraction",
  );
}

test("nginx deb is the trixie build, pinned by digest and checked before extraction", async () => {
  const defaults = await role("nginx/defaults/main.yml");
  const tasks = await role("nginx/tasks/main.yml");
  assert(defaults.includes('nginx_deb_version: "1.28.3-1~trixie"'));
  assert(defaults.includes('nginx_deb_dist: "trixie"'));
  assert(!defaults.includes("bookworm"), "no Debian 12 build on Debian 13");
  assertPinnedDigests(defaults, "nginx_deb_sha256");
  assert(tasks.includes("nginx_deb_sha256[nginx_deb_arch]"));
  assertCheckedBeforeExtraction(tasks);
});

test("redis deb is the trixie build, pinned by digest and checked before extraction", async () => {
  const defaults = await role("redis/defaults/main.yml");
  const tasks = await role("redis/tasks/main.yml");
  assert(!tasks.includes("bookworm"), "no Debian 12 build on Debian 13");
  assert(tasks.includes("pool/trixie/r/re/redis-server_"));
  assert(tasks.includes("-1rl1~trixie1_"));
  assertPinnedDigests(defaults, "redis_deb_sha256");
  assert(tasks.includes("redis_deb_sha256[redis_deb_arch]"));
  assertCheckedBeforeExtraction(tasks);
});
