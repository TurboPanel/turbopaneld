/**
 * turbopanel.sh is a plain redirect served outside this repo (a 301/302/307 to
 * scripts/run.sh on the live branch). These tests pin that everything in this
 * repo that fetches the installer follows redirects (curl -L), and that a
 * redirect of any temporary or permanent kind delivers the script body.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = join(fromFileUrl(new URL(".", import.meta.url)), "..");

test("every automatic-update consumer fetches run.sh with -L, so the redirect is transparent", async () => {
  const orchestrate = await Deno.readTextFile(
    join(ROOT, "orchestration", "scripts", "tp-orchestrate"),
  );
  assertStringIncludes(orchestrate, "set -- curl -fsSL --max-time 120");
  const reconcile = await Deno.readTextFile(
    join(ROOT, "src", "instance", "run-reconcile.ts"),
  );
  assertStringIncludes(reconcile, 'const curlArgs = ["-fsSL"];');
  const runSh = await Deno.readTextFile(join(ROOT, "scripts", "run.sh"));
  assertStringIncludes(runSh, "TP_CURL_FETCH='curl -fsSL'");
  assertStringIncludes(runSh, "TP_CURL_FETCH_INSECURE='curl -fsSLk'");
});

test("every curl command on turbopanel.sh printed by this repo follows redirects", async () => {
  const bare = /curl\s+(-[A-Za-z]*)\s+(?:staging\.|testing\.)?turbopanel\.sh/g;
  for (
    const file of [
      "scripts/run.sh",
      "scripts/purge.sh",
      "README.md",
      "AGENTS.md",
      "src/instance/AGENTS.md",
    ]
  ) {
    const text = await Deno.readTextFile(join(ROOT, file));
    for (const match of text.matchAll(bare)) {
      assert(
        match[1].includes("L"),
        `${file}: "${match[0]}" does not follow redirects (needs -L)`,
      );
    }
  }
});

for (const status of [301, 302, 307, 308]) {
  test(`curl -fsSL follows a ${status} and pipes the installer body; without -L the body is empty`, async () => {
    const script = "#!/bin/sh\necho turbopanel-install-ok\n";
    const origin = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      () =>
        new Response(script, {
          headers: { "content-type": "text/x-shellscript; charset=utf-8" },
        }),
    );
    const originUrl = `http://127.0.0.1:${origin.addr.port}/scripts/run.sh`;
    const front = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      () => new Response(null, { status, headers: { location: originUrl } }),
    );
    const frontUrl = `http://127.0.0.1:${front.addr.port}/`;
    try {
      const followed = await new Deno.Command("curl", {
        args: ["-fsSL", frontUrl],
        stdout: "piped",
        stderr: "piped",
        clearEnv: true,
      }).output();
      assert(followed.success, new TextDecoder().decode(followed.stderr));
      assertEquals(new TextDecoder().decode(followed.stdout), script);

      const notFollowed = await new Deno.Command("curl", {
        args: ["-fsS", frontUrl],
        stdout: "piped",
        stderr: "piped",
        clearEnv: true,
      }).output();
      assertEquals(new TextDecoder().decode(notFollowed.stdout), "");
    } finally {
      await front.shutdown();
      await origin.shutdown();
    }
  });
}
