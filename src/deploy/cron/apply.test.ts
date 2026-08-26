import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveLayout } from "../../paths/layout.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn, RunResult } from "../ensure-principal.ts";
import { applyCronJobs, type CronApplySpec, removeCronJobs } from "./apply.ts";
import { cronServiceContent, cronTimerContent, cronUnitName } from "./unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const USERNAME = "appuser";
const ENV_ID = "envcron";

const job = {
  name: "wp-cron",
  schedule: "*-*-* *:0/5:00",
  command: ["/usr/local/bin/php", "wp-cron.php"],
};

function specFor(
  jobs: readonly (typeof job)[] = [job],
  composeServiceName = "blog",
): CronApplySpec {
  return {
    composeServiceName,
    username: USERNAME,
    workingDirectory: `/srv/users/${USERNAME}/sites/svc-1/webroot/public`,
    jobs,
  };
}

type Host = {
  layout: LayoutPaths;
  unitDir: string;
  run: RunFn;
  calls: Array<{ command: string; args: string[] }>;
  cleanup: () => Promise<void>;
};

function ok(stdout = ""): RunResult {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): RunResult {
  return { success: false, stdout: "", stderr };
}

async function filesMatch(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      Deno.readFile(a),
      Deno.readFile(b),
    ]);
    if (left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
  } catch {
    return false;
  }
}

/** Host-free `sudo` seam: install/cmp/ls/rm are real, systemctl is recorded. */
async function makeHost(): Promise<Host> {
  const root = await Deno.makeTempDir({ prefix: "tp-cron-" });
  const unitDir = join(root, "etc/systemd/system");
  await Deno.mkdir(unitDir, { recursive: true });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_LOG_DIR: `${root}/log`,
      TURBOPANEL_RUN_DIR: `${root}/run`,
      TURBOPANEL_RUNTIMES_DIR: `${root}/runtimes`,
      TURBOPANEL_PRINCIPAL_HOME_ROOT: `${root}/srv/users`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );

  const host: Host = {
    layout,
    unitDir,
    calls: [],
    run: () => Promise.resolve(ok()),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };

  host.run = async (command, args) => {
    host.calls.push({ command, args: [...args] });
    if (command !== "sudo") return ok();
    const rest = args[0] === "-n" ? args.slice(1) : args;
    const [tool, ...tail] = rest;

    if (tool === "cmp") {
      const right = tail.at(-1) as string;
      const left = tail.at(-2) as string;
      return (await filesMatch(left, right)) ? ok() : fail("files differ");
    }
    if (tool === "install") {
      const dest = tail.at(-1) as string;
      const src = tail.at(-2) as string;
      await Deno.mkdir(dirname(dest), { recursive: true });
      await Deno.copyFile(src, dest);
      return ok();
    }
    if (tool === "ls") {
      try {
        const names: string[] = [];
        for await (const entry of Deno.readDir(tail.at(-1) as string)) {
          names.push(entry.name);
        }
        return ok(names.sort((a, b) => a.localeCompare(b)).join("\n"));
      } catch {
        return fail("No such file or directory");
      }
    }
    if (tool === "rm") {
      await Deno.remove(tail.at(-1) as string).catch(() => {});
      return ok();
    }
    return ok();
  };
  return host;
}

function systemctlCalls(host: Host): string[][] {
  return host.calls
    .filter((call) => call.args.includes("systemctl"))
    .map((call) => call.args.slice(call.args.indexOf("systemctl") + 1));
}

function apply(host: Host, specs: readonly CronApplySpec[]) {
  return applyCronJobs(host.layout, ENV_ID, specs, {
    run: host.run,
    systemdUnitDir: host.unitDir,
  });
}

const UNIT = cronUnitName({
  environmentId: ENV_ID,
  composeServiceName: "blog",
  jobName: "wp-cron",
});

test("a job installs a timer and a oneshot service, then enables the timer", async () => {
  const host = await makeHost();
  try {
    const result = await apply(host, [specFor()]);
    assertEquals(result.changed, [UNIT]);

    const service = await Deno.readTextFile(
      join(host.unitDir, `${UNIT}.service`),
    );
    const timer = await Deno.readTextFile(join(host.unitDir, `${UNIT}.timer`));

    // The whole point of using a timer: ExecStart reaches execve AFTER systemd
    // drops to User=, so the account's own entitlement groups decide whether it
    // may run the interpreter at all.
    assertStringIncludes(service, `User=${USERNAME}`);
    assertStringIncludes(service, "Type=oneshot");
    assertStringIncludes(service, `Slice=turbopanel-${USERNAME}.slice`);
    assertStringIncludes(
      service,
      'ExecStart="/usr/local/bin/php" "wp-cron.php"',
    );
    assertStringIncludes(timer, "OnCalendar=*-*-* *:0/5:00");
    assertStringIncludes(timer, `Unit=${UNIT}.service`);

    // Enabled once, after a single daemon-reload.
    const calls = systemctlCalls(host);
    assertEquals(calls.filter((c) => c[0] === "daemon-reload").length, 1);
    assertEquals(
      calls.some((c) => c[0] === "enable" && c.at(-1) === `${UNIT}.timer`),
      true,
    );
    assert(
      calls.indexOf(calls.find((c) => c[0] === "daemon-reload") as string[]) <
        calls.indexOf(calls.find((c) => c[0] === "enable") as string[]),
      "daemon-reload must precede enable",
    );
  } finally {
    await host.cleanup();
  }
});

test("the oneshot service has no [Install] section", async () => {
  const host = await makeHost();
  try {
    await apply(host, [specFor()]);
    const service = await Deno.readTextFile(
      join(host.unitDir, `${UNIT}.service`),
    );
    // It is started by its timer and by nothing else; a WantedBy would make it
    // run once at boot as a side effect.
    assertEquals(service.includes("[Install]"), false);
  } finally {
    await host.cleanup();
  }
});

test("an unchanged payload re-enables nothing", async () => {
  const host = await makeHost();
  try {
    await apply(host, [specFor()]);
    host.calls.length = 0;
    const second = await apply(host, [specFor()]);

    assertEquals(second.changed, []);
    // Re-enabling every timer on every deploy would reset each one's next
    // firing — a five-minute job on a busy project would then never fire.
    assertEquals(systemctlCalls(host), []);
  } finally {
    await host.cleanup();
  }
});

test("a changed schedule re-enables just that timer", async () => {
  const host = await makeHost();
  try {
    await apply(host, [specFor()]);
    host.calls.length = 0;
    const result = await apply(host, [
      specFor([{ ...job, schedule: "*-*-* 3:0:00" }]),
    ]);

    assertEquals(result.changed, [UNIT]);
    assertStringIncludes(
      await Deno.readTextFile(join(host.unitDir, `${UNIT}.timer`)),
      "OnCalendar=*-*-* 3:0:00",
    );
    assertEquals(
      systemctlCalls(host).some((c) => c[0] === "enable"),
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("a job removed from compose has its timer disabled and deleted", async () => {
  const host = await makeHost();
  try {
    await apply(host, [
      specFor([job, { ...job, name: "sweep", schedule: "*-*-* 4:0:00" }]),
    ]);
    const sweep = cronUnitName({
      environmentId: ENV_ID,
      composeServiceName: "blog",
      jobName: "sweep",
    });
    await Deno.stat(join(host.unitDir, `${sweep}.timer`));

    host.calls.length = 0;
    const result = await apply(host, [specFor()]);

    assertEquals(result.removed, [sweep]);
    // A job removed from compose that keeps firing is the failure nobody
    // notices until it does something.
    await assertRejects(() => Deno.stat(join(host.unitDir, `${sweep}.timer`)));
    await assertRejects(() =>
      Deno.stat(join(host.unitDir, `${sweep}.service`))
    );
    assertEquals(
      systemctlCalls(host).some((c) =>
        c[0] === "disable" && c.at(-1) === `${sweep}.timer`
      ),
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("an empty payload still sweeps this environment's timers", async () => {
  const host = await makeHost();
  try {
    await apply(host, [specFor()]);
    const result = await apply(host, []);
    assertEquals(result.removed, [UNIT]);
    await assertRejects(() => Deno.stat(join(host.unitDir, `${UNIT}.timer`)));
  } finally {
    await host.cleanup();
  }
});

test("another environment's timers are never touched", async () => {
  const host = await makeHost();
  try {
    // A host serves many environments; a sweep scoped to all of them would
    // retire jobs the payload has no business knowing about.
    const other = `turbopanel-cron-otherenv-blog-nightly`;
    await Deno.writeTextFile(join(host.unitDir, `${other}.timer`), "keep\n");
    await Deno.writeTextFile(join(host.unitDir, `${other}.service`), "keep\n");

    const result = await apply(host, []);
    assertEquals(result.removed, []);
    assertEquals(
      await Deno.readTextFile(join(host.unitDir, `${other}.timer`)),
      "keep\n",
    );
  } finally {
    await host.cleanup();
  }
});

test("removeCronJobs retires the whole environment", async () => {
  const host = await makeHost();
  try {
    await apply(host, [
      specFor([job]),
      specFor([{ ...job, name: "nightly" }], "shop"),
    ]);
    const removed = await removeCronJobs(ENV_ID, {
      run: host.run,
      systemdUnitDir: host.unitDir,
    });
    assertEquals(removed, 2);
    for await (const entry of Deno.readDir(host.unitDir)) {
      assertEquals(entry.name.startsWith("turbopanel-cron-"), false);
    }
  } finally {
    await host.cleanup();
  }
});

test("timers spread their firing and do not catch up after downtime", () => {
  const timer = cronTimerContent({
    layout: {} as LayoutPaths,
    environmentId: ENV_ID,
    composeServiceName: "blog",
    job,
    username: USERNAME,
    workingDirectory: "/srv/users/appuser/sites/svc-1/webroot/public",
  });
  // A hundred sites on one box scheduled every five minutes is the normal case.
  assertStringIncludes(timer, "RandomizedDelaySec=");
  // A host down for a week must not stampede every missed run on boot.
  assertStringIncludes(timer, "Persistent=false");
});

test("arguments are systemd-quoted, never shell-quoted", async () => {
  const host = await makeHost();
  try {
    await apply(host, [
      specFor([{ ...job, command: ["/bin/echo", "a b", 'say "hi"'] }]),
    ]);
    const service = await Deno.readTextFile(
      join(host.unitDir, `${UNIT}.service`),
    );
    // Every argument is quoted unconditionally: one code path, and no judgement
    // call about which characters are "safe" in a unit file.
    assertStringIncludes(service, 'ExecStart="/bin/echo" "a b" "say \\"hi\\""');
  } finally {
    await host.cleanup();
  }
});

test("the service captures output for the log viewer", () => {
  const service = cronServiceContent({
    layout: {} as LayoutPaths,
    environmentId: ENV_ID,
    composeServiceName: "blog",
    job,
    username: USERNAME,
    workingDirectory: "/srv/users/appuser/sites/svc-1/webroot/public",
  });
  // Which is also why the command parser can refuse `>>` outright: there is
  // somewhere better for the output to go.
  assertStringIncludes(service, "StandardOutput=journal");
  assertStringIncludes(service, "StandardError=journal");
  assertStringIncludes(service, `SyslogIdentifier=${UNIT}`);
  // A hung job must not hold its slot forever, or the timer never fires again
  // and it looks like cron stopped working.
  assertStringIncludes(service, "TimeoutStartSec=");
});

test("a failed daemon-reload fails the apply rather than enabling blindly", async () => {
  const host = await makeHost();
  const inner = host.run;
  host.run = (command, args) => {
    if (args.includes("daemon-reload")) {
      return Promise.resolve(fail("daemon-reload refused"));
    }
    return inner(command, args);
  };
  try {
    await assertRejects(
      () => apply(host, [specFor()]),
      Error,
      "daemon-reload refused",
    );
    // Nothing was enabled: systemd never read a set it had not reloaded.
    assertEquals(systemctlCalls(host).some((c) => c[0] === "enable"), false);
  } finally {
    await host.cleanup();
  }
});

test("a failed unit install fails the apply before systemd is touched", async () => {
  const host = await makeHost();
  const inner = host.run;
  host.run = (command, args) => {
    if (args.includes("install") && !args.includes("-d")) {
      return Promise.resolve(fail("install refused"));
    }
    return inner(command, args);
  };
  try {
    await assertRejects(
      () => apply(host, [specFor()]),
      Error,
      "install refused",
    );
    assertEquals(systemctlCalls(host), []);
  } finally {
    await host.cleanup();
  }
});

test("a failed timer enable fails after daemon-reload", async () => {
  const host = await makeHost();
  const inner = host.run;
  host.run = (command, args) => {
    if (args.includes("enable")) {
      return Promise.resolve(fail("enable refused"));
    }
    return inner(command, args);
  };
  try {
    await assertRejects(
      () => apply(host, [specFor()]),
      Error,
      "enable refused",
    );
    assertEquals(
      systemctlCalls(host).some((c) => c[0] === "daemon-reload"),
      true,
    );
  } finally {
    await host.cleanup();
  }
});

test("a failed unit listing is treated as no installed timers", async () => {
  const host = await makeHost();
  try {
    await apply(host, [specFor()]);
    const inner = host.run;
    host.run = (command, args) => {
      if (args.includes("ls")) return Promise.resolve(fail("ls refused"));
      return inner(command, args);
    };
    const result = await apply(host, []);
    assertEquals(result.removed, []);
    await Deno.stat(join(host.unitDir, `${UNIT}.timer`));
  } finally {
    await host.cleanup();
  }
});

test("a failed timer disable still removes the unit files", async () => {
  const host = await makeHost();
  try {
    await apply(host, [specFor()]);
    const inner = host.run;
    host.run = (command, args) => {
      if (args.includes("disable")) {
        return Promise.resolve(fail("disable refused"));
      }
      return inner(command, args);
    };
    const result = await apply(host, []);
    assertEquals(result.removed, [UNIT]);
    await assertRejects(() => Deno.stat(join(host.unitDir, `${UNIT}.timer`)));
  } finally {
    await host.cleanup();
  }
});

test("removeCronJobs warns when daemon-reload fails after teardown", async () => {
  const host = await makeHost();
  try {
    await apply(host, [specFor()]);
    const inner = host.run;
    host.run = (command, args) => {
      if (args.includes("daemon-reload")) {
        return Promise.resolve(fail("reload refused"));
      }
      return inner(command, args);
    };
    assertEquals(
      await removeCronJobs(ENV_ID, {
        run: host.run,
        systemdUnitDir: host.unitDir,
      }),
      1,
    );
    await assertRejects(() => Deno.stat(join(host.unitDir, `${UNIT}.timer`)));
  } finally {
    await host.cleanup();
  }
});
