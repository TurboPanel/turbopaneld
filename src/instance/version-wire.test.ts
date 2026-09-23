import { assertEquals } from "@std/assert";
import { DAEMON_VERSION } from "../version.ts";
import {
  compareSemver,
  DAEMON_FEATURE_MIN_VERSIONS,
  instanceUnsupportedReason,
  MIN_SUPPORTED_INSTANCE_VERSION,
  parseSemver,
  resolveDaemonCapabilities,
  resolveInstanceCapabilities,
  resolveInstanceSupport,
} from "./version-wire.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CERT_SOURCES = "instance-cert-sources-per-hostname";

test("resolveInstanceSupport: at or above the floor is supported, below is unsupported, absent is unknown", () => {
  const cases: Array<{
    reported: string | undefined;
    status: "supported" | "unsupported" | "unknown";
  }> = [
    { reported: "0.1.0", status: "supported" },
    { reported: "0.4.2", status: "supported" },
    { reported: "0.1.0-rc.1", status: "unsupported" },
    { reported: "0.0.9", status: "unsupported" },
    { reported: undefined, status: "unknown" },
    { reported: "unstamped", status: "unknown" },
  ];
  for (const entry of cases) {
    assertEquals(
      resolveInstanceSupport(entry.reported).status,
      entry.status,
      String(entry.reported),
    );
  }
  assertEquals(resolveInstanceSupport(undefined), {
    status: "unknown",
    version: null,
    minVersion: MIN_SUPPORTED_INSTANCE_VERSION,
  });
  assertEquals(resolveInstanceSupport("0.0.1", "0.0.1").status, "supported");
});

test("instanceUnsupportedReason is the greppable flag and does not say parked", () => {
  const reason = instanceUnsupportedReason(resolveInstanceSupport("0.0.9"));
  assertEquals(
    reason,
    "instance-version: control plane version 0.0.9 is below the supported minimum 0.1.0; flagged — the daemon keeps reconnecting (update the control plane)",
  );
  assertEquals(reason.includes("instance-version:"), true);
});

test("the instance floor is a semver no newer than this daemon", () => {
  const floor = parseSemver(MIN_SUPPORTED_INSTANCE_VERSION);
  const mine = parseSemver(DAEMON_VERSION);
  if (!floor || !mine) throw new TypeError("unparsable floor");
  assertEquals(compareSemver(floor, mine) <= 0, true);
  // Pin. Changing it requires the Versions-on-the-wires note in both AGENTS.md files.
  assertEquals(MIN_SUPPORTED_INSTANCE_VERSION, "0.1.0");
});

test("capability gates: above and equal open, below and unknown stay closed", () => {
  const floors = { [CERT_SOURCES]: "0.1.1" };
  assertEquals(resolveDaemonCapabilities("0.1.2", floors)[CERT_SOURCES], true);
  assertEquals(resolveDaemonCapabilities("0.1.1", floors)[CERT_SOURCES], true);
  assertEquals(resolveDaemonCapabilities("0.1.0", floors)[CERT_SOURCES], false);
  assertEquals(
    resolveDaemonCapabilities("0.1.1-rc.1", floors)[CERT_SOURCES],
    false,
  );
  assertEquals(
    resolveDaemonCapabilities(undefined, floors)[CERT_SOURCES],
    false,
  );
  assertEquals(
    resolveDaemonCapabilities("unstamped", floors)[CERT_SOURCES],
    false,
  );
  assertEquals(
    resolveDaemonCapabilities("0.1.1")[CERT_SOURCES],
    true,
  );
  assertEquals(DAEMON_FEATURE_MIN_VERSIONS[CERT_SOURCES], "0.1.1");
  assertEquals(resolveInstanceCapabilities(undefined), {});
  assertEquals(
    resolveInstanceCapabilities("9.9.9", {
      "future-instance-feature": "9.0.0",
    })[
      "future-instance-feature"
    ],
    true,
  );
});
