import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../src/paths/layout.ts";
import {
  assertDaemonUnitLock,
  assertProductionLayout,
  assertReleaseRootVerifyNotTracked,
  assertRuntimesDirContract,
  collectForbiddenReferenceFailures,
  collectRetiredIdentityFailures,
  isSkippedPath,
  recordLayoutMismatch,
  reportLayoutFailures,
  runProductionLayoutCheck,
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

test("collectForbiddenReferenceFailures honors remaining allowlists", () => {
  const vendor = "/opt/turbopanel/vendor";
  const platform = "/opt/turbopanel/platform";
  const runtimes = "/opt/turbopanel/runtimes";
  const libRuntime = "/opt/turbopanel/lib/runtime";
  assertEquals(
    collectForbiddenReferenceFailures(
      "scripts/run-orchestration-action.ts",
      platform,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "src/orchestration/cloudflared.ts",
      `${runtimes}\n${libRuntime}`,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "scripts/lib/runtime-paths.sh",
      vendor,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "scripts/install-daemon-systemd.sh",
      vendor,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "orchestration/playbooks/daemon-install.yml",
      vendor,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "orchestration/roles/deno-runtime/meta/main.yml",
      vendor,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "src/orchestration/paths.test.ts",
      vendor,
      false,
    ),
    [],
  );
  assertEquals(
    collectForbiddenReferenceFailures(
      "src/example.ts",
      platform,
      true,
    ),
    [],
  );
});

test("collectRetiredIdentityFailures matches remaining quote styles", () => {
  const failures = collectRetiredIdentityFailures(
    "src/foo.ts",
    [
      `else '${"turbopanel"}i'`,
      `default("${"turbopanel"}i")`,
      `else "${"turbopanel"}c"`,
      `default('${"turbopanel"}c')`,
      `default('${"turbopanel"}')`,
      `else "${"turbopanel"}"`,
    ].join("\n"),
  );
  assertEquals(failures.length, 6);
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

test("reportLayoutFailures defaults to console and Deno.exit", () => {
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  const originalExit = Deno.exit;
  console.error = ((message: unknown) => {
    errors.push(String(message));
  }) as typeof console.error;
  console.log = ((message: unknown) => {
    logs.push(String(message));
  }) as typeof console.log;
  Deno.exit = ((code: number) => {
    throw new TypeError(`exit ${code}`);
  }) as typeof Deno.exit;
  try {
    assertThrows(() => reportLayoutFailures(["x"]), TypeError, "exit 1");
    assertEquals(errors[0], "Production layout check failed:\n");
    reportLayoutFailures([]);
    assertEquals(logs.at(-1)?.includes("passed"), true);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    Deno.exit = originalExit;
  }
});

async function git(
  cwd: string,
  args: string[],
): Promise<{ success: boolean; stdout: string }> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout),
  };
}

test("assertReleaseRootVerifyNotTracked ignores git failures and empty trees", async () => {
  const missingGit = await Deno.makeTempDir({ prefix: "layout-nogit-" });
  try {
    const failures: string[] = [];
    await assertReleaseRootVerifyNotTracked(failures, missingGit);
    assertEquals(failures, []);
  } finally {
    await Deno.remove(missingGit, { recursive: true });
  }

  const clean = await Deno.makeTempDir({ prefix: "layout-cleangit-" });
  try {
    const init = await git(clean, ["init"]);
    if (!init.success) throw new TypeError("git init failed");
    const failures: string[] = [];
    await assertReleaseRootVerifyNotTracked(failures, clean);
    assertEquals(failures, []);
  } finally {
    await Deno.remove(clean, { recursive: true });
  }
});

test("assertReleaseRootVerifyNotTracked flags tracked extract trees", async () => {
  const root = await Deno.makeTempDir({ prefix: "layout-tracked-" });
  try {
    const init = await git(root, ["init"]);
    if (!init.success) throw new TypeError("git init failed");
    await git(root, ["config", "user.email", "layout@test"]);
    await git(root, ["config", "user.name", "Layout Test"]);
    for (let i = 0; i < 6; i++) {
      await Deno.writeTextFile(join(root, `release-root-verify-${i}`), "x\n");
    }
    const add = await git(root, ["add", "release-root-verify-0"]);
    if (!add.success) throw new TypeError("git add failed");
    const one: string[] = [];
    await assertReleaseRootVerifyNotTracked(one, root);
    assertEquals(one.length, 1);
    assertEquals(one[0]?.includes("release-root-verify-0"), true);
    assertEquals(one[0]?.includes("…"), false);

    const addRest = await git(root, ["add", "."]);
    if (!addRest.success) throw new TypeError("git add rest failed");
    const many: string[] = [];
    await assertReleaseRootVerifyNotTracked(many, root);
    assertEquals(many.length, 1);
    assertEquals(many[0]?.includes("…"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("runProductionLayoutCheck walks fixtures and skips vendored trees", async () => {
  const root = await Deno.makeTempDir({ prefix: "layout-walk-" });
  try {
    const init = await git(root, ["init"]);
    if (!init.success) throw new TypeError("git init failed");
    await Deno.mkdir(
      join(
        root,
        "orchestration/roles/daemon-launch/templates",
      ),
      { recursive: true },
    );
    await Deno.writeTextFile(
      join(
        root,
        "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2",
      ),
      "ExecStartPre=flock {{ runtime_socket_dir }}/daemon.lock\n",
    );
    await Deno.mkdir(join(root, "src/coverage"), { recursive: true });
    await Deno.mkdir(
      join(root, "orchestration/roles/geerlingguy.docker/tasks"),
      { recursive: true },
    );
    await Deno.writeTextFile(join(root, "main.ts"), "export {}\n");
    await Deno.writeTextFile(join(root, "src/ok.ts"), "export {}\n");
    await Deno.writeTextFile(join(root, "src/notes.md"), "ignore me\n");
    await Deno.writeTextFile(
      join(root, "src/bad.ts"),
      "const root = '/opt/turbopanel/platform';\n",
    );
    await Deno.writeTextFile(
      join(root, "src/coverage/hidden.ts"),
      "const root = '/opt/turbopanel/platform';\n",
    );
    await Deno.writeTextFile(
      join(root, "orchestration/roles/geerlingguy.docker/tasks/main.yml"),
      "path: /opt/turbopanel/platform\n",
    );

    const failures = await runProductionLayoutCheck(root);
    assertEquals(
      failures.some((line) => line.includes("src/bad.ts")),
      true,
    );
    assertEquals(
      failures.some((line) => line.includes("src/coverage/hidden.ts")),
      false,
    );
    assertEquals(
      failures.some((line) => line.includes("geerlingguy.docker")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("runProductionLayoutCheck on the real checkout stays clean", async () => {
  const failures = await runProductionLayoutCheck();
  assertEquals(failures, []);
});
