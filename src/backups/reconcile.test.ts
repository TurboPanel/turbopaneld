import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import type { BackupPolicyWireEntry } from "../contracts/commands-contracts.ts";
import type { RunFn, RunResult } from "../deploy/ensure-principal.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { backupPoliciesPath, readBackupPoliciesFile } from "./policies-file.ts";
import { handleBackupsReconcile } from "./reconcile.ts";
import { backupUnitName } from "./units.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const A = "0192f1de-7c3b-7e4a-9f10-00000000000a";
const B = "0192f1de-7c3b-7e4a-9f10-00000000000b";
const C = "0192f1de-7c3b-7e4a-9f10-00000000000c";
const NEXT_UNIX = 1_790_000_000;

function policy(
  policyId: string,
  overrides: Partial<BackupPolicyWireEntry> = {},
): BackupPolicyWireEntry {
  return {
    policyId,
    targetKind: "managed",
    managedId: "0192f1de-7c3b-7e4a-9f10-000000000001",
    engine: "postgres",
    artifactExtension: "dump",
    onCalendar: "*-*-* 03:00:00",
    retentionKeep: 7,
    enabled: true,
    ...overrides,
  };
}

type Host = {
  layout: LayoutPaths;
  unitDir: string;
  run: RunFn;
  calls: string[];
  /** `systemctl show` answer; `null` makes it fail. */
  showOutput: string | null;
  /** Whether the policies file existed when each unit install ran. */
  policiesFileAtInstall: boolean[];
  cleanup: () => Promise<void>;
};

function ok(stdout = ""): RunResult {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): RunResult {
  return { success: false, stdout: "", stderr };
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      Deno.readTextFile(a),
      Deno.readTextFile(b),
    ]);
    return left === right;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<RunResult> {
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
    return ok(names.toSorted((a, b) => a.localeCompare(b)).join("\n"));
  } catch {
    return fail("No such file or directory");
  }
}

/** Host-free `sudo` seam: install/cmp/ls/rm are real, systemctl is recorded. */
async function makeHost(): Promise<Host> {
  const root = await Deno.makeTempDir({ prefix: "tp-backup-reconcile-" });
  const unitDir = join(root, "etc/systemd/system");
  await Deno.mkdir(unitDir, { recursive: true });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_LIB_DIR: `${root}/lib`,
      TURBOPANEL_LOG_DIR: `${root}/log`,
      TURBOPANEL_RUN_DIR: `${root}/run`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  const host: Host = {
    layout,
    unitDir,
    calls: [],
    showOutput: `@${NEXT_UNIX}`,
    policiesFileAtInstall: [],
    run: () => Promise.resolve(ok()),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
  host.run = async (command, args) => {
    host.calls.push([command, ...args].join(" "));
    if (command === "systemctl") {
      return host.showOutput === null
        ? fail("unit not loaded")
        : ok(host.showOutput);
    }
    const [tool, ...tail] = args[0] === "-n" ? args.slice(1) : args;
    const last = tail.at(-1) as string;
    switch (tool) {
      case "cmp":
        return (await sameBytes(tail.at(-2) as string, last))
          ? ok()
          : fail("differ");
      case "install":
        host.policiesFileAtInstall.push(
          await exists(backupPoliciesPath(layout)),
        );
        await Deno.mkdir(dirname(last), { recursive: true });
        await Deno.copyFile(tail.at(-2) as string, last);
        return ok();
      case "ls":
        return await listDir(last);
      case "rm":
        await Deno.remove(last).catch(() => {});
        return ok();
      default:
        return ok();
    }
  };
  return host;
}

function reconcile(host: Host, policies: BackupPolicyWireEntry[]) {
  return handleBackupsReconcile({ policies }, new Date().toISOString(), {
    resolveLayout: () => host.layout,
    run: host.run,
    systemdUnitDir: host.unitDir,
  });
}

function sudoSystemctl(host: Host): string[] {
  return host.calls
    .filter((call) => call.startsWith("sudo") && call.includes(" systemctl "))
    .map((call) =>
      call.slice(call.indexOf("systemctl ") + "systemctl ".length)
    );
}

async function withHost(fn: (host: Host) => Promise<void>): Promise<void> {
  const host = await makeHost();
  try {
    await fn(host);
  } finally {
    await host.cleanup();
  }
}

test("enabled policies get a timer and a service; disabled ones get none", async () => {
  await withHost(async (host) => {
    const result = await reconcile(host, [
      policy(A),
      policy(B, { onCalendar: "hourly" }),
      policy(C, { enabled: false }),
    ]);

    assertEquals(result.policiesApplied, 2);
    assertEquals(result.unitsChanged, [A, B]);
    assertEquals(result.unitsRemoved, []);
    assertEquals(result.warnings, []);
    const next = new Date(NEXT_UNIX * 1000).toISOString();
    assertEquals(result.nextRuns, [
      { policyId: A, nextRunAt: next },
      { policyId: B, nextRunAt: next },
    ]);
    for (const id of [A, B]) {
      assert(await exists(join(host.unitDir, `${backupUnitName(id)}.timer`)));
      assert(await exists(join(host.unitDir, `${backupUnitName(id)}.service`)));
    }
    assertEquals(
      await exists(join(host.unitDir, `${backupUnitName(C)}.timer`)),
      false,
    );
    // One daemon-reload before either timer is enabled.
    assertEquals(sudoSystemctl(host), [
      "daemon-reload",
      `enable --now ${backupUnitName(A)}.timer`,
      `enable --now ${backupUnitName(B)}.timer`,
    ]);
    // The runner reads its policy from this file; every entry is kept, the
    // disabled one included, so it can refuse to run it by name.
    assertEquals(
      (await readBackupPoliciesFile(host.layout)).map((p) => p.policyId),
      [A, B, C],
    );
  });
});

test("the policies file is written before any unit is installed", async () => {
  await withHost(async (host) => {
    await reconcile(host, [policy(A)]);
    assertEquals(host.policiesFileAtInstall.length > 0, true);
    assertEquals(host.policiesFileAtInstall.every(Boolean), true);
  });
});

test("an unchanged set touches nothing", async () => {
  await withHost(async (host) => {
    await reconcile(host, [policy(A)]);
    const before = await Deno.readTextFile(backupPoliciesPath(host.layout));
    host.calls.length = 0;

    const result = await reconcile(host, [policy(A)]);
    assertEquals(result.unitsChanged, []);
    assertEquals(result.unitsRemoved, []);
    // No timer re-enabled (that would reset its next firing), no reload, and
    // the file (with its appliedAt) is left as it was.
    assertEquals(sudoSystemctl(host), []);
    assertEquals(
      host.calls.some((call) => call.includes(" install ")),
      false,
    );
    assertEquals(
      await Deno.readTextFile(backupPoliciesPath(host.layout)),
      before,
    );
  });
});

test("a changed schedule rewrites and re-enables only that policy's timer", async () => {
  await withHost(async (host) => {
    await reconcile(host, [policy(A), policy(B)]);
    host.calls.length = 0;
    const result = await reconcile(host, [
      policy(A),
      policy(B, { onCalendar: "*-*-* 04:30:00" }),
    ]);
    assertEquals(result.unitsChanged, [B]);
    assertEquals(sudoSystemctl(host), [
      "daemon-reload",
      `enable --now ${backupUnitName(B)}.timer`,
    ]);
  });
});

test("a disabled or dropped policy has its timer stopped and its units deleted", async () => {
  await withHost(async (host) => {
    await reconcile(host, [policy(A), policy(B), policy(C)]);
    host.calls.length = 0;
    const result = await reconcile(host, [
      policy(A),
      policy(B, { enabled: false }),
    ]);
    assertEquals(result.unitsRemoved.toSorted(), [B, C].toSorted());
    for (const id of [B, C]) {
      assertEquals(
        await exists(join(host.unitDir, `${backupUnitName(id)}.timer`)),
        false,
      );
      assertEquals(
        await exists(join(host.unitDir, `${backupUnitName(id)}.service`)),
        false,
      );
      assert(
        sudoSystemctl(host).includes(
          `disable --now ${backupUnitName(id)}.timer`,
        ),
      );
    }
    assertEquals(result.nextRuns.map((run) => run.policyId), [A]);
  });
});

test("an empty set removes every backup timer and nothing else", async () => {
  await withHost(async (host) => {
    await reconcile(host, [policy(A)]);
    const cron = "turbopanel-cron-env1-web-nightly";
    await Deno.writeTextFile(join(host.unitDir, `${cron}.timer`), "keep\n");
    const result = await reconcile(host, []);
    assertEquals(result.unitsRemoved, [A]);
    assertEquals(result.policiesApplied, 0);
    assertEquals(
      await Deno.readTextFile(join(host.unitDir, `${cron}.timer`)),
      "keep\n",
    );
  });
});

test("an unscheduled timer has no next run; a failed query is a warning", async () => {
  await withHost(async (host) => {
    host.showOutput = "";
    let result = await reconcile(host, [policy(A)]);
    assertEquals(result.nextRuns, [{ policyId: A }]);
    assertEquals(result.warnings, []);

    host.showOutput = null;
    result = await reconcile(host, [policy(A)]);
    assertEquals(result.nextRuns, [{ policyId: A }]);
    assertEquals(result.warnings.length, 1);
    // The next-run read never goes through sudo.
    assert(
      host.calls.every((call) =>
        !call.startsWith("sudo") || !call.includes(" show ")
      ),
    );
  });
});

test("an invalid set is refused before anything is written", async () => {
  await withHost(async (host) => {
    await assertRejects(() => reconcile(host, [policy(A.toUpperCase())]));
    await assertRejects(() => reconcile(host, [policy(A), policy(A)]));
    assertEquals(await exists(backupPoliciesPath(host.layout)), false);
    assertEquals(host.calls, []);
  });
});

test("a malformed policies file on disk is replaced, not trusted", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(dirname(backupPoliciesPath(host.layout)), {
      recursive: true,
    });
    await Deno.writeTextFile(backupPoliciesPath(host.layout), "{broken");
    await reconcile(host, [policy(A)]);
    assertEquals(
      (await readBackupPoliciesFile(host.layout)).map((p) => p.policyId),
      [A],
    );
  });
});

test("a copy policy makes sure the helper image is present; a pull failure is a warning", async () => {
  await withHost(async (host) => {
    const copy = policy(B, {
      targetKind: "copy",
      managedId: undefined,
      engine: undefined,
      artifactExtension: undefined,
      copyId: C,
      copyProvider: "docker",
      volumeName: "shop_uploads",
    });
    let pulls = 0;
    const run = (answer: string | undefined) =>
      handleBackupsReconcile({ policies: [policy(A), copy] }, "", {
        resolveLayout: () => host.layout,
        run: host.run,
        systemdUnitDir: host.unitDir,
        ensureHelperImage: () => {
          pulls++;
          return Promise.resolve(answer);
        },
      });

    let result = await run(undefined);
    assertEquals(pulls, 1);
    assertEquals(result.warnings, []);
    assertEquals(result.nextRuns.map((next) => next.policyId), [A, B]);

    result = await run("could not pull the backup helper image: offline");
    assertEquals(pulls, 2);
    assertEquals(result.warnings, [
      "could not pull the backup helper image: offline",
    ]);
  });
});

test("a set with no enabled copy policy never touches the helper image", async () => {
  await withHost(async (host) => {
    let pulls = 0;
    await handleBackupsReconcile(
      {
        policies: [
          policy(A),
          policy(B, {
            targetKind: "copy",
            managedId: undefined,
            engine: undefined,
            artifactExtension: undefined,
            copyId: C,
            copyProvider: "docker",
            volumeName: "shop_uploads",
            enabled: false,
          }),
        ],
      },
      "",
      {
        resolveLayout: () => host.layout,
        run: host.run,
        systemdUnitDir: host.unitDir,
        ensureHelperImage: () => {
          pulls++;
          return Promise.resolve(undefined);
        },
      },
    );
    assertEquals(pulls, 0);
  });
});

function volumePolicy(
  policyId: string,
  overrides: Partial<BackupPolicyWireEntry> = {},
): BackupPolicyWireEntry {
  return policy(policyId, {
    targetKind: "copy",
    managedId: undefined,
    engine: undefined,
    artifactExtension: undefined,
    copyId: C,
    copyProvider: "docker",
    volumeName: "shop_uploads",
    ...overrides,
  });
}

const noPull = () => Promise.resolve(undefined);

function reconcileWithImage(host: Host, policies: BackupPolicyWireEntry[]) {
  return handleBackupsReconcile({ policies }, "", {
    resolveLayout: () => host.layout,
    run: host.run,
    systemdUnitDir: host.unitDir,
    ensureHelperImage: noPull,
  });
}

test("a managed database hourly and a volume daily keep independent timers on one host", async () => {
  await withHost(async (host) => {
    await reconcileWithImage(host, [
      policy(A, { onCalendar: "hourly" }),
      volumePolicy(B, { onCalendar: "*-*-* 02:00:00" }),
    ]);

    const read = (id: string, ext: "timer" | "service") =>
      Deno.readTextFile(join(host.unitDir, `${backupUnitName(id)}.${ext}`));
    const [timerA, timerB, serviceA, serviceB] = await Promise.all([
      read(A, "timer"),
      read(B, "timer"),
      read(A, "service"),
      read(B, "service"),
    ]);

    // Each timer carries only its own calendar and starts only its own service.
    assert(timerA.includes("OnCalendar=hourly\n"));
    assert(timerB.includes("OnCalendar=*-*-* 02:00:00\n"));
    assert(timerA.includes(`Unit=${backupUnitName(A)}.service\n`));
    assert(timerB.includes(`Unit=${backupUnitName(B)}.service\n`));
    assertEquals(timerA.includes(B), false);
    assertEquals(timerB.includes(A), false);
    // Each service runs only its own policy, so two never share a process.
    assert(serviceA.includes(`/tp-backup-run ${A}\n`));
    assert(serviceB.includes(`/tp-backup-run ${B}\n`));
    assertEquals(serviceA.includes(B), false);
    assertEquals(serviceB.includes(A), false);

    // Re-timing one leaves the other's files and next firing alone.
    host.calls.length = 0;
    const result = await reconcileWithImage(host, [
      policy(A, { onCalendar: "hourly" }),
      volumePolicy(B, { onCalendar: "*-*-* 05:00:00" }),
    ]);
    assertEquals(result.unitsChanged, [B]);
    assertEquals(await read(A, "timer"), timerA);
    assertEquals(
      sudoSystemctl(host).some((call) => call.includes(backupUnitName(A))),
      false,
    );
  });
});

test("deleting a policy removes its units and its policies-file entry and leaves the others", async () => {
  await withHost(async (host) => {
    await reconcileWithImage(host, [policy(A), volumePolicy(B)]);
    const keptTimer = await Deno.readTextFile(
      join(host.unitDir, `${backupUnitName(A)}.timer`),
    );
    host.calls.length = 0;

    const result = await reconcileWithImage(host, [policy(A)]);

    assertEquals(result.unitsRemoved, [B]);
    assert(
      sudoSystemctl(host).includes(`disable --now ${backupUnitName(B)}.timer`),
    );
    const left: string[] = [];
    for await (const entry of Deno.readDir(host.unitDir)) left.push(entry.name);
    assertEquals(left.filter((name) => name.includes(B)), []);
    assertEquals(
      (await readBackupPoliciesFile(host.layout)).map((p) => p.policyId),
      [A],
    );
    assertEquals(
      await Deno.readTextFile(join(host.unitDir, `${backupUnitName(A)}.timer`)),
      keptTimer,
    );
  });
});
