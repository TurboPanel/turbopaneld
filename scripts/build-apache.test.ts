import { assert, assertMatch } from "@std/assert";
import { join } from "@std/path";

const root = join(import.meta.dirname ?? ".", "..");
const read = (rel: string) => Deno.readTextFile(join(root, rel));

Deno.test("build-apache.sh verifies sources, fixes owners and gates linked libraries", async () => {
  const script = await read("scripts/build-apache.sh");
  assert(script.includes("sha256sum -c"), "source digests are checked");
  assert(
    script.includes("--owner=0 --group=0 --numeric-owner"),
    "tarball entries are root-owned",
  );
  assert(script.includes("ldd"), "linked libraries are gated");
  assert(script.includes("gpg --batch --status-fd 1 --verify"), "signatures");
  assertMatch(script, /^HTTPD_SIGNER="[0-9A-F]{40}"$/m, "httpd signer");
  assertMatch(script, /^APR_SIGNER="[0-9A-F]{40}"$/m, "apr signer");
  assert(script.includes("not found"), "unresolved libraries fail the build");
  assert(script.includes("--without-sqlite3"), "apr-util drivers off");
  const workflow = await read(".github/workflows/vendor-apache.yml");
  assert(
    workflow.includes("if: github.ref == 'refs/heads/trunk'"),
    "only trunk publishes",
  );
  assert(script.includes("--disable-http2"), "optional modules are disabled");
  assert(
    script.includes('ASSET="apache-httpd-$HTTPD_VER-$ARCH.tar.zst"'),
    "lower-case apache-httpd-<ver>-<arch>.tar.zst asset",
  );
  assert(script.includes("share/licenses"), "ASF LICENSE and NOTICE ship");
  assert(
    workflow.includes('gh release edit "$TAG" --draft=false --latest=false'),
    "publishing never makes the vendor release Latest",
  );
});

Deno.test("apache role pins source digests the build script reads", async () => {
  const defaults = await read("orchestration/roles/apache/defaults/main.yml");
  for (const key of ["httpd", "apr", "apr_util"]) {
    assertMatch(
      defaults,
      new RegExp(`^apache_${key}_sha256: "[0-9a-f]{64}"$`, "m"),
      `${key} source digest`,
    );
  }
  const tasks = await read("orchestration/roles/apache/tasks/main.yml");
  assert(tasks.includes("--no-same-owner"), "extract never keeps tar owners");
});

Deno.test("apache role pins SHA-256 for both architectures of the current version", async () => {
  const defaults = await read("orchestration/roles/apache/defaults/main.yml");
  const version = defaults.match(/^apache_version: "(.+)"$/m)?.[1];
  assert(version, "apache_version is pinned");
  const versionKey = version.replaceAll(".", String.raw`\.`);
  const versionBlock = defaults.match(
    new RegExp(
      String
        .raw`^apache_sha256:\n(?:  .+\n)*  "${versionKey}":\n((?:    .+\n)+)`,
      "m",
    ),
  )?.[1];
  assert(versionBlock, `apache_sha256 has an entry for ${version}`);
  for (const arch of ["amd64", "arm64"]) {
    const digest = versionBlock.match(new RegExp(`^    ${arch}: "(.+)"$`, "m"))
      ?.[1];
    assert(digest, `${arch} digest for ${version}`);
    assertMatch(digest, /^[0-9a-f]{64}$/, `${arch} digest is SHA-256`);
  }
});

const versionParts = (version: string) => version.split(".").map(Number);

Deno.test("apache build version is pinned and not older than the installed version", async () => {
  const defaults = await read("orchestration/roles/apache/defaults/main.yml");
  const build = defaults.match(/^apache_build_version: "(\d+\.\d+\.\d+)"$/m)
    ?.[1];
  const installed = defaults.match(/^apache_version: "(\d+\.\d+\.\d+)"$/m)?.[1];
  assert(build, "apache_build_version is pinned");
  assert(installed, "apache_version is pinned");
  const built = versionParts(build);
  const hosts = versionParts(installed);
  const index = built.findIndex((part, i) => part !== hosts[i]);
  assert(
    index === -1 || built[index] > hosts[index],
    `build version ${build} is not lower than installed ${installed}`,
  );
});

Deno.test("apache build script and vendor workflow read the build version", async () => {
  const script = await read("scripts/build-apache.sh");
  assert(
    script.includes('HTTPD_VER="$(pin apache_build_version)"'),
    "build script reads apache_build_version",
  );
  const workflow = await read(".github/workflows/vendor-apache.yml");
  assertMatch(
    workflow,
    /^\s+VER="\$\(sed -n 's\/\^apache_build_version:/m,
    "workflow VER line names apache_build_version",
  );
});
