/**
 * turbopanel.sh is a redirect, not a copy of the installer. These tests pin
 * the Static Assets config that makes it one, and prove the `curl | sh`
 * contract survives a 301: every consumer of the script fetches with `-L`.
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
const WORKER = join(ROOT, "workers", "turbopanel-sh");
export const INSTALLER_URL =
  "https://raw.githubusercontent.com/TurboPanel/turbopaneld/live/scripts/run.sh";

async function redirectRules(): Promise<
  Map<string, { to: string; status: string }>
> {
  const text = await Deno.readTextFile(join(WORKER, "assets", "_redirects"));
  const rules = new Map<string, { to: string; status: string }>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [from, to, status] = line.split(/\s+/);
    if (!rules.has(from)) rules.set(from, { to, status });
  }
  return rules;
}

test("every installer path on turbopanel.sh is a 301 to run.sh on the live branch", async () => {
  const rules = await redirectRules();
  for (const path of ["/", "/run.sh", "/bootstrap", "/*"]) {
    const rule = rules.get(path);
    assert(rule, `no _redirects rule for ${path}`);
    assertEquals(rule.to, INSTALLER_URL, `${path} target`);
    assertEquals(rule.status, "301", `${path} status`);
  }
});

test("the worker stages no copy of run.sh any more", async () => {
  const pkg = JSON.parse(
    await Deno.readTextFile(join(WORKER, "package.json")),
  ) as {
    scripts: Record<string, string>;
  };
  assert(!pkg.scripts.stage.includes("run.sh"), "stage still copies run.sh");
  assertStringIncludes(pkg.scripts.stage, "_redirects");
});

test("every automatic-update consumer fetches run.sh with -L, so the 301 is transparent", async () => {
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
});

test("curl -fsSL follows a 301 and pipes the installer body; without -L the body is empty", async () => {
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
    () => new Response(null, { status: 301, headers: { location: originUrl } }),
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
