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
  assert(script.includes("--disable-http2"), "optional modules are disabled");
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
