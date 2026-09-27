import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  compareSemver,
  parseSemver,
  resolveDaemonCapabilities,
  resolveInstanceSupport,
} from "../instance/version-wire.ts";
import { assertControlPlaneUpdateAllowed } from "../instance/run-reconcile.ts";
import { DAEMON_VERSION } from "../version.ts";
import { pinnedChannelManifestUrl, releaseManifestUrlAllowed } from "./urls.ts";
import fixture from "./testing/release-labels.json" with { type: "json" };

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The daemon's version comparisons and per-build manifest URLs, fed the
 * release labels production really carries (testing/release-labels.json,
 * shared in shape with the control plane's fixture). Plain semver once ranked
 * every canary of an installed base below it and refused the rollout; these
 * pin what each daemon-side comparison does with each spelling.
 */
const LABELS = fixture.labels;
const RUN_SH = join(
  dirname(fromFileUrl(import.meta.url)),
  "../../scripts/run.sh",
);

const parsed = (version: string) => {
  const value = parseSemver(version);
  assert(value, `${version} does not parse`);
  return value;
};

test("every real release label parses, and the v-tag is the release", () => {
  for (const { version } of LABELS) parsed(version);
  assertEquals(parsed("v0.1.1"), parsed("0.1.1"));
});

test("semver orders the real labels the way they were built", () => {
  for (const a of LABELS) {
    for (const b of LABELS) {
      const got = Math.sign(
        compareSemver(parsed(a.version), parsed(b.version)),
      );
      assertEquals(
        got,
        Math.sign(a.rank - b.rank),
        `${a.name} (${a.version}) vs ${b.name} (${b.version})`,
      );
    }
  }
});

test("no real control-plane label is flagged unsupported or refused as an update target", () => {
  for (const { version } of LABELS) {
    assertEquals(resolveInstanceSupport(version).status, "supported", version);
    assertControlPlaneUpdateAllowed(version);
  }
});

test("the daemon reports its plain base, so base-keyed capability floors open on canary builds too", () => {
  // Canary artifacts are labelled `<base>-canary.<id>` but the binary
  // reports deno.json's base; a label here would rank below its own floor.
  assertEquals(parseSemver(DAEMON_VERSION)?.prerelease, []);
  const floorOpen = resolveDaemonCapabilities("0.1.1");
  assert(Object.values(floorOpen).every(Boolean));
  const canaryLabel = LABELS.find((l) => l.name === "canary")!.version;
  const labelled = resolveDaemonCapabilities(canaryLabel);
  assertEquals(
    labelled["instance-cert-sources-per-hostname"],
    false,
    "a canary label ranks below 0.1.1: never report the label as the version",
  );
});

/** run.sh's `tp_pinned_channel_manifest_url`, run for real. */
async function runShPinnedUrl(
  kind: string,
  channel: string,
  version: string,
): Promise<string | null> {
  const source = await Deno.readTextFile(RUN_SH);
  const fn = (name: string) => {
    const start = source.indexOf(`\n${name}() {`);
    assert(start >= 0, `run.sh no longer defines ${name}`);
    return source.slice(start + 1, source.indexOf("\n}\n", start) + 2);
  };
  const out = await new Deno.Command("sh", {
    args: [
      "-c",
      `${fn("tp_pinned_version_ok")}\n${
        fn("tp_pinned_channel_manifest_url")
      }\ntp_pinned_channel_manifest_url "$@"`,
      "sh",
      kind,
      channel,
      version,
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  return out.success ? new TextDecoder().decode(out.stdout) : null;
}

test("daemon and run.sh build the same per-build manifest URL for every real label", async () => {
  for (const kind of ["daemon", "instance", "ui"] as const) {
    for (const channel of ["canary", "rc", "release"] as const) {
      for (const { version } of LABELS) {
        const daemon = pinnedChannelManifestUrl(kind, channel, version);
        assertEquals(
          await runShPinnedUrl(kind, channel, version),
          daemon,
          `${kind} ${channel} ${version}`,
        );
        if (version.startsWith("v")) {
          assertEquals(daemon, null, "a tag spelling is not a version token");
          continue;
        }
        assert(daemon, `${kind} ${channel} ${version} has no manifest URL`);
        assert(
          releaseManifestUrlAllowed(kind, daemon),
          `the rail refuses its own pin ${daemon}`,
        );
      }
    }
  }
});
