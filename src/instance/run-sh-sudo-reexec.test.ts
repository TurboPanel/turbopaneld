import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { RUN_SH_PATH as runShPath } from "../testing/run-sh-manifest-verifier.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SUDO_STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
env > "$STUB_OUT/env"
cat >/dev/null
`;

const CURL_STUB = `#!/bin/sh
echo "exit 0"
`;

/**
 * Run run.sh as a non-root user up to its sudo re-exec, with `sudo` and
 * `curl` stubbed on PATH. Returns what the stubbed sudo received.
 */
async function reexec(
  args: string[],
): Promise<{ status: number; argv: string; env: string; stderr: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-reexec-" });
  try {
    await Deno.writeTextFile(join(dir, "sudo"), SUDO_STUB, { mode: 0o755 });
    await Deno.writeTextFile(join(dir, "curl"), CURL_STUB, { mode: 0o755 });
    const out = await new Deno.Command("sh", {
      args: [runShPath, ...args],
      env: { PATH: `${dir}:/usr/bin:/bin`, STUB_OUT: dir },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const read = (name: string) =>
      Deno.readTextFile(join(dir, name)).catch(() => "");
    return {
      status: out.code,
      argv: await read("argv"),
      env: await read("env"),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const LICENSE = btoa("lic-id:lic-secret").replaceAll("+", "-")
  .replaceAll("/", "_");
const TUNNEL = "tunnel-secret-value";

test("the sudo re-exec passes the license and tunnel token in the environment, not argv", async () => {
  if (Deno.uid() === 0) return; // root never re-execs
  const result = await reexec([
    "--license",
    LICENSE,
    "--tunnel-token",
    TUNNEL,
    "--host",
    "https://cp.example.com",
  ]);
  assertEquals(result.status, 0, result.stderr);
  assertEquals(result.argv.includes(LICENSE), false, result.argv);
  assertEquals(result.argv.includes(TUNNEL), false, result.argv);
  assertEquals(result.argv.includes("--license"), false, result.argv);
  assertEquals(result.argv.includes("--tunnel-token"), false, result.argv);
  assertStringIncludes(
    result.argv,
    "--preserve-env=TURBOPANEL_LICENSE,TURBOPANEL_TUNNEL_TOKEN\nsh\n-s\n--\n",
  );
  assertStringIncludes(result.argv, "--host\nhttps://cp.example.com\n");
  assertStringIncludes(result.env, `TURBOPANEL_LICENSE=${LICENSE}\n`);
  assertStringIncludes(result.env, `TURBOPANEL_TUNNEL_TOKEN=${TUNNEL}\n`);
});

test("the sudo re-exec preserves only the secrets that are set", async () => {
  if (Deno.uid() === 0) return;
  const result = await reexec(["--license", LICENSE]);
  assertEquals(result.status, 0, result.stderr);
  assertEquals(result.argv.includes(LICENSE), false, result.argv);
  assertStringIncludes(
    result.argv,
    "--preserve-env=TURBOPANEL_LICENSE\nsh\n-s\n--\n",
  );
  assertEquals(result.env.includes("TURBOPANEL_TUNNEL_TOKEN="), false);
});

test("the sudo re-exec keeps a plain sudo when no secret is set", async () => {
  if (Deno.uid() === 0) return;
  const result = await reexec(["--instance"]);
  assertEquals(result.status, 0, result.stderr);
  assertEquals(result.argv.startsWith("sh\n-s\n--\n"), true, result.argv);
});

test("run.sh reads the tunnel token from TURBOPANEL_TUNNEL_TOKEN on the root side", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    source,
    '[ -n "$TUNNEL_TOKEN" ] || TUNNEL_TOKEN="${TURBOPANEL_TUNNEL_TOKEN:-}"',
  );
  assertEquals(source.includes('--tunnel-token "$TUNNEL_TOKEN"'), false);
  assertEquals(source.includes('--license "$LICENSE"'), false);
});
