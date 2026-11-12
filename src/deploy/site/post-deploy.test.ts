import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  hostFail,
  hostOk,
  makeSystemdHost,
  type SystemdHost,
} from "../../testing/systemd-host.ts";
import {
  lastRunOutput,
  POST_DEPLOY_BEGIN_MARKER,
  POST_DEPLOY_FAILED_AFTER_SWITCH,
  postDeployBeforeTrafficFailure,
  PostDeployFailedAfterSwitchError,
  postDeployUnitContent,
  type PostDeployUnitOpts,
  removePostDeployUnits,
  runPostDeployUnit,
} from "./post-deploy.ts";
import { SITE_PHP_IP_ALLOW, SITE_PHP_IP_DENY } from "./php-runtime.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const UNIT = "turbopanel-deploycmd-env1-web";

function opts(host: SystemdHost, extra: Partial<PostDeployUnitOpts> = {}) {
  return {
    layout: host.layout,
    username: "alice",
    workingDirectory: "/srv/users/alice/sites/svc1/releases/rel1",
    environmentFile: "/etc/turbopanel/site-env/alice/web-0123456789ab.env",
    phpSeries: "8.4",
    siteWritableDirs: ["/srv/users/alice/sites/svc1/shared"],
    environmentId: "env1",
    composeServiceName: "web",
    releaseId: "rel1",
    postDeploy: {
      commands: [
        ["/usr/local/bin/php", "artisan", "migrate", "--force"],
        ["/usr/local/bin/php", "artisan", "optimize"],
      ],
    },
    ...extra,
  } satisfies PostDeployUnitOpts;
}

const stamp = (rest: string) => `2026-11-10T12:00:00+0000 host ${rest}`;
const own = (message: string) => stamp(`${UNIT}[41]: ${message}`);
const systemd = (message: string) => stamp(`systemd[1]: ${message}`);

test("the command unit is a one-shot that begins with its marker and runs every command", async () => {
  const host = await makeSystemdHost();
  try {
    const text = postDeployUnitContent(opts(host));
    const lines = text.split("\n");
    assertStringIncludes(text, "Type=oneshot");
    assertEquals(
      lines.filter((line) => line.startsWith("ExecStart=")),
      [
        `ExecStart="/bin/echo" "${POST_DEPLOY_BEGIN_MARKER}" "rel1"`,
        'ExecStart="/usr/local/bin/php" "artisan" "migrate" "--force"',
        'ExecStart="/usr/local/bin/php" "artisan" "optimize"',
      ],
    );
    assertStringIncludes(text, "TimeoutStartSec=900");
    assertStringIncludes(
      text,
      "WorkingDirectory=/srv/users/alice/sites/svc1/releases/rel1",
    );
    assertStringIncludes(text, "Environment=TURBOPANEL_PHP=8.4");
    assertStringIncludes(
      text,
      "EnvironmentFile=/etc/turbopanel/site-env/alice/web-0123456789ab.env",
    );
    assertStringIncludes(text, `SyslogIdentifier=${UNIT}`);
    // The sandbox, the address filter from the PHP unit's constants, the guard.
    for (
      const line of [
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "CapabilityBoundingSet=",
        "PrivateDevices=yes",
        `IPAddressDeny=${SITE_PHP_IP_DENY}`,
        `IPAddressAllow=${SITE_PHP_IP_ALLOW}`,
        `ExecStartPre=+${host.layout.libDir}/tp-php-loopback sync`,
      ]
    ) assert(lines.includes(line), line);
    // Only when it is started by the daemon: nothing installs it.
    assert(!text.includes("[Install]"));
    assert(!text.includes("WantedBy"));
  } finally {
    await host.cleanup();
  }
});

test("a timeout replaces the default and a Laravel release adds its cache folder as optional", async () => {
  const host = await makeSystemdHost();
  try {
    const text = postDeployUnitContent(opts(host, {
      postDeploy: {
        commands: [["/bin/true"]],
        timeoutSeconds: 120,
      },
      extraWritablePaths: [
        "/srv/users/alice/sites/svc1/releases/rel1/bootstrap/cache",
      ],
    }));
    assertStringIncludes(text, "TimeoutStartSec=120");
    assertStringIncludes(
      text,
      "ReadWritePaths=-/srv/users/alice/sites/svc1/releases/rel1/bootstrap/cache",
    );
    const plain = postDeployUnitContent(opts(host));
    assert(!plain.includes("bootstrap/cache"));
  } finally {
    await host.cleanup();
  }
});

test("a command's arguments are quoted so systemd expands nothing in them", async () => {
  const host = await makeSystemdHost();
  try {
    const text = postDeployUnitContent(opts(host, {
      postDeploy: {
        commands: [["/bin/echo", 'a "b" $HOME %h \\']],
      },
    }));
    assertStringIncludes(
      text,
      'ExecStart="/bin/echo" "a \\"b\\" $$HOME %%h \\\\"',
    );
  } finally {
    await host.cleanup();
  }
});

test("only the lines after the last begin marker are the run's output", () => {
  const journal = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel0`),
    own("old run output"),
    systemd(`Finished TurboPanel post-deploy commands (web).`),
    systemd("Starting TurboPanel post-deploy commands (web)..."),
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    own("Migrating: create_jobs"),
    own("  Migrated"),
    systemd("Finished TurboPanel post-deploy commands (web)."),
  ].join("\n");
  assertEquals(lastRunOutput(journal, "rel1"), {
    lines: ["Migrating: create_jobs", "  Migrated"],
    finished: true,
  });
});

test("a run whose closing line has not arrived yet is not finished, and a missing marker reads nothing", () => {
  const running = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    own("working"),
  ].join("\n");
  assertEquals(lastRunOutput(running, "rel1"), {
    lines: ["working"],
    finished: false,
  });
  assertEquals(lastRunOutput(running, "rel2"), { lines: [], finished: false });
  assertEquals(lastRunOutput("", "rel1"), { lines: [], finished: false });
});

test("a command that prints a fake closing line does not end the wait early, and a systemd failure line does", () => {
  const fake = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    own("Finished everything"),
  ].join("\n");
  assertEquals(lastRunOutput(fake, "rel1").finished, false);
  const failed = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    systemd(
      "TurboPanel post-deploy commands (web).service: Failed with result",
    ),
    systemd("Failed to start TurboPanel post-deploy commands (web)."),
  ].join("\n");
  assertEquals(lastRunOutput(failed, "rel1").finished, true);
});

function journalAnswer(lines: string[], startOk = true) {
  return (call: { tool: string; args: string[] }) => {
    if (call.tool === "journalctl") return hostOk(lines.join("\n"));
    if (call.tool === "systemctl" && call.args[0] === "start") {
      return startOk ? hostOk() : hostFail("Job failed");
    }
    return undefined;
  };
}

test("a run that succeeds installs the unit, starts it and prints its output", async () => {
  const host = await makeSystemdHost(journalAnswer([
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    own("Nothing to migrate."),
    systemd("Finished TurboPanel post-deploy commands (web)."),
  ]));
  try {
    const printed: string[] = [];
    const ok = await runPostDeployUnit({
      run: host.run,
      onLine: (_stream, line) => printed.push(line),
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(ok, true);
    assertEquals(printed, ["Nothing to migrate."]);
    assertEquals(host.systemctl(), [
      ["daemon-reload"],
      ["reset-failed", `${UNIT}.service`],
      ["start", `${UNIT}.service`],
    ]);
    assert(host.calls.some((call) => call.tool === "php-loopback-sync"));
    await Deno.stat(join(host.unitDir, `${UNIT}.service`));
    // A second run with the same text reloads nothing.
    host.calls.length = 0;
    await runPostDeployUnit({
      run: host.run,
      onLine: () => undefined,
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(host.systemctl(), [
      ["reset-failed", `${UNIT}.service`],
      ["start", `${UNIT}.service`],
    ]);
  } finally {
    await host.cleanup();
  }
});

test("success is what systemd says about the unit, never what the journal prints", async () => {
  // The commands print a believable closing line, but the unit failed.
  const host = await makeSystemdHost(journalAnswer([
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    own("Finished TurboPanel post-deploy commands (web)."),
    systemd("Failed to start TurboPanel post-deploy commands (web)."),
  ], false));
  try {
    const printed: string[] = [];
    const ok = await runPostDeployUnit({
      run: host.run,
      onLine: (_stream, line) => printed.push(line),
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(ok, false);
    assertEquals(printed, ["Finished TurboPanel post-deploy commands (web)."]);
  } finally {
    await host.cleanup();
  }
});

test("the journal is read again, a bounded number of times, until systemd's closing line is there", async () => {
  let reads = 0;
  const host = await makeSystemdHost((call) => {
    if (call.tool !== "journalctl") return undefined;
    reads++;
    return hostOk(
      [
        own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
        ...(reads >= 3
          ? [
            own("late line"),
            systemd("Finished TurboPanel post-deploy commands."),
          ]
          : []),
      ].join("\n"),
    );
  });
  try {
    const printed: string[] = [];
    const waits: number[] = [];
    await runPostDeployUnit({
      run: host.run,
      onLine: (_stream, line) => printed.push(line),
      systemdUnitDir: host.unitDir,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }, opts(host));
    assertEquals(reads, 3);
    assertEquals(waits, [300, 300]);
    assertEquals(printed, ["late line"]);
  } finally {
    await host.cleanup();
  }
});

test("a journal that never closes is read ten times and the run still ends", async () => {
  let reads = 0;
  const host = await makeSystemdHost((call) => {
    if (call.tool !== "journalctl") return undefined;
    reads++;
    return hostOk(own(`${POST_DEPLOY_BEGIN_MARKER} rel1`));
  });
  try {
    await runPostDeployUnit({
      run: host.run,
      onLine: () => undefined,
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(reads, 10);
  } finally {
    await host.cleanup();
  }
});

test("a reload that fails stops the run before anything starts", async () => {
  const host = await makeSystemdHost((call) =>
    call.tool === "systemctl" && call.args[0] === "daemon-reload"
      ? hostFail("reload refused")
      : undefined
  );
  try {
    await assertRejects(
      () =>
        runPostDeployUnit({
          run: host.run,
          onLine: () => undefined,
          systemdUnitDir: host.unitDir,
        }, opts(host)),
      Error,
      "reload refused",
    );
    assert(!host.systemctl().some((args) => args[0] === "start"));
  } finally {
    await host.cleanup();
  }
});

test("units of sites that no longer have commands are removed, the others kept", async () => {
  const host = await makeSystemdHost();
  try {
    for (
      const name of [
        "turbopanel-deploycmd-env1-web.service",
        "turbopanel-deploycmd-env1-api.service",
        "turbopanel-deploycmd-env2-web.service",
      ]
    ) await Deno.writeTextFile(join(host.unitDir, name), "[Service]\n");
    const removed = await removePostDeployUnits(
      { run: host.run, systemdUnitDir: host.unitDir },
      "env1",
      ["web"],
    );
    assertEquals(removed, 1);
    const left = (await Array.fromAsync(Deno.readDir(host.unitDir)))
      .map((entry) => entry.name).sort();
    assertEquals(left, [
      "turbopanel-deploycmd-env1-web.service",
      "turbopanel-deploycmd-env2-web.service",
    ]);
    assertEquals(host.systemctl(), [["daemon-reload"]]);
    assert(host.calls.some((call) => call.tool === "php-loopback-sync"));
  } finally {
    await host.cleanup();
  }
});

test("the two failures say what happened to the release, and the later one carries both release ids", () => {
  assertEquals(
    postDeployBeforeTrafficFailure("web").message,
    "Post-deploy commands for site web failed, so the new release was not switched in. The release that was serving keeps serving.",
  );
  const late = new PostDeployFailedAfterSwitchError({
    composeServiceName: "web",
    failedReleaseId: "rel2",
    previousReleaseId: "rel1",
  });
  assertEquals(
    late.message,
    "Post-deploy commands for site web failed after the new release went live. Roll back to the previous release from the deploy page if the site is not working.",
  );
  assertEquals(late.code, POST_DEPLOY_FAILED_AFTER_SWITCH);
  assertEquals(late.details, {
    composeServiceName: "web",
    failedReleaseId: "rel2",
    previousReleaseId: "rel1",
  });
});
