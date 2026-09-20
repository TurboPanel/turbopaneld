import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  signWithTestKey,
  TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
} from "../testing/release-signing-fixture.ts";

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
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

async function hostCanVerify(): Promise<boolean> {
  for (const bin of ["python3", "openssl"]) {
    try {
      const out = await new Deno.Command(bin, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (!out.success) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Run run.sh's verifier against a manifest file with the test key pinned. */
async function verifyWithRunSh(
  manifestJson: string,
): Promise<{ status: number; stderr: string }> {
  const source = await Deno.readTextFile(runShPath);
  const helpers = [
    "tp_manifest_canonical_python",
    "tp_manifest_signature_material_python",
    "tp_verify_manifest_signature",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-sig-" });
  try {
    const manifestPath = join(dir, "manifest.json");
    await Deno.writeTextFile(manifestPath, manifestJson);
    const script = [
      `TP_RELEASE_SIGNING_PUBLIC_KEY="${TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX}"`,
      helpers,
      `tp_verify_manifest_signature "$(cat "$1")"`,
    ].join("\n");
    const out = await new Deno.Command("sh", {
      args: ["-eu", "-c", script, "sh", manifestPath],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function manifest(): Record<string, unknown> {
  return {
    schema: 1,
    channel: "release",
    commit: "abc1234",
    buildId: "build-1",
    builtAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.1",
    binaryArtifacts: {
      "linux-amd64": {
        url: "https://x/amd64",
        sha256: "a".repeat(64),
        size: 1,
      },
      "linux-arm64": {
        url: "https://x/arm64",
        sha256: "b".repeat(64),
        size: 2,
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
  };
}

test("run.sh accepts a manifest signed by the pinned key", async () => {
  if (!(await hostCanVerify())) return;
  const signed = await signWithTestKey(manifest());
  const result = await verifyWithRunSh(JSON.stringify(signed, null, 2) + "\n");
  assertEquals(result.status, 0, result.stderr);
});

test("run.sh refuses an unsigned manifest", async () => {
  if (!(await hostCanVerify())) return;
  const result = await verifyWithRunSh(JSON.stringify(manifest()));
  assertEquals(result.status, 1);
  assertStringIncludes(result.stderr, "unsigned");
});

test("run.sh refuses a tampered manifest", async () => {
  if (!(await hostCanVerify())) return;
  const signed = await signWithTestKey(manifest());
  const tampered = {
    ...signed,
    orchestrationArtifact: {
      url: "https://evil/orch",
      sha256: "e".repeat(64),
      size: 4,
    },
  };
  const result = await verifyWithRunSh(JSON.stringify(tampered));
  assertEquals(result.status, 1);
  assertStringIncludes(result.stderr, "invalid");
});

test("run.sh refuses a malformed or foreign-algorithm signature", async () => {
  if (!(await hostCanVerify())) return;
  const signed = await signWithTestKey(manifest());
  for (
    const signature of [
      { ...signed.signature, alg: "rsa" },
      { ...signed.signature, value: "AAAA" },
      { ...signed.signature, value: "!!not base64!!" },
      "string",
    ]
  ) {
    const result = await verifyWithRunSh(
      JSON.stringify({ ...signed, signature }),
    );
    assertEquals(result.status, 1, JSON.stringify(signature));
    assertStringIncludes(result.stderr, "signature");
  }
});

test("run.sh verifies the daemon manifest before reading any field, and only bypasses for an overlay", async () => {
  const source = await Deno.readTextFile(runShPath);
  // Brace matching trips on the `[^}]` grep classes inside this function;
  // the body ends at the first line that is exactly `}`.
  const start = source.indexOf("tp_fetch_channel_manifest() {");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) {
    throw new TypeError("missing tp_fetch_channel_manifest in run.sh");
  }
  const fetcher = source.slice(start, end);
  const verifyAt = fetcher.indexOf("tp_verify_manifest_signature");
  const resolveAt = fetcher.indexOf("tp_resolve_channel_manifest");
  if (verifyAt < 0 || resolveAt < 0) {
    throw new TypeError("run.sh lost the manifest verification step");
  }
  assertEquals(verifyAt < resolveAt, true);
  const bypass = extractShellFunction(source, "tp_manifest_signature_bypass");
  assertStringIncludes(bypass, "TURBOPANEL_DL_BASE");
  // The bypass keys on the overlay flag alone — no manifest content, no
  // TURBOPANEL_MANIFEST_URL pin, no channel name.
  assertEquals(bypass.includes("_manifest_json"), false);
  assertEquals(bypass.includes("MANIFEST_URL"), false);
});
