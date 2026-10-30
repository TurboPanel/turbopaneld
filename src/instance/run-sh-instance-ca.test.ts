/**
 * run.sh Platform CA fetch: never fatal, existing CA kept unless a
 * replacement verifies, and a control plane that moved to public TLS is
 * recognised instead of reported as a changed CA.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) {
    throw new TypeError(`missing ${name} in run.sh`);
  }
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

async function openssl(args: string[]): Promise<void> {
  const out = await new Deno.Command("openssl", {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new TypeError(new TextDecoder().decode(out.stderr));
  }
}

async function selfSignedCa(dir: string, name: string): Promise<string> {
  const cert = `${dir}/${name}.crt`;
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${dir}/${name}.key`,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    `/CN=${name}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  return cert;
}

async function fingerprint(path: string): Promise<string> {
  const out = await new Deno.Command("openssl", {
    args: ["x509", "-in", path, "-noout", "-fingerprint", "-sha256"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(out.stdout).trim().replace(/^.*=/, "");
}

/**
 * `tp_curl_http_code` double: the pinned fetch carries `--cacert`, the
 * insecure retry `-sSLk`, anything else is the system-roots fetch. Each
 * answers with the code its env var names and serves TP_TEST_SERVED_CA on 200.
 */
const CURL_STUB = [
  "tp_curl_http_code() {",
  '  _out=""; _mode=system; _prev=""',
  '  for _a in "$@"; do',
  '    case "$_prev" in -o) _out="$_a" ;; esac',
  '    case "$_a" in --cacert) _mode=pinned ;; -sSLk) _mode=insecure ;; esac',
  '    _prev="$_a"',
  "  done",
  '  case "$_mode" in',
  '    pinned) _code="${TP_TEST_PINNED:-000}" ;;',
  '    insecure) _code="${TP_TEST_INSECURE:-000}" ;;',
  '    *) _code="${TP_TEST_SYSTEM:-000}" ;;',
  "  esac",
  '  printf \'%s\\n\' "$_mode" >> "$TP_TEST_CALLS"',
  '  if [ "$_code" = 200 ] && [ -n "$_out" ]; then cat "$TP_TEST_SERVED_CA" > "$_out"; fi',
  "  printf '%s' \"$_code\"",
  "}",
  'tp_ca_validates_leaf() { [ "${TP_TEST_LEAF_OK:-1}" = 1 ]; }',
  "tp_print_ok() { printf 'OK %s\\n' \"$1\"; }",
  'tp_print_step() { printf \'%s %s\\n\' "$1" "$2"; }',
  "tp_print_error() { printf 'ERR %s\\n' \"$1\" >&2; }",
].join("\n");

/** run.sh helpers behind the CA fingerprint check. */
const PIN_HELPERS = [
  "tp_ca_fingerprint",
  "tp_ca_parses",
  "tp_fingerprint_hex",
  "tp_cert_fingerprint_hex",
  "tp_split_pem_bundle",
  "tp_normalize_ca_pin",
  "tp_pem_files_pin",
  "tp_pem_matches_ca_pin",
  "tp_check_fetched_trust",
  "tp_bootstrap_leg",
];

type Outcome = {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[];
};

async function fetchCa(
  source: string,
  env: Record<string, string>,
  caPath: string,
): Promise<Outcome> {
  const helpers = [
    ...PIN_HELPERS,
    "tp_instance_bootstrap_curl",
    "tp_install_instance_ca",
    "tp_refetch_instance_ca_unpinned",
    "tp_fetch_instance_ca",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const calls = await Deno.makeTempFile({ prefix: "tp-ca-calls-" });
  const script = [
    "set -eu",
    `CA_PATH=${JSON.stringify(caPath)}`,
    'HOST_URL="https://panel.example:8443"',
    CURL_STUB,
    helpers,
    "tp_fetch_instance_ca",
    "printf 'RC=%s\\n' \"$?\"",
  ].join("\n");
  const out = await new Deno.Command("sh", {
    args: ["-c", script],
    env: { ...env, TP_TEST_CALLS: calls },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const recorded = (await Deno.readTextFile(calls)).trim();
  await Deno.remove(calls);
  return {
    status: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    calls: recorded.length > 0 ? recorded.split("\n") : [],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

test("run.sh skips the CA fetch on a co-located daemon refresh and never exits over it", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    source,
    'if [ "$INSTANCE_INSTALL" = true ] || [ "$_colocated_daemon_refresh" = true ]; then',
  );
  const fetcher = extractShellFunction(source, "tp_fetch_instance_ca");
  const refetch = extractShellFunction(
    source,
    "tp_refetch_instance_ca_unpinned",
  );
  assertEquals(fetcher.includes("exit "), false);
  assertEquals(refetch.includes("exit "), false);
  assertEquals(
    source.includes("platform CA changed and could not be verified"),
    false,
  );
});

test("a control plane that moved to public TLS drops the stale Platform CA (pinned 000 → system 404)", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const old = await selfSignedCa(dir, "OldPlatformCA");
    const caPath = `${dir}/instance-ca.pem`;
    await Deno.copyFile(old, caPath);
    const out = await fetchCa(source, {
      TP_TEST_PINNED: "000",
      TP_TEST_SYSTEM: "404",
      TP_TEST_SERVED_CA: old,
    }, caPath);
    assertEquals(out.status, 0, out.stderr);
    assertStringIncludes(out.stdout, "publicly trusted certificate");
    assertStringIncludes(out.stdout, "RC=0");
    assertEquals(await exists(caPath), false);
    assertEquals(out.calls, ["pinned", "system"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("an unreachable control plane keeps the existing CA and continues (every fetch 000)", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const old = await selfSignedCa(dir, "OldPlatformCA");
    const caPath = `${dir}/instance-ca.pem`;
    await Deno.copyFile(old, caPath);
    const before = await fingerprint(caPath);
    const out = await fetchCa(source, {
      TP_TEST_PINNED: "000",
      TP_TEST_SYSTEM: "000",
      TP_TEST_INSECURE: "000",
      TP_TEST_SERVED_CA: old,
    }, caPath);
    assertEquals(out.status, 0, out.stderr);
    assertStringIncludes(out.stdout, "keeping the existing CA");
    assertStringIncludes(out.stdout, `existing ${before}`);
    assertStringIncludes(out.stdout, "--instance-ca");
    assertStringIncludes(out.stdout, "RC=0");
    assertEquals(out.stderr.includes("ERR"), false);
    assertEquals(await fingerprint(caPath), before);
    assertEquals(out.calls, ["pinned", "system"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a replacement CA public trust serves that does not validate the live leaf is never installed", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const old = await selfSignedCa(dir, "OldPlatformCA");
    const rogue = await selfSignedCa(dir, "RogueCA");
    const caPath = `${dir}/instance-ca.pem`;
    await Deno.copyFile(old, caPath);
    const before = await fingerprint(caPath);
    const out = await fetchCa(source, {
      TP_TEST_PINNED: "000",
      TP_TEST_SYSTEM: "200",
      TP_TEST_LEAF_OK: "0",
      TP_TEST_SERVED_CA: rogue,
    }, caPath);
    assertEquals(out.status, 0, out.stderr);
    assertStringIncludes(out.stdout, "keeping the existing CA");
    assertStringIncludes(out.stdout, `fetched ${await fingerprint(rogue)}`);
    assertEquals(await fingerprint(caPath), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a CA only reachable over unverified TLS never replaces the pin, even when it validates the live leaf", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const old = await selfSignedCa(dir, "OldPlatformCA");
    const other = await selfSignedCa(dir, "OtherCA");
    const caPath = `${dir}/instance-ca.pem`;
    await Deno.copyFile(old, caPath);
    const before = await fingerprint(caPath);
    const out = await fetchCa(source, {
      TP_TEST_PINNED: "000",
      TP_TEST_SYSTEM: "000",
      TP_TEST_INSECURE: "200",
      TP_TEST_LEAF_OK: "1",
      TP_TEST_SERVED_CA: other,
    }, caPath);
    assertEquals(out.status, 0, out.stderr);
    assertStringIncludes(out.stdout, "keeping the existing CA");
    assertStringIncludes(out.stdout, "--instance-ca");
    assertEquals(await fingerprint(caPath), before);
    assertEquals(out.calls.includes("insecure"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a rotated CA served over publicly trusted TLS that validates the live leaf replaces the pin", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const old = await selfSignedCa(dir, "OldPlatformCA");
    const next = await selfSignedCa(dir, "NextPlatformCA");
    const caPath = `${dir}/instance-ca.pem`;
    await Deno.copyFile(old, caPath);
    const out = await fetchCa(source, {
      TP_TEST_PINNED: "000",
      TP_TEST_SYSTEM: "200",
      TP_TEST_LEAF_OK: "1",
      TP_TEST_SERVED_CA: next,
    }, caPath);
    assertEquals(out.status, 0, out.stderr);
    assertStringIncludes(out.stdout, "Platform CA downloaded (was");
    assertEquals(await fingerprint(caPath), await fingerprint(next));
    assertEquals(out.calls, ["pinned", "system"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("run.sh never fetches trust material over unverified TLS unless --insecure-tls asked for it", async () => {
  const source = await Deno.readTextFile(runShPath);
  for (
    const name of ["tp_refetch_instance_ca_unpinned", "tp_fetch_uploaded_trust"]
  ) {
    const body = extractShellFunction(source, name);
    assertEquals(/curl\s+-\w*k/.test(body), false, name);
  }
});

test("the sudo re-exec only skips TLS checks for the instance's own host, never the public installer host", async () => {
  const source = await Deno.readTextFile(runShPath);
  const start = source.indexOf(
    '  _curl="$TP_CURL_FETCH"\n  if [ -n "$DL_BASE" ]',
  );
  const end = source.indexOf("| sudo sh -s --", start);
  assertEquals(start >= 0 && end > start, true, "re-exec block not found");
  const block = source.slice(start, end);
  const split = block.indexOf("\n  else\n");
  assertEquals(split > 0, true, "re-exec DL_BASE branch not found");
  const ownHost = block.slice(0, split);
  const publicHost = block.slice(split);
  assertStringIncludes(ownHost, '_REEXEC_SCRIPT_URL="${HOST_URL%/}/run.sh"');
  assertStringIncludes(ownHost, '_curl="$TP_CURL_FETCH_INSECURE"');
  assertStringIncludes(publicHost, "tp_installer_host_for_channel");
  assertEquals(publicHost.includes("TP_CURL_FETCH_INSECURE"), false);
});

test("a pinned 200 installs directly and a pinned 404 clears the CA", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const next = await selfSignedCa(dir, "NextPlatformCA");
    const caPath = `${dir}/instance-ca.pem`;
    const fresh = await fetchCa(source, {
      TP_TEST_PINNED: "200",
      TP_TEST_SYSTEM: "200",
      TP_TEST_SERVED_CA: next,
    }, caPath);
    assertEquals(fresh.status, 0, fresh.stderr);
    assertEquals(await fingerprint(caPath), await fingerprint(next));
    assertEquals(fresh.calls.length, 1);

    const cleared = await fetchCa(source, {
      TP_TEST_PINNED: "404",
      TP_TEST_SERVED_CA: next,
    }, caPath);
    assertEquals(cleared.status, 0, cleared.stderr);
    assertEquals(await exists(caPath), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function hexFingerprint(colonFingerprint: string): string {
  return colonFingerprint.replaceAll(":", "").toLowerCase();
}

test("with a fingerprint in the command, a matching CA installs over the bootstrap leg", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const current = await selfSignedCa(dir, "PlatformCA");
    const retired = await selfSignedCa(dir, "RetiredPlatformCA");
    const bundle = `${dir}/bundle.pem`;
    await Deno.writeTextFile(
      bundle,
      (await Deno.readTextFile(current)) + (await Deno.readTextFile(retired)),
    );
    const caPath = `${dir}/instance-ca.pem`;
    const pin = [
      hexFingerprint(await fingerprint(current)),
      hexFingerprint(await fingerprint(retired)),
    ].join(",");
    const out = await fetchCa(source, {
      INSECURE_TLS: "true",
      CA_PIN: pin,
      TP_TEST_INSECURE: "200",
      TP_TEST_SERVED_CA: bundle,
    }, caPath);
    assertEquals(out.status, 0, out.stderr);
    assertStringIncludes(out.stdout, "RC=0");
    assertEquals(out.stdout.includes("trusted on first use"), false);
    assertEquals(await fingerprint(caPath), await fingerprint(current));
    assertEquals(out.calls, ["insecure"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("with a fingerprint in the command, a different CA or an extra certificate stops the install", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const real = await selfSignedCa(dir, "PlatformCA");
    const rogue = await selfSignedCa(dir, "RogueCA");
    const padded = `${dir}/padded.pem`;
    await Deno.writeTextFile(
      padded,
      (await Deno.readTextFile(real)) + (await Deno.readTextFile(rogue)),
    );
    const pin = hexFingerprint(await fingerprint(real));
    for (const served of [rogue, padded]) {
      const caPath = `${dir}/instance-ca.pem`;
      const out = await fetchCa(source, {
        INSECURE_TLS: "true",
        CA_PIN: pin,
        TP_TEST_INSECURE: "200",
        TP_TEST_SERVED_CA: served,
      }, caPath);
      assertEquals(out.status === 0, false, served);
      assertEquals(out.stdout.includes("RC=0"), false);
      assertStringIncludes(out.stderr, "does not match the fingerprint");
      assertStringIncludes(out.stderr, "Nothing was installed");
      assertEquals(await exists(caPath), false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a CA that public trust authenticates must still match the fingerprint in the command", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const old = await selfSignedCa(dir, "OldPlatformCA");
    const next = await selfSignedCa(dir, "NextPlatformCA");
    const caPath = `${dir}/instance-ca.pem`;
    await Deno.copyFile(old, caPath);
    const before = await fingerprint(caPath);
    const out = await fetchCa(source, {
      CA_PIN: hexFingerprint(before),
      TP_TEST_PINNED: "000",
      TP_TEST_SYSTEM: "200",
      TP_TEST_LEAF_OK: "1",
      TP_TEST_SERVED_CA: next,
    }, caPath);
    assertEquals(out.status === 0, false);
    assertStringIncludes(out.stderr, "does not match the fingerprint");
    assertEquals(await fingerprint(caPath), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("without a fingerprint, an old-style command still installs and says the CA was trusted on first use", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const served = await selfSignedCa(dir, "PlatformCA");
    const caPath = `${dir}/instance-ca.pem`;
    const out = await fetchCa(source, {
      INSECURE_TLS: "true",
      TP_TEST_INSECURE: "200",
      TP_TEST_SERVED_CA: served,
    }, caPath);
    assertEquals(out.status, 0, out.stderr);
    assertStringIncludes(out.stdout, "RC=0");
    assertEquals(out.stdout.split("trusted on first use").length, 2);
    assertEquals(await fingerprint(caPath), await fingerprint(served));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function runPinHelpers(
  source: string,
  body: string,
  env: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const helpers = PIN_HELPERS.map((name) => extractShellFunction(source, name))
    .join("\n");
  const out = await new Deno.Command("sh", {
    args: ["-c", [CURL_STUB, helpers, body].join("\n")],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    status: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

test("the fingerprint list accepts openssl's colon form and refuses anything else", async () => {
  const source = await Deno.readTextFile(runShPath);
  const lower = "ab".repeat(32);
  const colon = Array.from({ length: 32 }, () => "CD").join(":");
  const ok = await runPinHelpers(
    source,
    `tp_normalize_ca_pin '${lower}, ${colon},'`,
  );
  assertEquals(ok.status, 0, ok.stderr);
  assertEquals(ok.stdout, `${lower},${"cd".repeat(32)}`);
  for (const bad of ["deadbeef", `${lower};id`, ",", `${lower}0`]) {
    const out = await runPinHelpers(source, `tp_normalize_ca_pin '${bad}'`);
    assertEquals(out.status === 0, false, bad);
  }
});

test("the daemon's fingerprint list covers the Platform CA and the private issuer", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const platform = await selfSignedCa(dir, "PlatformCA");
    const issuer = await selfSignedCa(dir, "UploadedIssuer");
    const out = await runPinHelpers(
      source,
      `tp_pem_files_pin '${platform}' '${dir}/missing.pem' '${issuer}' '${platform}'`,
    );
    assertEquals(out.status, 0, out.stderr);
    assertEquals(
      out.stdout,
      [
        hexFingerprint(await fingerprint(platform)),
        hexFingerprint(await fingerprint(issuer)),
      ].join(","),
    );
    assertStringIncludes(
      source,
      '_ca_fp="$(tp_pem_files_pin "$CA_PATH" "$UPLOADED_TRUST_PATH")"',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a private issuer outside the fingerprint list is never stored", async () => {
  const source = await Deno.readTextFile(runShPath);
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-ca-" });
  try {
    const real = await selfSignedCa(dir, "UploadedIssuer");
    const rogue = await selfSignedCa(dir, "RogueIssuer");
    const stored = `${dir}/instance-uploaded-trust.pem`;
    const install = extractShellFunction(
      source,
      "tp_install_verified_uploaded_trust",
    );
    const out = await runPinHelpers(
      source,
      [install, `tp_install_verified_uploaded_trust '${rogue}'`].join("\n"),
      {
        CA_PIN: hexFingerprint(await fingerprint(real)),
        INSECURE_TLS: "true",
        HOST_URL: "https://panel.example:8443",
        UPLOADED_TRUST_PATH: stored,
      },
    );
    assertEquals(out.status === 0, false);
    assertStringIncludes(out.stderr, "private uploaded issuer");
    assertStringIncludes(out.stderr, "does not match the fingerprint");
    assertEquals(await exists(stored), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("the fingerprint survives the sudo re-exec and a bad one stops the install", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    source,
    '[ -n "$CA_PIN" ] && set -- "$@" --instance-ca-fingerprint "$CA_PIN"',
  );
  assertStringIncludes(
    source,
    '[ -n "$CA_PIN" ] || CA_PIN="${TURBOPANEL_INSTANCE_CA_FINGERPRINT:-}"',
  );
  assertStringIncludes(source, "if ! tp_fetch_instance_ca; then\n    exit 1");
});
