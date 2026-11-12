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

async function sh(script: string): Promise<{ status: number; stderr: string }> {
  const out = await new Deno.Command("sh", {
    args: ["-eu", "-c", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    status: out.code,
    stderr: new TextDecoder().decode(out.stderr),
  };
}

test("tp_uploaded_trust_verifies accepts the private issuer and rejects a leaf pin", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    source,
    "Bootstrap insecure TLS is not runtime trust.",
  );
  const installer = extractShellFunction(
    source,
    "tp_install_verified_uploaded_trust",
  );
  assertStringIncludes(
    installer,
    'install -m 0640 "$_src" "$UPLOADED_TRUST_PATH"',
  );
  assertEquals(installer.includes('"$CA_PATH"'), false);

  const helper = [
    "tp_ca_fingerprint",
    "tp_ca_parses",
    "tp_fingerprint_hex",
    "tp_cert_fingerprint_hex",
    "tp_split_pem_bundle",
    "tp_pem_files_pin",
    "tp_pem_matches_ca_pin",
    "tp_check_fetched_trust",
    "tp_bootstrap_leg",
    "tp_trust_has_distinct_issuer",
    "tp_trust_issuers_only",
    "tp_uploaded_trust_verifies",
    "tp_bootstrap_trust_anchored",
  ].map((name) => extractShellFunction(source, name)).join("\n");

  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-trust-" });
  const caKey = `${dir}/ca.key`;
  const caCert = `${dir}/ca.crt`;
  const otherKey = `${dir}/other.key`;
  const otherCert = `${dir}/other.crt`;
  const leafKey = `${dir}/leaf.key`;
  const leafCsr = `${dir}/leaf.csr`;
  const leafCert = `${dir}/leaf.crt`;
  const mismatchKey = `${dir}/mismatch.key`;
  const mismatchCsr = `${dir}/mismatch.csr`;
  const mismatchCert = `${dir}/mismatch.crt`;
  try {
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-subj",
      "/CN=PrivateUploadCA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      otherKey,
      "-out",
      otherCert,
      "-days",
      "1",
      "-subj",
      "/CN=UnrelatedCA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    await openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKey,
      "-out",
      leafCsr,
      "-subj",
      "/CN=private.example.com",
      "-addext",
      "subjectAltName=DNS:private.example.com",
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      leafCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      leafCert,
      "-days",
      "1",
      "-copy_extensions",
      "copy",
    ]);
    await openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      mismatchKey,
      "-out",
      mismatchCsr,
      "-subj",
      "/CN=other.example.com",
      "-addext",
      "subjectAltName=DNS:other.example.com",
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      mismatchCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      mismatchCert,
      "-days",
      "1",
      "-copy_extensions",
      "copy",
    ]);

    const checks = await sh([
      helper,
      `ca="${caCert}"`,
      `leaf="${leafCert}"`,
      `other="${otherCert}"`,
      `mismatch="${mismatchCert}"`,
      'tp_uploaded_trust_verifies "$ca" "$leaf" private.example.com',
      'if tp_uploaded_trust_verifies "$leaf" "$leaf" private.example.com; then exit 1; fi',
      'if tp_uploaded_trust_verifies "$other" "$leaf" private.example.com; then exit 1; fi',
      `cat "$leaf" "$other" > "${dir}/leaf-plus-other.pem"`,
      `if tp_uploaded_trust_verifies "${dir}/leaf-plus-other.pem" "$leaf" private.example.com; then exit 1; fi`,
      'if tp_uploaded_trust_verifies "$ca" "$mismatch" private.example.com; then exit 1; fi',
      "TP_NO_SYSTEM_CAPATH=/nonexistent",
      "tp_system_roots_validate_leaf() { return 1; }",
      "INSECURE_TLS=true",
      "CA_PATH=/no/such-ca",
      "UPLOADED_TRUST_PATH=/no/such-trust",
      "if tp_bootstrap_trust_anchored; then exit 1; fi",
      // A control plane behind a public edge is anchored by the public roots.
      "tp_system_roots_validate_leaf() { return 0; }",
      "if ! tp_bootstrap_trust_anchored; then exit 1; fi",
      "tp_system_roots_validate_leaf() { return 1; }",
      "INSECURE_TLS=false",
      "if ! tp_bootstrap_trust_anchored; then exit 1; fi",
      "INSECURE_TLS=true",
      "CA_PATH=/no/such-ca",
      "tp_ca_validates_leaf() { return 0; }",
      `CA_PATH="$ca"`,
      "UPLOADED_TRUST_PATH=/no/such-trust",
      "if ! tp_bootstrap_trust_anchored; then exit 1; fi",
      "tp_ca_validates_leaf() { return 1; }",
      "if tp_bootstrap_trust_anchored; then exit 1; fi",
    ].join("\n"));
    assertEquals(checks.status, 0, checks.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("stale uploaded issuer and a failed trust fetch do not anchor insecure bootstrap", async () => {
  const source = await Deno.readTextFile(runShPath);
  const anchored = extractShellFunction(source, "tp_bootstrap_trust_anchored");
  assertStringIncludes(anchored, "tp_capture_presented_leaf");
  assertStringIncludes(anchored, "tp_uploaded_trust_verifies");
  const helper = [
    "tp_ca_fingerprint",
    "tp_ca_parses",
    "tp_fingerprint_hex",
    "tp_cert_fingerprint_hex",
    "tp_split_pem_bundle",
    "tp_pem_files_pin",
    "tp_pem_matches_ca_pin",
    "tp_check_fetched_trust",
    "tp_bootstrap_leg",
    "tp_trust_has_distinct_issuer",
    "tp_trust_issuers_only",
    "tp_uploaded_trust_verifies",
    "tp_url_host",
    "tp_capture_presented_leaf",
    "tp_bootstrap_trust_anchored",
    "tp_print_step",
    "tp_print_ok",
    "tp_print_error",
    "tp_instance_bootstrap_curl",
    "tp_curl_http_code",
    "tp_install_verified_uploaded_trust",
    "tp_fetch_uploaded_trust",
  ].map((name) => extractShellFunction(source, name)).join("\n");

  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-stale-" });
  const caKey = `${dir}/ca.key`;
  const caCert = `${dir}/ca.crt`;
  const otherKey = `${dir}/other.key`;
  const otherCert = `${dir}/other.crt`;
  const leafKey = `${dir}/leaf.key`;
  const leafCsr = `${dir}/leaf.csr`;
  const leafCert = `${dir}/leaf.crt`;
  try {
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-subj",
      "/CN=PrivateUploadCA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      otherKey,
      "-out",
      otherCert,
      "-days",
      "1",
      "-subj",
      "/CN=UnrelatedCA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    await openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKey,
      "-out",
      leafCsr,
      "-subj",
      "/CN=private.example.com",
      "-addext",
      "subjectAltName=DNS:private.example.com",
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      leafCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      leafCert,
      "-days",
      "1",
      "-copy_extensions",
      "copy",
    ]);

    const checks = await sh([
      helper,
      `leaf="${leafCert}"`,
      `ca="${caCert}"`,
      `other="${otherCert}"`,
      'tp_capture_presented_leaf() { cp "$leaf" "$1"; }',
      "tp_ca_validates_leaf() { return 1; }",
      "tp_system_roots_validate_leaf() { return 1; }",
      "TP_NO_SYSTEM_CAPATH=/nonexistent",
      "HOST_URL=https://private.example.com",
      "INSECURE_TLS=true",
      "unset CA_PATH",
      'UPLOADED_TRUST_PATH="$ca"',
      "if ! tp_bootstrap_trust_anchored; then exit 1; fi",
      'UPLOADED_TRUST_PATH="$other"',
      "if tp_bootstrap_trust_anchored; then exit 1; fi",
      "tp_curl_http_code() { printf '%s' 500; }",
      "if ! tp_fetch_uploaded_trust; then exit 1; fi",
      'if ! cmp -s "$UPLOADED_TRUST_PATH" "$other"; then exit 1; fi',
      "if tp_bootstrap_trust_anchored; then exit 1; fi",
    ].join("\n"));
    assertEquals(checks.status, 0, checks.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * `tp_fetch_uploaded_trust` with a stub `tp_curl_http_code`: a fetch that
 * carries --cacert (the stored issuer alone) answers 000, any other the code
 * in SYSTEM_CODE. The issuer check itself is stubbed and reports its leg.
 */
async function fetchUploadedTrust(vars: string[]) {
  const source = await Deno.readTextFile(runShPath);
  const helpers = [
    "tp_bootstrap_leg",
    "tp_instance_bootstrap_curl",
    "tp_fetch_uploaded_trust",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-trust-leg-" });
  try {
    const stored = `${dir}/instance-uploaded-trust.pem`;
    await Deno.writeTextFile(stored, "stored issuer\n");
    const out = await new Deno.Command("sh", {
      args: [
        "-eu",
        "-c",
        [
          "TP_NO_SYSTEM_CAPATH=/nonexistent",
          "INSECURE_TLS=false",
          "HOST_URL=https://panel.example.test",
          "CA_PATH=/no/such-ca",
          `UPLOADED_TRUST_PATH=${stored}`,
          "tp_ca_fingerprint() { printf 'AB:CD'; }",
          "tp_print_step() { printf 'STEP %s\\n' \"$2\"; }",
          "tp_print_error() { printf 'ERR %s\\n' \"$1\" >&2; }",
          'tp_install_verified_uploaded_trust() { echo "install leg=$2"; }',
          "tp_curl_http_code() {",
          "  echo FETCH >&2",
          '  case " $* " in *" --cacert "*) printf 000 ;; *) printf "%s" "$SYSTEM_CODE" ;; esac',
          "}",
          ...vars,
          helpers,
          "tp_fetch_uploaded_trust",
          'if [ -f "$UPLOADED_TRUST_PATH" ]; then echo kept; else echo removed; fi',
        ].join("\n"),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("a stored issuer that no longer verifies the panel is asked again over the public roots", async () => {
  const out = await fetchUploadedTrust(["SYSTEM_CODE=200"]);
  assertEquals(out.status, 0, out.stderr);
  // The answer is then checked as a system-leg download (pin and issuer).
  assertStringIncludes(out.stdout, "install leg=system");
});

test("over the public roots, a missing issuer does not delete one the host pins", async () => {
  const pinned = await fetchUploadedTrust([
    "SYSTEM_CODE=404",
    `CA_PIN=${"ab".repeat(32)}`,
    "CA_PIN_SOURCE=host",
  ]);
  assertEquals(pinned.status, 0, pinned.stderr);
  assertStringIncludes(pinned.stdout, "kept");
  assertStringIncludes(pinned.stdout, "keeping the stored one");

  const unpinned = await fetchUploadedTrust(["SYSTEM_CODE=404"]);
  assertEquals(unpinned.status, 0, unpinned.stderr);
  assertStringIncludes(unpinned.stdout, "removed");
});

test("a stored issuer that verifies nothing over either leg is kept and stops the install", async () => {
  const out = await fetchUploadedTrust(["SYSTEM_CODE=000"]);
  assertEquals(out.status === 0, false);
  assertStringIncludes(out.stderr, "keeping it");
});

test("a fresh install behind a public edge, with only the new CA stored, makes no second issuer request", async () => {
  // The CA came in over the public roots a moment ago; the issuer fetch
  // then uses it alone, gets no answer, and there is no issuer to keep.
  const out = await fetchUploadedTrust([
    "SYSTEM_CODE=200",
    'CA_PATH="$UPLOADED_TRUST_PATH.ca"',
    'mv "$UPLOADED_TRUST_PATH" "$CA_PATH"',
  ]);
  assertEquals(out.status, 0, out.stderr);
  assertEquals(out.stderr.split("FETCH").length - 1, 1);
  assertEquals(out.stdout.includes("install leg="), false);
  assertStringIncludes(out.stdout, "removed");
});
