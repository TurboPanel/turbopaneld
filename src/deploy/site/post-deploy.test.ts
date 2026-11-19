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
  boundedOutputTail,
  describePostDeployFailure,
  lastRunOutput,
  POST_DEPLOY_BEGIN_MARKER,
  POST_DEPLOY_FAILED_AFTER_SWITCH,
  POST_DEPLOY_OUTPUT_MAX_LINES,
  POST_DEPLOY_STEP_MARKER,
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
    runToken: TOKEN,
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
const TOKEN = "tok-4f9a";
const marker = (n: number) => `${POST_DEPLOY_STEP_MARKER} ${TOKEN} ${n}`;
const step = (n: number) => own(marker(n));
const MARKERS = { unit: UNIT, runToken: TOKEN };

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
        `ExecStart="/bin/echo" "${marker(1)}"`,
        'ExecStart="/usr/local/bin/php" "artisan" "migrate" "--force"',
        `ExecStart="/bin/echo" "${marker(2)}"`,
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
    failure: {},
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
    failure: {},
  });
  const none = { lines: [], finished: false, failure: {} };
  assertEquals(lastRunOutput(running, "rel2"), none);
  assertEquals(lastRunOutput("", "rel1"), none);
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
      redact: (text) => text,
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(ok, { ok: true });
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
      redact: (text) => text,
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
      redact: (text) => text,
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(ok.ok, false);
    assertEquals(printed.slice(0, 1), [
      "Finished TurboPanel post-deploy commands (web).",
    ]);
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
      redact: (text) => text,
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
      redact: (text) => text,
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
          redact: (text) => text,
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

test("the failing command and its status come from the step markers and systemd's own line", () => {
  const journal = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    step(1),
    own("Migrated"),
    step(2),
    // A line the journal wrote without a pid still counts as output.
    stamp(`${UNIT}: SQLSTATE[HY000]: connection refused`),
    systemd(
      `${UNIT}.service: Main process exited, code=exited, status=1/FAILURE`,
    ),
    systemd(`${UNIT}.service: Failed with result 'exit-code'.`),
  ].join("\n");
  const read = lastRunOutput(journal, "rel1", [[
    "/usr/local/bin/php",
    "artisan",
    "migrate",
  ], ["/usr/local/bin/php", "artisan", "optimize"]], MARKERS);
  assertEquals(read.lines, ["Migrated", "SQLSTATE[HY000]: connection refused"]);
  assertEquals(read.finished, true);
  assertEquals(read.failure, {
    command: "/usr/local/bin/php",
    status: "exit status 1",
  });
  assertEquals(
    describePostDeployFailure(read.failure),
    "/usr/local/bin/php exited with exit status 1",
  );
});

test("a failed run prints the bounded output tail and a line naming the failure, never an argument", async () => {
  const many = Array.from({ length: 80 }, (_, i) => own(`row ${i}`));
  const host = await makeSystemdHost(journalAnswer([
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    step(1),
    ...many,
    systemd(`${UNIT}.service: Main process exited, code=exited, status=3/n/a`),
    systemd(`${UNIT}.service: Failed with result 'exit-code'.`),
  ], false));
  try {
    const printed: Array<[string, string]> = [];
    const result = await runPostDeployUnit({
      run: host.run,
      onLine: (stream, line) => printed.push([stream, line]),
      redact: (text) => text,
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(result, {
      ok: false,
      failure: { command: "/usr/local/bin/php", status: "exit status 3" },
    });
    const lines = printed.map(([, line]) => line);
    assertEquals(lines[0], "... 20 earlier output lines omitted ...");
    assertEquals(lines.length, POST_DEPLOY_OUTPUT_MAX_LINES + 2);
    assertEquals(lines.at(-2), "row 79");
    assertEquals(
      lines.at(-1),
      "post-deploy failed: /usr/local/bin/php exited with exit status 3",
    );
    assert(printed.every(([stream]) => stream === "stderr"));
    assert(!lines.some((line) => line.includes("migrate")));
  } finally {
    await host.cleanup();
  }
});

test("a failed run with no output says so, and a timeout is named", async () => {
  const host = await makeSystemdHost(journalAnswer([
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    step(1),
    step(2),
    systemd(`${UNIT}.service: Failed with result 'timeout'.`),
  ], false));
  try {
    const printed: string[] = [];
    const result = await runPostDeployUnit({
      run: host.run,
      onLine: (_stream, line) => printed.push(line),
      redact: (text) => text,
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(result.ok, false);
    assertEquals(printed, [
      "no output was captured from the failed command",
      "post-deploy failed: /usr/local/bin/php timed out",
    ]);
  } finally {
    await host.cleanup();
  }
});

test("the two failures say what happened to the release, and the later one carries the code, both release ids and the failure", () => {
  const failure = { command: "/usr/local/bin/php", status: "exit status 1" };
  assertEquals(
    postDeployBeforeTrafficFailure("web", failure).message,
    "Post-deploy commands for site web failed, so the new release was not switched in. /usr/local/bin/php exited with exit status 1. The release that was serving keeps serving.",
  );
  const late = new PostDeployFailedAfterSwitchError({
    composeServiceName: "web",
    failedReleaseId: "rel2",
    previousReleaseId: "rel1",
    failure,
  });
  assertEquals(
    late.message,
    "post_deploy_failed_after_switch: Post-deploy commands for site web failed after the new release rel2 went live. /usr/local/bin/php exited with exit status 1. Roll back to the previous release rel1 from the deploy page if the site is not working.",
  );
  assertEquals(late.code, POST_DEPLOY_FAILED_AFTER_SWITCH);
  assertEquals(late.details, {
    composeServiceName: "web",
    failedReleaseId: "rel2",
    previousReleaseId: "rel1",
    failure,
  });
  // With nothing known about the failure the sentence still starts with the code.
  assertStringIncludes(
    new PostDeployFailedAfterSwitchError({
      composeServiceName: "web",
      failedReleaseId: "rel2",
      previousReleaseId: null,
    }).message,
    "post_deploy_failed_after_switch: Post-deploy commands for site web failed after the new release rel2 went live. Roll back to the previous release from",
  );
});

test("a timeout is named as one even though systemd logs the kill first, and a signal is named", () => {
  const timeout = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    step(1),
    step(2),
    systemd(`${UNIT}.service: Start operation timed out. Terminating.`),
    systemd(
      `${UNIT}.service: Main process exited, code=killed, status=15/TERM`,
    ),
    systemd(`${UNIT}.service: Failed with result 'timeout'.`),
    systemd("Failed to start TurboPanel post-deploy commands (web)."),
  ].join("\n");
  assertEquals(
    lastRunOutput(timeout, "rel1", [["/a"], ["/usr/local/bin/php"]], MARKERS)
      .failure,
    {
      command: "/usr/local/bin/php",
      status: "timed out",
    },
  );
  const crash = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    step(1),
    systemd(
      `${UNIT}.service: Main process exited, code=dumped, status=11/SEGV`,
    ),
    systemd(`${UNIT}.service: Failed with result 'core-dump'.`),
  ].join("\n");
  assertEquals(lastRunOutput(crash, "rel1", [], MARKERS).failure, {
    status: "signal SEGV",
  });
});

test("only the unit's own lines with the run's token and the next number move the step marker", () => {
  const commands = [["/bin/one"], ["/bin/two"], ["/bin/three"]];
  const journal = [
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    step(1),
    step(2),
    // Output that imitates a marker: no token, a wrong token, a skipped number,
    // a repeat, a line from another program.
    own(`${POST_DEPLOY_STEP_MARKER} 3`),
    own(`${POST_DEPLOY_STEP_MARKER} wrong-token 3`),
    own(marker(4)),
    step(2),
    stamp(`echo[40]: ${marker(3)}`),
    systemd(
      `${UNIT}.service: Main process exited, code=exited, status=1/FAILURE`,
    ),
  ].join("\n");
  const read = lastRunOutput(journal, "rel1", commands, MARKERS);
  assertEquals(read.failure.command, "/bin/two");
  // Accepted markers are not output; the imitations are.
  assertEquals(read.lines, [
    `${POST_DEPLOY_STEP_MARKER} 3`,
    `${POST_DEPLOY_STEP_MARKER} wrong-token 3`,
    marker(4),
    marker(2),
    marker(3),
  ]);
});

test("accepted step markers never reach the transcript", async () => {
  const host = await makeSystemdHost(journalAnswer([
    own(`${POST_DEPLOY_BEGIN_MARKER} rel1`),
    step(1),
    own("Migrated"),
    step(2),
    own("Optimized"),
    systemd("Finished TurboPanel post-deploy commands (web)."),
  ]));
  try {
    const printed: string[] = [];
    const ok = await runPostDeployUnit({
      run: host.run,
      onLine: (_stream, line) => printed.push(line),
      redact: (text) => text,
      systemdUnitDir: host.unitDir,
      sleep: () => Promise.resolve(),
    }, opts(host));
    assertEquals(ok, { ok: true });
    assertEquals(printed, ["Migrated", "Optimized"]);
  } finally {
    await host.cleanup();
  }
});

test("a failing run's tail is redacted before a long line is cut", () => {
  const secret = "s3cr3t-".repeat(20);
  const long = `${"x".repeat(450)}${secret}`;
  const tail = boundedOutputTail(
    [long],
    (text) => text.replaceAll(secret, "[redacted]"),
  );
  assertEquals(tail, [`${"x".repeat(450)}[redacted]`]);
  assertEquals(tail.join("").includes("s3cr3t"), false);
});
