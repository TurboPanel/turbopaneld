import { assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  signWithTestKey,
  TEST_RELEASE_SIGNING_KEY_PEM,
  TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
} from "../testing/release-signing-fixture.ts";
import { ManifestSignatureError } from "./errors.ts";
import {
  canonicalManifestBytes,
  DEV_UNSIGNED_MANIFEST_ENV,
  importSigningKey,
  publicKeyOf,
  RELEASE_SIGNING_PUBLIC_KEY_HEX,
  signingKeyId,
  signManifest,
  unsignedManifestBypass,
  verifyManifestSignature,
} from "./signing.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");

function fixtureManifest(): Record<string, unknown> {
  return {
    schema: 1,
    channel: "release",
    commit: "abc1234",
    buildId: "build-1",
    builtAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.1",
    defaultControlPlaneUrl: "https://turbopanel.app",
    binaryArtifacts: {
      "linux-arm64": {
        url: "https://x/arm64",
        sha256: "b".repeat(64),
        size: 2,
      },
      "linux-amd64": {
        url: "https://x/amd64",
        sha256: "a".repeat(64),
        size: 1,
      },
    },
    jsFallbackArtifact: {
      url: "https://x/js",
      sha256: "c".repeat(64),
      size: 3,
    },
    orchestrationArtifact: {
      url: "https://x/orch",
      sha256: "d".repeat(64),
      size: 4,
    },
    releaseNotesUrl: "https://x/notes — ünïcode",
  };
}

test("canonicalManifestBytes sorts keys, drops whitespace and the signature field", () => {
  const bytes = canonicalManifestBytes({
    b: 1,
    a: [{ z: null, y: "s" }],
    signature: { alg: "ed25519", keyId: "x", value: "y" },
  });
  assertEquals(
    new TextDecoder().decode(bytes),
    '{"a":[{"y":"s","z":null}],"b":1}',
  );
});

test("canonical bytes match run.sh's python3 canonicaliser byte-for-byte", async () => {
  const runSh = await Deno.readTextFile(runShPath);
  const start = runSh.indexOf("tp_manifest_canonical_python() {");
  if (start < 0) {
    throw new TypeError("run.sh lost tp_manifest_canonical_python");
  }
  // The helper prints its python program; run the same program here.
  const program = /<<'PY'\n([\s\S]*?)\nPY/.exec(runSh.slice(start))?.[1];
  if (!program) throw new TypeError("run.sh canonicaliser heredoc not found");

  const manifest = await signWithTestKey(fixtureManifest());
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("python3", {
      args: ["-c", program],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    // No python3 on this host — the parity check runs where run.sh does.
    return;
  }
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"),
  );
  await writer.close();
  const python = await child.output();
  assertEquals(python.success, true, new TextDecoder().decode(python.stderr));
  assertEquals(
    python.stdout,
    canonicalManifestBytes(manifest),
  );
});

test("signManifest produces a signature verifyManifestSignature accepts", async () => {
  const key = await importSigningKey(TEST_RELEASE_SIGNING_KEY_PEM);
  const signed = await signManifest(fixtureManifest(), key);
  assertEquals(signed.signature.alg, "ed25519");
  assertEquals(
    signed.signature.keyId,
    await signingKeyId(await publicKeyOf(key)),
  );
  await verifyManifestSignature(signed, TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX);
});

test("publicKeyOf recovers the fixture's public key", async () => {
  const key = await importSigningKey(TEST_RELEASE_SIGNING_KEY_PEM);
  const pub = await publicKeyOf(key);
  assertEquals(
    Array.from(pub, (b) => b.toString(16).padStart(2, "0")).join(""),
    TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
  );
});

test("verifyManifestSignature rejects a missing signature", async () => {
  await assertRejects(
    () =>
      verifyManifestSignature(
        fixtureManifest(),
        TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
      ),
    ManifestSignatureError,
    "unsigned",
  );
});

test("verifyManifestSignature rejects a tampered manifest", async () => {
  const signed = await signWithTestKey(fixtureManifest());
  const tampered = {
    ...signed,
    jsFallbackArtifact: { ...signed.jsFallbackArtifact as object, size: 99 },
  };
  await assertRejects(
    () =>
      verifyManifestSignature(tampered, TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX),
    ManifestSignatureError,
    "invalid",
  );
});

test("verifyManifestSignature rejects a signature from another key", async () => {
  const signed = await signWithTestKey(fixtureManifest());
  // The pinned release key did not sign this.
  await assertRejects(
    () => verifyManifestSignature(signed, RELEASE_SIGNING_PUBLIC_KEY_HEX),
    ManifestSignatureError,
    "invalid",
  );
});

test("verifyManifestSignature rejects malformed signature fields", async () => {
  const signed = await signWithTestKey(fixtureManifest());
  const cases: Array<[unknown, string]> = [
    ["not-an-object", "must be an object"],
    [{ ...signed.signature, alg: "rsa" }, "signature.alg"],
    [{ ...signed.signature, keyId: "" }, "keyId"],
    [{ ...signed.signature, value: "" }, "value"],
    [{ ...signed.signature, value: "!!!" }, "not base64"],
    [{ ...signed.signature, value: "AAAA" }, "64 bytes"],
  ];
  for (const [signature, needle] of cases) {
    await assertRejects(
      () =>
        verifyManifestSignature(
          { ...signed, signature },
          TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        ),
      ManifestSignatureError,
      needle,
    );
  }
});

test("verifyManifestSignature rejects an unusable pinned key", async () => {
  const signed = await signWithTestKey(fixtureManifest());
  await assertRejects(
    () => verifyManifestSignature(signed, "zz"),
    ManifestSignatureError,
    "not valid hex",
  );
  await assertRejects(
    () => verifyManifestSignature(signed, "ab"),
    ManifestSignatureError,
    "32 bytes",
  );
});

test("importSigningKey only accepts a PKCS#8 PEM", async () => {
  await assertRejects(
    () => importSigningKey(""),
    ManifestSignatureError,
    "PKCS#8",
  );
  await assertRejects(
    () =>
      importSigningKey(
        "-----BEGIN PRIVATE KEY-----\n@@@\n-----END PRIVATE KEY-----",
      ),
    ManifestSignatureError,
    "not base64",
  );
});

test("the pinned release key is 32 bytes and not the test key", () => {
  assertEquals(/^[0-9a-f]{64}$/.test(RELEASE_SIGNING_PUBLIC_KEY_HEX), true);
  const pinned: string = RELEASE_SIGNING_PUBLIC_KEY_HEX;
  assertEquals(pinned === TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX, false);
});

test("run.sh pins the same release public key as signing.ts", async () => {
  const runSh = await Deno.readTextFile(runShPath);
  const pinned = /^TP_RELEASE_SIGNING_PUBLIC_KEY="([0-9a-f]{64})"$/m.exec(
    runSh,
  )?.[1];
  assertEquals(pinned, RELEASE_SIGNING_PUBLIC_KEY_HEX);
});

test("unsignedManifestBypass is development-only and host-side", () => {
  const on = { [DEV_UNSIGNED_MANIFEST_ENV]: "1" };
  assertEquals(
    unsignedManifestBypass({
      installMode: "development",
      overlay: false,
      env: {},
    }),
    true,
  );
  assertEquals(
    unsignedManifestBypass({
      installMode: "production",
      overlay: true,
      env: on,
    }),
    true,
  );
  // The built-in rail and pinned manifests never bypass, flag or not.
  assertEquals(
    unsignedManifestBypass({
      installMode: "production",
      overlay: false,
      env: on,
    }),
    false,
  );
  assertEquals(
    unsignedManifestBypass({
      installMode: "production",
      overlay: true,
      env: {},
    }),
    false,
  );
  assertEquals(
    unsignedManifestBypass({
      installMode: "production",
      overlay: true,
      env: { [DEV_UNSIGNED_MANIFEST_ENV]: "true" },
    }),
    false,
  );
});
