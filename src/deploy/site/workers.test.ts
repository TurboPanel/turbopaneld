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
  type SystemdHostCall,
} from "../../testing/systemd-host.ts";
import { SITE_PHP_IP_ALLOW, SITE_PHP_IP_DENY } from "./php-runtime.ts";
import {
  applySiteWorkers,
  listInstalledWorkers,
  parseWorkerTemplate,
  removeEnvironmentWorkers,
  restartInstalledWorkers,
  type WorkerApplySpec,
  workerInstanceUnits,
  workerLifecycle,
  workerUnitBase,
  workerUnitContent,
} from "./workers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const BASE = "turbopanel-worker-env1-web-queue";

function spec(
  host: SystemdHost,
  workers: WorkerApplySpec["workers"],
  composeServiceName = "web",
): WorkerApplySpec {
  return {
    layout: host.layout,
    composeServiceName,
    username: "alice",
    workingDirectory: "/srv/users/alice/sites/svc1/current",
    environmentFile: "/etc/turbopanel/site-env/alice/web-0123456789ab.env",
    phpSeries: "8.4",
    siteWritableDirs: ["/srv/users/alice/sites/svc1/shared"],
    workers,
  };
}

const queue = (processes?: number) => ({
  name: "queue",
  command: ["/usr/local/bin/php", "artisan", "queue:work", "--sleep=3"],
  ...(processes === undefined ? {} : { processes }),
});

function io(host: SystemdHost, lines: string[] = []) {
  return {
    run: host.run,
    onLine: (_stream: "stdout" | "stderr", line: string) => lines.push(line),
    sleep: () => Promise.resolve(),
    systemdUnitDir: host.unitDir,
  };
}

const active = (call: SystemdHostCall) =>
  call.tool === "systemctl" && call.args[0] === "is-active"
    ? hostOk("active")
    : undefined;

test("a worker template is a restarting simple service with a graceful stop and the PHP walls", async () => {
  const host = await makeSystemdHost();
  try {
    const text = workerUnitContent({
      ...spec(host, []),
      environmentId: "env1",
      worker: {
        name: "queue",
        command: ["/usr/local/bin/php", "artisan", "queue:work", "--sleep=3"],
        processes: 2,
        stopTimeoutSeconds: 120,
        memoryMaxBytes: 536870912,
      },
    });
    const lines = text.split("\n");
    for (
      const line of [
        "Type=simple",
        "Restart=always",
        "RestartSec=5",
        "TimeoutStopSec=120",
        "MemoryMax=536870912",
        "RestartSteps=10",
        "RestartMaxDelaySec=120",
        "StartLimitIntervalSec=0",
        'ExecStart="/usr/local/bin/php" "artisan" "queue:work" "--sleep=3"',
        "X-TurboPanel-Environment=env1",
        "X-TurboPanel-Service=web",
        "X-TurboPanel-Instances=2",
        "WorkingDirectory=/srv/users/alice/sites/svc1/current",
        "Environment=TURBOPANEL_PHP=8.4",
        `SyslogIdentifier=${BASE}`,
        "PrivateDevices=yes",
        `IPAddressDeny=${SITE_PHP_IP_DENY}`,
        `IPAddressAllow=${SITE_PHP_IP_ALLOW}`,
        `ExecStartPre=+${host.layout.libDir}/tp-php-loopback sync`,
        "WantedBy=multi-user.target",
      ]
    ) assert(lines.includes(line), line);
    assertStringIncludes(text, "Description=TurboPanel worker queue (web) %i");
    // Defaults when nothing is set: one process, ninety seconds, no memory cap.
    const plain = workerUnitContent({
      ...spec(host, []),
      environmentId: "env1",
      worker: queue(),
    });
    assertStringIncludes(plain, "TimeoutStopSec=90");
    assertStringIncludes(plain, "X-TurboPanel-Instances=1");
    assert(!plain.includes("MemoryMax"));
  } finally {
    await host.cleanup();
  }
});

test("instance names run from the first to the count", () => {
  assertEquals(workerInstanceUnits(BASE, 3), [
    `${BASE}@1.service`,
    `${BASE}@2.service`,
    `${BASE}@3.service`,
  ]);
  assertEquals(workerInstanceUnits(BASE, 8, 7), [
    `${BASE}@7.service`,
    `${BASE}@8.service`,
  ]);
  assertEquals(workerUnitBase("env1", "web", "queue"), BASE);
});

test("applying three processes enables them, restarts them in one call and leaves the rest disabled", async () => {
  const host = await makeSystemdHost(active);
  try {
    const warnings = await applySiteWorkers(io(host), "env1", [
      spec(host, [queue(3)]),
    ]);
    assertEquals(warnings, []);
    const template = join(host.unitDir, `${BASE}@.service`);
    assertStringIncludes(await Deno.readTextFile(template), "Type=simple");
    const calls = host.systemctl().filter((args) => args[0] !== "is-active");
    assertEquals(calls, [
      ["daemon-reload"],
      [
        "enable",
        `${BASE}@1.service`,
        `${BASE}@2.service`,
        `${BASE}@3.service`,
      ],
      [
        "disable",
        "--now",
        "--no-block",
        ...[4, 5, 6, 7, 8].map((k) => `${BASE}@${k}.service`),
      ],
      [
        "restart",
        "--no-block",
        `${BASE}@1.service`,
        `${BASE}@2.service`,
        `${BASE}@3.service`,
      ],
    ]);
    assert(host.calls.some((call) => call.tool === "php-loopback-sync"));
  } finally {
    await host.cleanup();
  }
});

test("going from three processes to one disables the other two instances", async () => {
  const host = await makeSystemdHost(active);
  try {
    await applySiteWorkers(io(host), "env1", [spec(host, [queue(3)])]);
    host.calls.length = 0;
    await applySiteWorkers(io(host), "env1", [spec(host, [queue(1)])]);
    const calls = host.systemctl().filter((args) => args[0] !== "is-active");
    assertEquals(calls[0], ["daemon-reload"]);
    assertEquals(calls[1], ["enable", `${BASE}@1.service`]);
    assertEquals(
      calls[2],
      [
        "disable",
        "--now",
        "--no-block",
        ...[2, 3, 4, 5, 6, 7, 8].map((k) => `${BASE}@${k}.service`),
      ],
    );
    assertEquals(calls[3], ["restart", "--no-block", `${BASE}@1.service`]);
  } finally {
    await host.cleanup();
  }
});

test("a worker the payload no longer names is stopped, disabled and removed before the rest apply", async () => {
  const host = await makeSystemdHost(active);
  try {
    await applySiteWorkers(io(host), "env1", [
      spec(host, [queue(1), { ...queue(1), name: "mail" }]),
    ]);
    host.calls.length = 0;
    await applySiteWorkers(io(host), "env1", [spec(host, [queue(1)])]);
    const left = (await Array.fromAsync(Deno.readDir(host.unitDir)))
      .map((entry) => entry.name);
    assertEquals(left, [`${BASE}@.service`]);
    const calls = host.systemctl();
    const removal = calls.findIndex((args) =>
      args[0] === "disable" &&
      args.includes("turbopanel-worker-env1-web-mail@1.service")
    );
    const restart = calls.findIndex((args) => args[0] === "restart");
    assert(removal >= 0 && removal < restart, JSON.stringify(calls));
    assertEquals(
      calls[removal],
      [
        "disable",
        "--now",
        "--no-block",
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) =>
          `turbopanel-worker-env1-web-mail@${k}.service`
        ),
      ],
    );
  } finally {
    await host.cleanup();
  }
});

test("an environment with no workers named removes the ones it had, and touches no other environment", async () => {
  const host = await makeSystemdHost(active);
  try {
    await applySiteWorkers(io(host), "env1", [spec(host, [queue(1)])]);
    await Deno.writeTextFile(
      join(host.unitDir, "turbopanel-worker-env2-web-queue@.service"),
      "[Service]\n",
    );
    const warnings = await applySiteWorkers(io(host), "env1", []);
    assertEquals(warnings, []);
    const left = (await Array.fromAsync(Deno.readDir(host.unitDir)))
      .map((entry) => entry.name);
    assertEquals(left, ["turbopanel-worker-env2-web-queue@.service"]);
  } finally {
    await host.cleanup();
  }
});

test("a worker that is finishing a job is a transcript line, one that failed is a warning with its journal", async () => {
  const states: Record<string, string> = {
    [`${BASE}@1.service`]: "deactivating",
    "turbopanel-worker-env1-web-mail@1.service": "failed",
  };
  const host = await makeSystemdHost((call) => {
    if (call.tool === "systemctl" && call.args[0] === "is-active") {
      const state = states[call.args[1] ?? ""] ?? "active";
      return state === "active" ? hostOk(state) : hostFail("", state);
    }
    if (call.tool === "journalctl") {
      return hostOk(
        "2026-11-10T12:00:00+0000 host turbopanel-worker-env1-web-mail[9]: boom",
      );
    }
    return undefined;
  });
  try {
    const lines: string[] = [];
    const warnings = await applySiteWorkers(io(host, lines), "env1", [
      spec(host, [queue(1), { ...queue(1), name: "mail" }]),
    ]);
    assertEquals(warnings, ["Site web: worker mail did not stay running."]);
    assert(
      lines.includes(
        "worker web/queue is finishing its current job; it starts on the new release when done",
      ),
      lines.join("\n"),
    );
    assert(lines.includes("boom"), lines.join("\n"));
    // A caller whose lines are not redacted asks for no journal text at all.
    const quiet: string[] = [];
    await applySiteWorkers(
      { ...io(host, quiet), omitJournal: true },
      "env1",
      [spec(host, [queue(1), { ...queue(1), name: "mail" }])],
    );
    assert(!quiet.includes("boom"), quiet.join("\n"));
    assert(quiet.some((line) => line.includes("did not stay running")));
  } finally {
    await host.cleanup();
  }
});

test("two workers that would share a unit name are refused before anything is installed", async () => {
  const host = await makeSystemdHost();
  try {
    await assertRejects(
      () =>
        applySiteWorkers(io(host), "env1", [
          spec(host, [{ ...queue(1), name: "a-b" }], "web"),
          spec(host, [{ ...queue(1), name: "b" }], "web-a"),
        ]),
      Error,
      "would share the unit name",
    );
    assertEquals(host.systemctl(), []);
  } finally {
    await host.cleanup();
  }
});

test("a worker is checked every two seconds for thirty seconds at most", async () => {
  let checks = 0;
  const host = await makeSystemdHost((call) => {
    if (call.tool === "systemctl" && call.args[0] === "is-active") {
      checks++;
      return hostFail("", "activating");
    }
    return undefined;
  });
  try {
    const waits: number[] = [];
    await applySiteWorkers(
      {
        ...io(host),
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
      "env1",
      [spec(host, [queue(1)])],
    );
    assertEquals(checks, 15);
    assertEquals(waits.length, 14);
    assert(waits.every((ms) => ms === 2000));
  } finally {
    await host.cleanup();
  }
});

test("a dropped environment's workers are all removed on stop", async () => {
  const host = await makeSystemdHost(active);
  try {
    await applySiteWorkers(io(host), "env1", [spec(host, [queue(2)])]);
    assertEquals(await removeEnvironmentWorkers(io(host), "env1"), 1);
    assertEquals(await Array.fromAsync(Deno.readDir(host.unitDir)), []);
  } finally {
    await host.cleanup();
  }
});

test("installed workers are found from their unit files, and lifecycle follows the action", async () => {
  const host = await makeSystemdHost(active);
  try {
    await applySiteWorkers(io(host), "env1", [
      spec(host, [queue(2)]),
      spec(host, [{ ...queue(1), name: "mail" }], "api"),
    ]);
    const web = await listInstalledWorkers(io(host), "env1", "web");
    assertEquals(web, [{
      base: BASE,
      composeServiceName: "web",
      instances: 2,
    }]);
    const all = await listInstalledWorkers(io(host), "env1");
    assertEquals(all.length, 2);
    host.calls.length = 0;
    const asked = await workerLifecycle(io(host), "env1", "stop");
    assertEquals(asked.length, 3);
    assertEquals(host.systemctl().map((args) => args.slice(0, 2)), [
      ["stop", "--no-block"],
      ["stop", "--no-block"],
    ]);
    host.calls.length = 0;
    const warnings = await restartInstalledWorkers(io(host), web);
    assertEquals(warnings, []);
    assertEquals(host.systemctl()[0], [
      "restart",
      "--no-block",
      `${BASE}@1.service`,
      `${BASE}@2.service`,
    ]);
  } finally {
    await host.cleanup();
  }
});

test("a template of another environment or without an instance count is not read as a worker", () => {
  const text = [
    "[Unit]",
    "X-TurboPanel-Environment=env2",
    "X-TurboPanel-Service=web",
    "X-TurboPanel-Instances=2",
  ].join("\n");
  assertEquals(parseWorkerTemplate(BASE, text, "env1"), undefined);
  assertEquals(
    parseWorkerTemplate(
      BASE,
      text.replace("Instances=2", "Instances=9"),
      "env2",
    ),
    undefined,
  );
  assertEquals(
    parseWorkerTemplate(
      BASE,
      text.replace("X-TurboPanel-Instances=2", ""),
      "env2",
    ),
    undefined,
  );
  assertEquals(parseWorkerTemplate(BASE, text, "env2")?.instances, 2);
});
