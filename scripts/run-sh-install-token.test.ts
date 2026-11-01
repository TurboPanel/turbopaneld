import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { encodeBase64Url } from "@std/encoding/base64url";

/** Alias so Sonar sees real tests (see the other run.sh suites). */
const test = Deno.test.bind(Deno);

/**
 * The install TOKEN: parsing, the identity-document check and the pin file
 * rules, run against run.sh's own functions (lifted, not copied). The panel
 * side is simulated with a throwaway Ed25519 key.
 */
const here = dirname(fromFileUrl(import.meta.url));
const RUN_SH = join(here, "run.sh");
const encoder = new TextEncoder();

function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  assert(start >= 0, `run.sh no longer defines ${name}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start + 1, end + 2);
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const b64 = (text: string) => encodeBase64Url(encoder.encode(text));

async function sh(script: string) {
  const out = await new Deno.Command("sh", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

const FUNCTIONS = [
  "tp_b64url_decode",
  "tp_panel_fingerprint_ok",
  "tp_install_token_decode",
  "tp_identity_material_python",
  "tp_verify_ed25519",
  "tp_verify_install_token",
  "tp_pin_file_field",
  "tp_resolve_panel_pin",
  "tp_write_panel_identity_pin",
];

async function lifted(): Promise<string> {
  const source = await Deno.readTextFile(RUN_SH);
  return FUNCTIONS.map((name) => shellFunction(source, name)).join("\n");
}

const STUBS = `
tp_print_step() { :; }
tp_print_ok() { :; }
tp_print_error() { printf '%s\\n' "$1" >&2; }
`;

type Panel = {
  fingerprint: string;
  sign(text: string): Promise<string>;
  body: string;
  header: string;
};

async function makePanel(
  options: { expires?: string; keyset?: number } = {},
): Promise<Panel> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const kid = encodeBase64Url(digest);
  const sign = async (text: string) =>
    encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          pair.privateKey,
          encoder.encode(text),
        ),
      ),
    );
  const body = JSON.stringify({
    v: 1,
    keys: [
      { kid, alg: "Ed25519", pub: encodeBase64Url(raw), role: "current" },
      { kid: "n".repeat(43), alg: "Ed25519", pub: "", role: "next" },
    ],
    seal: { kid: "s".repeat(43), alg: "X25519", pub: "AAAA" },
    keyset: options.keyset ?? 1,
    urls: ["https://panel.example.test"],
    issued: "2026-11-01T00:00:00.000Z",
    expires: options.expires ?? "2999-01-01T00:00:00.000Z",
  });
  const signature = await sign(
    `tp-http\n/api/daemon/v1/instance/identity\n${body}`,
  );
  return { fingerprint: kid, sign, body, header: `${kid}:${signature}` };
}

type Fields = {
  licenseId?: string;
  licenseToken?: string;
  urls?: string;
  fingerprint?: string;
  next?: string;
  ca?: string;
};

async function makeToken(panel: Panel, fields: Fields = {}): Promise<string> {
  const parts = [
    fields.licenseId ?? "lic-1",
    fields.licenseToken ?? "pa:ss/wo+rd=",
    fields.urls ?? "https://panel.example.test,https://alt.example.test:8443",
    fields.fingerprint ?? panel.fingerprint,
    fields.next ?? "",
    fields.ca ?? "",
  ].map(b64);
  const payload = b64(`v2:${parts.join(":")}`);
  return `${payload}.${await panel.sign(payload)}`;
}

/** Run `body` with the lifted functions and a fake curl serving `panel`. */
async function run(body: string, panel?: Panel, root?: string) {
  const dir = await Deno.makeTempDir();
  if (panel) {
    await Deno.writeTextFile(join(dir, "body"), panel.body);
    await Deno.writeTextFile(
      join(dir, "headers"),
      `HTTP/2 200\r\nX-TurboPanel-Signature: ${panel.header}\r\n\r\n`,
    );
  }
  const script = [
    "set -eu",
    STUBS,
    await lifted(),
    // The fake curl copies the fixtures to the -D and -o targets.
    `tp_instance_bootstrap_curl() { printf 'fakecurl'; }
fakecurl() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -D) cp ${quote(join(dir, "headers"))} "$2"; shift 2 ;;
      -o) cp ${quote(join(dir, "body"))} "$2"; shift 2 ;;
      *) shift ;;
    esac
  done
}`,
    `INSTALL_ROOT=${quote(root ?? join(dir, "root"))}`,
    body,
  ].join("\n");
  const result = await sh(script);
  await Deno.remove(dir, { recursive: true });
  return result;
}

const DECODE = (token: string) =>
  `tp_install_token_decode ${
    quote(token)
  } && printf '%s|%s|%s|%s|%s|%s' "$TOKEN_LICENSE_ID" "$TOKEN_LICENSE_TOKEN" "$TOKEN_PANEL_URLS" "$TOKEN_PANEL_FINGERPRINT" "$TOKEN_NEXT_FINGERPRINT" "$TOKEN_CA_FINGERPRINT"`;

test("a TOKEN decodes to six fields, with odd characters and empty ones", async () => {
  const panel = await makePanel();
  const token = await makeToken(panel);
  const result = await run(DECODE(token), panel);
  assertEquals(result.code, 0, result.stderr);
  assertEquals(
    result.stdout,
    [
      "lic-1",
      "pa:ss/wo+rd=",
      "https://panel.example.test,https://alt.example.test:8443",
      panel.fingerprint,
      "",
      "",
    ].join("|"),
  );
});

test("the older license value is told apart from a TOKEN", async () => {
  const legacy = b64("lic-1:secret");
  const result = await run(
    `rc=0; tp_install_token_decode ${quote(legacy)} || rc=$?; echo $rc`,
  );
  assertEquals(result.stdout.trim(), "2");
});

test("malformed TOKEN values are refused", async () => {
  const panel = await makePanel();
  const good = await makeToken(panel);
  const cases = [
    "not-a-token!",
    `${b64("v2:a:b")}.${"A".repeat(86)}`,
    await makeToken(panel, { fingerprint: "short" }),
    await makeToken(panel, { urls: "http://panel.example.test" }),
    await makeToken(panel, { urls: "https://panel.example.test/path" }),
    await makeToken(panel, { urls: "" }),
    good.split(".")[0],
  ];
  for (const token of cases) {
    const result = await run(`tp_install_token_decode ${quote(token)}`);
    assert(result.code !== 0, `accepted ${token}`);
  }
});

const VERIFY = (fingerprint: string) =>
  `TOKEN_PAYLOAD="$P"; TOKEN_SIG="$S"; PANEL_URLS="https://panel.example.test"; PANEL_FINGERPRINT=${
    quote(fingerprint)
  }; tp_verify_install_token && echo "keyset=$PANEL_KEYSET"`;

function verifyScript(token: string, fingerprint: string): string {
  const [payload, sig] = token.split(".");
  return `P=${quote(payload)}; S=${quote(sig)}\n${VERIFY(fingerprint)}`;
}

test("a TOKEN signed by the panel's key verifies against its document", async () => {
  const panel = await makePanel({ keyset: 4 });
  const token = await makeToken(panel);
  const result = await run(verifyScript(token, panel.fingerprint), panel);
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "keyset=4");
});

test("a tampered payload fails the signature", async () => {
  const panel = await makePanel();
  const token = await makeToken(panel);
  const other = await makeToken(panel, { licenseId: "lic-2" });
  const forged = `${other.split(".")[0]}.${token.split(".")[1]}`;
  const result = await run(verifyScript(forged, panel.fingerprint), panel);
  assert(result.code !== 0);
  assertStringIncludes(result.stderr, "signature is invalid");
});

test("another panel's key, an expired document or a bad header is refused", async () => {
  const panel = await makePanel();
  const stranger = await makePanel();
  const token = await makeToken(panel);
  let result = await run(verifyScript(token, stranger.fingerprint), panel);
  assert(result.code !== 0);
  assertStringIncludes(result.stderr, "not the one this command names");

  const expired = await makePanel({ expires: "2000-01-01T00:00:00.000Z" });
  result = await run(
    verifyScript(await makeToken(expired), expired.fingerprint),
    expired,
  );
  assert(result.code !== 0);
  assertStringIncludes(result.stderr, "expired");

  const bad = { ...panel, header: `${panel.fingerprint}:${"A".repeat(86)}` };
  result = await run(verifyScript(token, panel.fingerprint), bad);
  assert(result.code !== 0);
});

async function pinState(
  setup: string,
  vars: string,
): Promise<{ code: number; stdout: string; stderr: string; root: string }> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "lib"));
  const result = await run(
    `${setup}\n${vars}\ntp_resolve_panel_pin || exit 1\necho "action=$PIN_ACTION"\ntp_write_panel_identity_pin`,
    undefined,
    root,
  );
  return { ...result, root };
}

const FP_A = "a".repeat(43);
const FP_B = "b".repeat(43);
const EXISTING = (fp: string) =>
  `printf 'current=${fp}\\nnext=\\nkeyset=3\\nurls=https://old.example\\npinned_by=install\\nupdated=x\\n' > "$INSTALL_ROOT/lib/panel-identity"
printf 'host=https://old.example\\nhosts=https://old.example\\npanel_key=${fp}\\n' > "$INSTALL_ROOT/lib/update-origin"`;

test("a first install writes the pin file with its six lines", async () => {
  const state = await pinState(
    "",
    `PANEL_FINGERPRINT=${FP_A}; PANEL_NEXT_FINGERPRINT=${FP_B}; PANEL_KEYSET=2; PANEL_URLS=https://p.example; TOKEN_PAYLOAD=x; UNSAFE_NO_PANEL_KEY=false; HOST_URL=https://p.example`,
  );
  assertEquals(state.code, 0, state.stderr);
  assertStringIncludes(state.stdout, "action=write");
  const lines =
    (await Deno.readTextFile(join(state.root, "lib/panel-identity")))
      .trim().split("\n");
  assertEquals(lines.map((l) => l.split("=")[0]), [
    "current",
    "next",
    "keyset",
    "urls",
    "pinned_by",
    "updated",
  ]);
  assertEquals(lines[0], `current=${FP_A}`);
  assertEquals(lines[4], "pinned_by=install");
});

test("the unsafe flag records pinned_by=unsafe with no key", async () => {
  const state = await pinState(
    "",
    "PANEL_FINGERPRINT=''; PANEL_NEXT_FINGERPRINT=''; PANEL_KEYSET=''; PANEL_URLS=https://p.example; TOKEN_PAYLOAD=x; UNSAFE_NO_PANEL_KEY=true",
  );
  assertEquals(state.code, 0, state.stderr);
  const text = await Deno.readTextFile(join(state.root, "lib/panel-identity"));
  assertStringIncludes(text, "pinned_by=unsafe");
  assertStringIncludes(text, "current=\n");
});

test("a re-run without a TOKEN keeps the pin and the stored key", async () => {
  const state = await pinState(
    EXISTING(FP_A),
    "PANEL_FINGERPRINT=''; PANEL_URLS=''; TOKEN_PAYLOAD=''; UNSAFE_NO_PANEL_KEY=false",
  );
  assertEquals(state.code, 0, state.stderr);
  assertStringIncludes(state.stdout, "action=keep");
  const text = await Deno.readTextFile(join(state.root, "lib/panel-identity"));
  assertStringIncludes(text, "updated=x");
});

test("the same key again rewrites only urls and the time", async () => {
  const state = await pinState(
    EXISTING(FP_A),
    `PANEL_FINGERPRINT=${FP_A}; PANEL_KEYSET=3; PANEL_URLS=https://new.example; TOKEN_PAYLOAD=x; UNSAFE_NO_PANEL_KEY=false`,
  );
  assertEquals(state.code, 0, state.stderr);
  assertStringIncludes(state.stdout, "action=refresh");
  const text = await Deno.readTextFile(join(state.root, "lib/panel-identity"));
  assertStringIncludes(text, "urls=https://new.example");
  assertStringIncludes(text, "keyset=3");
  assertStringIncludes(text, `current=${FP_A}`);
});

test("a verified token pins a host that was installed without a key", async () => {
  const state = await pinState(
    `printf 'current=\\nnext=\\nkeyset=0\\nurls=\\npinned_by=unsafe\\nupdated=x\\n' > "$INSTALL_ROOT/lib/panel-identity"
printf 'host=h\\nhosts=h\\npanel_key=\\n' > "$INSTALL_ROOT/lib/update-origin"`,
    `PANEL_FINGERPRINT=${FP_A}; PANEL_NEXT_FINGERPRINT=''; PANEL_KEYSET=1; PANEL_URLS=https://p.example; TOKEN_PAYLOAD=x; UNSAFE_NO_PANEL_KEY=false`,
  );
  assertEquals(state.code, 0, state.stderr);
  assertStringIncludes(state.stdout, "action=write");
  const text = await Deno.readTextFile(join(state.root, "lib/panel-identity"));
  assertStringIncludes(text, `current=${FP_A}`);
  assertStringIncludes(text, "pinned_by=install");
});

test("a different key, an unsafe downgrade or a disagreeing origin is refused", async () => {
  let state = await pinState(
    EXISTING(FP_A),
    `PANEL_FINGERPRINT=${FP_B}; TOKEN_PAYLOAD=x; UNSAFE_NO_PANEL_KEY=false`,
  );
  assert(state.code !== 0);
  assertStringIncludes(state.stderr, "different panel key");

  state = await pinState(
    EXISTING(FP_A),
    "PANEL_FINGERPRINT=''; TOKEN_PAYLOAD=x; UNSAFE_NO_PANEL_KEY=true",
  );
  assert(state.code !== 0);

  state = await pinState(
    `${
      EXISTING(FP_A)
    }\nprintf 'host=h\\npanel_key=${FP_B}\\n' > "$INSTALL_ROOT/lib/update-origin"`,
    "PANEL_FINGERPRINT=''; TOKEN_PAYLOAD=''; UNSAFE_NO_PANEL_KEY=false",
  );
  assert(state.code !== 0);
  assertStringIncludes(state.stderr, "disagree");
});

test("a legacy install writes no pin file", async () => {
  const state = await pinState(
    "",
    "PANEL_FINGERPRINT=''; TOKEN_PAYLOAD=''; UNSAFE_NO_PANEL_KEY=false; HOST_URL=https://p.example",
  );
  assertEquals(state.code, 0, state.stderr);
  assertStringIncludes(state.stdout, "action=none");
  const exists = await Deno.stat(join(state.root, "lib/panel-identity")).then(
    () => true,
    () => false,
  );
  assertEquals(exists, false);
});
