import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  signWithTestKey,
  TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
} from "../testing/release-signing-fixture.ts";
import {
  extractShellFunction,
  hostCanVerify,
  RUN_SH_PATH as runShPath,
  verifyWithRunSh,
} from "../testing/run-sh-manifest-verifier.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

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

function repoManifest(repo: "turbopanel" | "ui"): Record<string, unknown> {
  return {
    schema: 1,
    repo,
    channel: "release",
    commit: "def5678",
    version: "0.1.2",
    artifacts: {
      "linux-amd64": {
        url:
          `https://github.com/TurboPanel/${repo}/releases/download/v0.1.2/a.tar.zst`,
        sha256: "a".repeat(64),
        size: 1,
      },
    },
  };
}

/**
 * Run run.sh's real `tp_fetch_repo_manifest` (the `--instance` fetch of the
 * control-plane / UI manifest) against a local manifest file: only curl is
 * stubbed, every verification helper is the one run.sh ships.
 */
async function fetchRepoManifestWithRunSh(
  repo: "turbopanel" | "ui",
  manifestJson: string,
  env: Record<string, string> = {},
): Promise<{ status: number; stderr: string }> {
  const source = await Deno.readTextFile(runShPath);
  const helpers = [
    "tp_manifest_canonical_python",
    "tp_manifest_signature_material_python",
    "tp_verify_manifest_signature",
    "tp_manifest_signature_bypass",
    "tp_manifest_compact",
    "tp_fetch_repo_manifest",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-repo-" });
  try {
    const manifestPath = join(dir, "manifest.json");
    await Deno.writeTextFile(manifestPath, manifestJson);
    const pinVar = repo === "turbopanel"
      ? "TURBOPANEL_INSTANCE_MANIFEST_URL"
      : "TURBOPANEL_UI_MANIFEST_URL";
    const script = [
      `TP_RELEASE_SIGNING_PUBLIC_KEY="${TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX}"`,
      `tp_print_styled_line() { printf '%s\\n' "$2"; }`,
      `tp_release_curl() { printf 'fake_curl'; }`,
      `fake_curl() { cat "$MANIFEST_PATH"; }`,
      helpers,
      `${pinVar}="https://github.com/TurboPanel/${repo}/releases/download/v0.1.2/manifest.json"`,
      `tp_fetch_repo_manifest ${repo}`,
    ].join("\n");
    const out = await new Deno.Command("sh", {
      args: ["-u", "-c", script],
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        MANIFEST_PATH: manifestPath,
        ...env,
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stderr: new TextDecoder().decode(out.stderr) +
        new TextDecoder().decode(out.stdout),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const repo of ["turbopanel", "ui"] as const) {
  test(`run.sh --instance refuses an unsigned ${repo} manifest`, async () => {
    if (!(await hostCanVerify())) return;
    const result = await fetchRepoManifestWithRunSh(
      repo,
      JSON.stringify(repoManifest(repo)),
    );
    assertEquals(result.status, 1, result.stderr);
    assertStringIncludes(result.stderr, "unsigned");
    assertStringIncludes(result.stderr, `TurboPanel/${repo}/releases`);
  });

  test(`run.sh --instance refuses a tampered ${repo} manifest`, async () => {
    if (!(await hostCanVerify())) return;
    const signed = await signWithTestKey(repoManifest(repo));
    const result = await fetchRepoManifestWithRunSh(
      repo,
      JSON.stringify({ ...signed, commit: "evil000" }),
    );
    assertEquals(result.status, 1, result.stderr);
    assertStringIncludes(result.stderr, "invalid signature");
  });

  test(`run.sh --instance accepts a signed ${repo} manifest`, async () => {
    if (!(await hostCanVerify())) return;
    const signed = await signWithTestKey(repoManifest(repo));
    const result = await fetchRepoManifestWithRunSh(
      repo,
      JSON.stringify(signed, null, 2),
    );
    assertEquals(result.status, 0, result.stderr);
  });
}

test("run.sh --instance skips the signature only for a development overlay", async () => {
  if (!(await hostCanVerify())) return;
  const unsigned = JSON.stringify(repoManifest("turbopanel"));
  const overlay = await fetchRepoManifestWithRunSh("turbopanel", unsigned, {
    TURBOPANEL_DL_BASE: "https://dev.example.lan:8443",
  });
  assertEquals(overlay.status, 0, overlay.stderr);
  assertStringIncludes(overlay.stderr, "DEVELOPMENT OVERLAY");
  // An unrelated env var is not the overlay flag.
  const other = await fetchRepoManifestWithRunSh("turbopanel", unsigned, {
    TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST: "1",
  });
  assertEquals(other.status, 1, other.stderr);
});
