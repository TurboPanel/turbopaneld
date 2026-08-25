import { assertEquals } from "@std/assert";
import type { LayoutPaths } from "../src/paths/layout.ts";
import {
  assertDaemonUnitLock,
  assertProductionLayout,
  assertRuntimesDirContract,
  collectForbiddenReferenceFailures,
  collectRetiredIdentityFailures,
  isSkippedPath,
  recordLayoutMismatch,
  reportLayoutFailures,
} from "./check-production-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function productionLayout(
  overrides: Partial<LayoutPaths> = {},
): LayoutPaths {
  return {
    mode: "production",
    home: "/opt/turbopanel",
    binDir: "/opt/turbopanel/bin",
    libDir: "/opt/turbopanel/lib",
    runtimeDir: "/opt/turbopanel/vendor",
    runtimesDir: "/opt/turbopanel/vendor",
    shareDir: "/opt/turbopanel/share",
    uiDir: "/opt/turbopanel/share/ui",
    orchestrationDir: "/opt/turbopanel/share/orchestration",
    configDir: "/etc/turbopanel",
    stateDir: "/var/lib/turbopanel",
    daemonStateDir: "/var/lib/turbopanel",
    logDir: "/var/log/turbopanel",
    runDir: "/run/turbopanel",
    principalHomeRoot: "/srv/users",
    daemonRootDefault: "/opt/turbopanel/lib/daemon",
    instanceDir: "/opt/turbopanel/lib/instance",
    instanceConfigDir: "/etc/turbopanel/instance",
    instanceCaPath: "/etc/turbopanel/instance-ca.pem",
    tlsDir: "/etc/turbopanel/tls",
    ...overrides,
  };
}

test("recordLayoutMismatch records mismatches only", () => {
  const failures: string[] = [];
  recordLayoutMismatch(failures, "home", "/opt/turbopanel", "/opt/turbopanel");
  recordLayoutMismatch(failures, "home", "/wrong", "/opt/turbopanel");
  assertEquals(failures, [
    'layout home: expected "/opt/turbopanel", got "/wrong"',
  ]);
});

test("assertProductionLayout accepts the canonical tree and flags leaks", () => {
  const ok: string[] = [];
  assertProductionLayout(ok, productionLayout());
  assertEquals(ok, []);

  const leaks: string[] = [];
  assertProductionLayout(
    leaks,
    productionLayout({
      orchestrationDir: "/opt/turbopanel/platform/orchestration",
      instanceDir: "/opt/turbopanel/platform/instance",
      daemonRootDefault: "/opt/turbopanel/platform/daemon",
      home: "/wrong",
    }),
  );
  assertEquals(
    leaks.some((line) => line.includes("orchestrationDir leaked")),
    true,
  );
  assertEquals(leaks.some((line) => line.includes("instanceDir leaked")), true);
  assertEquals(
    leaks.some((line) => line.includes("daemonRootDefault leaked")),
    true,
  );
  assertEquals(leaks.some((line) => line.startsWith("layout home:")), true);
});

test("assertDaemonUnitLock requires the runtime_socket_dir token", () => {
  const ok: string[] = [];
  assertDaemonUnitLock(
    ok,
    "ExecStartPre=flock {{ runtime_socket_dir }}/daemon.lock",
  );
  assertEquals(ok, []);

  const hardcoded: string[] = [];
  assertDaemonUnitLock(hardcoded, "flock /run/turbopanel/daemon.lock");
  assertEquals(hardcoded.length, 2);

  const missing: string[] = [];
  assertDaemonUnitLock(missing, "ExecStart=turbopaneld");
  assertEquals(missing.length, 1);
});

test("isSkippedPath matches Galaxy docker role trees", () => {
  assertEquals(
    isSkippedPath("orchestration/roles/geerlingguy.docker/tasks"),
    true,
  );
  assertEquals(isSkippedPath("roles/geerlingguy/docker/tasks"), true);
  assertEquals(isSkippedPath("src/paths/layout.ts"), false);
});

test("collectForbiddenReferenceFailures flags each retired path", () => {
  const rel = "src/example.ts";
  const ansibleShare = `share/${"ansible"}/`;
  const failures = collectForbiddenReferenceFailures(
    rel,
    [
      "const root = '/opt/turbopanel/platform';",
      `assets under ${ansibleShare}`,
      "legacy /opt/turbopanel/runtimes",
      "legacy /opt/turbopanel/lib/runtime",
      "hardcoded /opt/turbopanel/vendor",
    ].join("\n"),
  );
  assertEquals(failures.length, 5);
  assertEquals(
    collectForbiddenReferenceFailures(
      "src/paths/layout.ts",
      "/opt/turbopanel/platform\n/opt/turbopanel/vendor",
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "src/example.test.ts",
      "/opt/turbopanel/platform\n/opt/turbopanel/vendor",
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "scripts/lib/release-artifacts.sh",
      `reject share/${"ansible"} leftovers`,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "src/dev-sync-apply.ts",
      "mentions /opt/turbopanel/runtimes",
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "src/other.ts",
      `uses /usr/share/${"ansible"}/collections`,
    ),
    [],
  );
});

test("collectRetiredIdentityFailures matches fallback tokens", () => {
  const failures = collectRetiredIdentityFailures(
    "src/foo.ts",
    [
      `else "${"turbopanel"}i"`,
      `default("${"turbopanel"}c")`,
      `else '${"turbopanel"}'`,
      "const ok = 'tpctrl';",
    ].join("\n"),
  );
  assertEquals(failures.length, 3);
  assertEquals(
    collectRetiredIdentityFailures("src/foo.ts", "const user = 'tp';"),
    [],
  );
});

test("assertRuntimesDirContract matches the production default", () => {
  const failures: string[] = [];
  assertRuntimesDirContract(failures);
  assertEquals(failures, []);
});

test("reportLayoutFailures exits on problems and logs success", () => {
  const errors: string[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  reportLayoutFailures(["bad path"], {
    error: (message) => {
      errors.push(message);
    },
    log: (message) => {
      logs.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(exits, [1]);
  assertEquals(errors[0], "Production layout check failed:\n");

  reportLayoutFailures([], {
    error: (message) => {
      errors.push(message);
    },
    log: (message) => {
      logs.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(logs.at(-1)?.includes("passed"), true);
});
