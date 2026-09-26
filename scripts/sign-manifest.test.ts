import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { verifyManifestSignature } from "../src/update/signing.ts";
import {
  TEST_RELEASE_SIGNING_KEY_PEM,
  TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
} from "../src/testing/release-signing-fixture.ts";
import {
  hostCanVerify,
  verifyWithRunSh,
} from "../src/testing/run-sh-manifest-verifier.ts";
import { main, SignManifestError, signManifestText } from "./sign-manifest.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** The shape TurboPanel/turbopanel's release.yml writes. */
function instanceManifest(): Record<string, unknown> {
  return {
    schema: 1,
    channel: "canary",
    version: "0.1.1-canary.20260926-041654-307dfdd",
    commit: "307dfdda3f0000000000000000000000000000ff",
    buildId: "20260926-041654-307dfdd",
    builtAt: "2026-09-26T04:16:54Z",
    artifacts: {
      "instance-linux-amd64": {
        url:
          "https://github.com/TurboPanel/turbopanel/releases/download/canary/turbopanel-instance-0.1.1-canary.20260926-041654-307dfdd-linux-amd64.tar.zst",
        sha256: "a".repeat(64),
        size: 204_000_000,
      },
      "instance-linux-arm64": {
        url:
          "https://github.com/TurboPanel/turbopanel/releases/download/canary/turbopanel-instance-0.1.1-canary.20260926-041654-307dfdd-linux-arm64.tar.zst",
        sha256: "b".repeat(64),
        size: 198_000_000,
      },
    },
  };
}

/** The shape TurboPanel/ui's release.yml writes. */
function uiManifest(): Record<string, unknown> {
  return {
    schema: 1,
    channel: "release",
    version: "0.1.1",
    commit: "b909e1d30000000000000000000000000000aaaa",
    buildId: "20260926-040145-b909e1d",
    builtAt: "2026-09-26T04:01:45Z",
    artifacts: {
      ui: {
        url:
          "https://github.com/TurboPanel/ui/releases/download/v0.1.1/turbopanel-ui-0.1.1.tar.gz",
        sha256: "c".repeat(64),
        size: 3_100_000,
      },
    },
  };
}

/** Python's `json.dump(indent=2)` output, the exact bytes the release job writes. */
function asReleaseJobWrites(manifest: Record<string, unknown>): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

async function sign(manifest: Record<string, unknown>): Promise<string> {
  return await signManifestText(
    asReleaseJobWrites(manifest),
    TEST_RELEASE_SIGNING_KEY_PEM,
    TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
  );
}

for (
  const [label, build] of [["instance", instanceManifest], [
    "ui",
    uiManifest,
  ]] as const
) {
  test(`a signed ${label} manifest verifies with resolveUpdate's verifier and run.sh's`, async () => {
    const signed = await sign(build());
    const parsed = JSON.parse(signed) as Record<string, unknown>;
    await verifyManifestSignature(parsed, TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX);
    if (await hostCanVerify()) {
      const result = await verifyWithRunSh(signed);
      assertEquals(result.status, 0, result.stderr);
    }
  });

  test(`a tampered ${label} manifest fails both verifiers`, async () => {
    const signed = JSON.parse(await sign(build())) as Record<string, unknown>;
    const artifacts = signed.artifacts as Record<
      string,
      Record<string, unknown>
    >;
    const first = Object.keys(artifacts)[0]!;
    artifacts[first] = { ...artifacts[first], url: "https://evil.example/x" };
    await assertRejects(() =>
      verifyManifestSignature(signed, TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX)
    );
    if (await hostCanVerify()) {
      const result = await verifyWithRunSh(JSON.stringify(signed));
      assertEquals(result.status, 1);
      assertStringIncludes(result.stderr, "invalid");
    }
  });
}

test("today's unsigned instance manifest is exactly what run.sh refuses once enforced", async () => {
  if (!(await hostCanVerify())) return;
  const result = await verifyWithRunSh(asReleaseJobWrites(instanceManifest()));
  assertEquals(result.status, 1);
  assertStringIncludes(result.stderr, "unsigned");
});

test("a missing or empty signing key refuses instead of leaving the manifest unsigned", async () => {
  for (const pem of [undefined, "", "   \n"]) {
    const err = await assertRejects(
      () => signManifestText(asReleaseJobWrites(uiManifest()), pem),
      SignManifestError,
    );
    assertStringIncludes(err.message, "RELEASE_SIGNING_KEY");
  }
});

test("a key that does not match the pinned public key fails the publish", async () => {
  const err = await assertRejects(
    () =>
      signManifestText(
        asReleaseJobWrites(instanceManifest()),
        TEST_RELEASE_SIGNING_KEY_PEM,
        "00".repeat(32),
      ),
    SignManifestError,
  );
  assertStringIncludes(err.message, "does not match");
});

test("an earlier signature is replaced, and non-object JSON is refused", async () => {
  const once = JSON.parse(await sign(instanceManifest())) as Record<
    string,
    unknown
  >;
  const stale = {
    ...once,
    signature: { alg: "ed25519", keyId: "deadbeef", value: "AAAA" },
  };
  const again = JSON.parse(
    await signManifestText(
      JSON.stringify(stale),
      TEST_RELEASE_SIGNING_KEY_PEM,
      TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
    ),
  ) as Record<string, unknown>;
  await verifyManifestSignature(again, TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX);
  assertEquals(again.signature, once.signature);
  for (const bad of ["[]", "42", "not json"]) {
    await assertRejects(
      () =>
        signManifestText(
          bad,
          TEST_RELEASE_SIGNING_KEY_PEM,
          TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        ),
      SignManifestError,
    );
  }
});

test("the CLI signs files in place and exits non-zero when it refuses", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-sign-manifest-" });
  try {
    const path = join(dir, "manifest.json");
    await Deno.writeTextFile(path, asReleaseJobWrites(uiManifest()));
    const lines: string[] = [];

    assertEquals(await main([], () => undefined, (l) => lines.push(l)), 2);
    assertEquals(
      await main([path], () => undefined, (l) => lines.push(l)),
      1,
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(path)).signature,
      undefined,
      "a refused run must leave the file untouched",
    );
    assertStringIncludes(
      lines.join("\n"),
      "Refusing to leave the manifest unsigned",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
