/**
 * tp-host, run unprivileged in its test mode (TP_HOST_TEST_PREFIX): every
 * managed path lives under a throwaway prefix, account lookups read the
 * prefix's etc/passwd and etc/group, file mechanics run for real, and the
 * privileged commands (chown, useradd, systemctl, iptables, …) are printed
 * as `EXEC [argv]…` instead of run. Unit files come from the daemon's own
 * renderers, so the allowlist is proven against what the daemon writes.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type Host,
  refused,
  TP_HOST_SCRIPT as SCRIPT,
  withHost,
} from "../testing/tp-host-fixture.ts";
import {
  DAEMON_CONFIG_LEAVES,
  DAEMON_STATE_LEAVES,
  resolveLayout,
} from "../paths/layout.ts";
import { cronServiceContent, cronTimerContent } from "../deploy/cron/unit.ts";
import {
  nativeAppUnitContent,
  principalSliceContent,
} from "../deploy/native/unit.ts";
import { renderNativeAppEnvFile } from "../deploy/native/variables-runtime.ts";
import { caddyUnit } from "../deploy/ingress.ts";
import { phpFpmPoolConfig } from "../deploy/site.ts";
import { allAccessGroups } from "../runtime/registry.ts";
import { sshdDropInContent } from "../deploy/ssh/sshd-config.ts";
import { backupServiceContent, backupTimerContent } from "../backups/units.ts";
import { issuedCertificateFindArgs } from "../deploy/instance-acme-http01.ts";
import { setgidDirectoriesFindArgs } from "../deploy/site.ts";
import {
  parseReleaseLinkTexts,
  releaseLinkTargetsFindArgs,
  releaseLinkTextsFindArgs,
} from "../deploy/release/release-links.ts";
import type {
  EnvironmentDeployCronJob,
  EnvironmentDeployNativeAppService,
} from "../contracts/commands-contracts.ts";
import {
  sitePhpConfigDir,
  sitePhpFpmConf,
  sitePhpIni,
  sitePhpKey,
  sitePhpRuntimeId,
  type SitePhpRuntimeSpec,
  sitePhpServiceName,
  sitePhpServiceUnit,
  sitePhpSocketName,
  sitePhpSocketUnit,
} from "../deploy/site/php-runtime.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("tp-host refuses to run as a normal user outside its test mode", async () => {
  const out = await new Deno.Command("sh", {
    args: [SCRIPT, "systemctl", "daemon-reload"],
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code === 0, false);
});

test("install writes a file only inside the managed trees, never through a symlink", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path("etc/turbopanel/nginx"), { recursive: true });
    const dest = host.path("etc/turbopanel/nginx/nginx.conf");
    const ok = await host.run([
      "install",
      "-m",
      "0640",
      "-o",
      "root",
      "-g",
      "tpnginx",
      host.path("tmp/staged"),
      dest,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assertEquals(await Deno.readTextFile(dest), "staged content\n");
    assertEquals((await Deno.stat(dest)).mode! & 0o777, 0o640);
    assertStringIncludes(
      ok.stdout,
      "EXEC [chown] [-h] [--] [root:tpnginx] [./f]",
    );

    // A symlink planted as the destination is replaced, not written through.
    const planted = host.path("etc/turbopanel/nginx/app.conf");
    await Deno.symlink(host.path("outside/secret"), planted);
    const replaced = await host.run([
      "install",
      "-m",
      "0640",
      host.path("tmp/staged"),
      planted,
    ]);
    assertEquals(replaced.code, 0, replaced.stderr);
    assertEquals(
      await Deno.readTextFile(host.path("outside/secret")),
      "root-only secret\n",
    );
    assertEquals((await Deno.lstat(planted)).isSymlink, false);

    // A symlinked directory anywhere in the path is refused.
    await Deno.symlink(
      host.path("outside"),
      host.path("etc/turbopanel/nginx/linked"),
    );
    await refused(host, [
      "install",
      "-m",
      "0640",
      host.path("tmp/staged"),
      host.path("etc/turbopanel/nginx/linked/evil"),
    ]);
    for (
      const target of [
        host.path("etc/passwd"),
        // Raw, not path.join: join would normalise the `..` away.
        `${host.prefix}/etc/turbopanel/../passwd`,
        host.path("etc/sudoers.d/tp"),
        host.path("etc/systemd/system/evil.service"),
        "relative/path",
      ]
    ) {
      await refused(host, [
        "install",
        "-m",
        "0640",
        host.path("tmp/staged"),
        target,
      ]);
    }
    // No setuid, and nothing group/world-writable outside a home.
    await refused(host, [
      "install",
      "-m",
      "4755",
      host.path("tmp/staged"),
      dest,
    ]);
    await refused(host, [
      "install",
      "-m",
      "0666",
      host.path("tmp/staged"),
      dest,
    ]);
    // A tenant never owns a file outside its own home.
    await refused(host, [
      "install",
      "-m",
      "0640",
      "-o",
      "alice",
      host.path("tmp/staged"),
      dest,
    ]);
  });
});

test("install -d and mkdir -p create directories only below a managed root", async () => {
  await withHost(async (host) => {
    const dir = host.path("srv/users/alice/sites/web/shared");
    const ok = await host.run([
      "install",
      "-d",
      "-m",
      "0750",
      "-o",
      "alice",
      "-g",
      "alice",
      dir,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assertEquals((await Deno.stat(dir)).isDirectory, true);
    assertStringIncludes(
      ok.stdout,
      "EXEC [chown] [-h] [--] [alice:alice] [.]",
    );
    await refused(host, [
      "install",
      "-d",
      "-m",
      "0755",
      host.path("etc/cron.d"),
    ]);
    await refused(host, ["mkdir", "-p", host.path("usr/local/evil")]);
    const made = await host.run([
      "mkdir",
      "-p",
      "--",
      host.path("var/lib/turbopanel/a/b"),
    ]);
    assertEquals(made.code, 0, made.stderr);
  });
});

test("the daemon's own unit files pass; privileged or foreign units do not", async () => {
  await withHost(async (host) => {
    const layout = resolveLayout({
      TURBOPANEL_HOME: host.path("opt/turbopanel"),
      TURBOPANEL_RUNTIMES_DIR: host.path("opt/turbopanel/vendor"),
      TURBOPANEL_CONFIG_DIR: host.path("etc/turbopanel"),
      TURBOPANEL_STATE_DIR: host.path("var/lib/turbopanel"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: host.path("srv/users"),
    }, { forceMode: "production" });
    const job = {
      name: "nightly",
      schedule: "*-*-* 03:00:00",
      command: ["/usr/bin/php8.4", "artisan", "schedule:run"],
    } as unknown as EnvironmentDeployCronJob;
    const cronOpts = {
      layout,
      environmentId: "env1",
      composeServiceName: "web",
      job,
      username: "alice",
      workingDirectory: host.path("srv/users/alice/sites/web/current"),
    };
    const units: Array<[string, string]> = [
      [
        "turbopanel-cron-env1-web-nightly.service",
        cronServiceContent(cronOpts),
      ],
      ["turbopanel-cron-env1-web-nightly.timer", cronTimerContent(cronOpts)],
      [
        "turbopanel-app-svc1.service",
        nativeAppUnitContent({
          layout,
          username: "alice",
          environmentId: "env1",
          app: {
            serviceId: "svc1",
            composeServiceName: "web",
            listenPort: 3000,
            resources: { cpus: 1.5, memoryBytes: 536870912 },
          } as unknown as EnvironmentDeployNativeAppService,
        }),
      ],
      [
        // A Deno app: the same directives, the vendored Deno as ExecStart.
        "turbopanel-app-svc2.service",
        nativeAppUnitContent({
          layout,
          username: "alice",
          environmentId: "env1",
          environmentFile: true,
          nativeStart: { kind: "deno-file", path: "src/main.ts" },
          app: {
            serviceId: "svc2",
            composeServiceName: "api",
            listenPort: 3001,
            runtime: "deno",
            framework: "auto",
          } as unknown as EnvironmentDeployNativeAppService,
        }),
      ],
      [
        "turbopanel-alice.slice",
        principalSliceContent(
          {
            username: "alice",
            limits: { cpus: 2, memoryBytes: 1073741824, tasksMax: 512 },
          } as Parameters<typeof principalSliceContent>[0],
        ),
      ],
      ["turbopanel-hosting-caddy.service", caddyUnit(layout)],
    ];
    for (const [name, content] of units) {
      await Deno.writeTextFile(host.path(`tmp/${name}`), content);
      const result = await host.run([
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        host.path(`tmp/${name}`),
        host.path(`etc/systemd/system/${name}`),
      ]);
      assertEquals(result.code, 0, `${name}: ${result.stderr}`);
    }

    const service = cronServiceContent(cronOpts);
    const hostile: Array<[string, string]> = [
      ["runs as root", service.replace("User=alice", "User=root")],
      ["no User=", service.replace(/^User=alice\n/m, "")],
      // The unit's fields are read back as tab-separated values, so an empty
      // one must be refused outright, never shift the others into its place
      // (Road to 0.2.x row r2-tphost-field-parsing).
      ["an empty User=", service.replace(/^User=alice$/m, "User=")],
      ["no Group=", service.replace(/^Group=.*\n/m, "")],
      ["an empty Group=", service.replace(/^Group=.*$/m, "Group=")],
      ["no Slice=", service.replace(/^Slice=.*\n/m, "")],
      ["an empty Slice=", service.replace(/^Slice=.*$/m, "Slice=")],
      // "-" stands for an empty field in the hand-off, so a literal one is refused.
      ["a Slice= of -", service.replace(/^Slice=.*$/m, "Slice=-")],
      ["a Group= of -", service.replace(/^Group=.*$/m, "Group=-")],
      [
        "no NoNewPrivileges=",
        service.replace(/^NoNewPrivileges=.*\n/m, ""),
      ],
      [
        "an empty NoNewPrivileges=",
        service.replace(/^NoNewPrivileges=.*$/m, "NoNewPrivileges="),
      ],
      ["privileged exec prefix", service.replace("ExecStart=", "ExecStart=+")],
      // systemd takes the prefix characters `@ - : + ! |` stacked in any order,
      // after any leading whitespace.
      ...[
        "-+",
        "@+",
        "+-",
        "!!",
        "-!",
        ":+",
        "@-+",
        "|",
        " +",
        "\t!",
        "  -@+",
      ].map((prefix): [string, string] => [
        `stacked exec prefix ${JSON.stringify(prefix)}`,
        service.replace("ExecStart=", `ExecStart=${prefix}`),
      ]),
      // systemd unquotes and unescapes the first word before it reads the
      // prefix, so these run as root too.
      ...[
        `"+/bin/sh" "-c" "id"`,
        `-"+/bin/sh" "-c" "id"`,
        `'+/bin/sh' -c id`,
        `\\x2b/bin/sh -c id`,
        `"\\x2b/bin/sh" -c id`,
        `"!/bin/sh" -c id`,
        `sh -c id`,
        `"sh" "-c" "id"`,
        ``,
      ].flatMap((exec): Array<[string, string]> => [
        [
          `quoted or escaped exec ${JSON.stringify(exec)}`,
          service.replace(/^ExecStart=.*$/m, `ExecStart=${exec}`),
        ],
        [
          `ExecReload ${JSON.stringify(exec)}`,
          service.replace("[Service]", `[Service]\nExecReload=${exec}`),
        ],
        [
          `ExecStartPre ${JSON.stringify(exec)}`,
          service.replace("[Service]", `[Service]\nExecStartPre=${exec}`),
        ],
      ]),
      [
        "root pre-start",
        service.replace("[Service]", "[Service]\nExecStartPre=!/bin/sh -c id"),
      ],
      [
        "capabilities",
        service.replace(
          "AmbientCapabilities=",
          "AmbientCapabilities=CAP_SYS_ADMIN",
        ),
      ],
      ["another tenant's group", service.replace(/^Group=.*$/m, "Group=tp")],
      [
        "unknown directive",
        service.replace("[Service]", "[Service]\nPermissionsStartOnly=true"),
      ],
      [
        "no NoNewPrivileges",
        service.replace("NoNewPrivileges=yes", "NoNewPrivileges=no"),
      ],
      [
        // systemd joins a line ending in `\\` onto the next one, so it reads
        // `SyslogIdentifier=x User=alice` and no User= at all (root), while a
        // line-by-line check would see User=alice.
        "a line continuation that hides User= from systemd",
        service.replace(/^User=alice$/m, "SyslogIdentifier=x \\\nUser=alice"),
      ],
      [
        "timer for another unit",
        cronTimerContent(cronOpts).replace(
          /^Unit=.*$/m,
          "Unit=turbopanel-hosting-caddy.service",
        ),
      ],
      [
        "root caddy with another command",
        caddyUnit(layout).replace(/^ExecStart=.*$/m, "ExecStart=/bin/sh -c id"),
      ],
    ];
    for (const [label, content] of hostile) {
      const kind = label === "timer for another unit" ? "timer" : "service";
      const name = label.startsWith("root caddy")
        ? "turbopanel-hosting-caddy.service"
        : `turbopanel-cron-env1-web-nightly.${kind}`;
      await Deno.writeTextFile(host.path("tmp/bad"), content);
      await refused(host, [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        host.path("tmp/bad"),
        host.path(`etc/systemd/system/${name}`),
      ]);
    }
  });
});

const BACKUP_ID = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
const OTHER_BACKUP_ID = "0192a3b4-c5d6-7e8f-9a0b-ffffffffffff";

async function installUnit(host: Host, name: string, content: string) {
  await Deno.writeTextFile(host.path("tmp/unit"), content);
  return host.run([
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    host.path("tmp/unit"),
    host.path(`etc/systemd/system/${name}`),
  ]);
}

async function refusedUnit(host: Host, name: string, content: string) {
  await Deno.writeTextFile(host.path("tmp/unit"), content);
  await refused(host, [
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    host.path("tmp/unit"),
    host.path(`etc/systemd/system/${name}`),
  ]);
}

test("a native app unit may load its own variables file and no other", async () => {
  await withHost(async (host) => {
    const layout = resolveLayout({
      TURBOPANEL_HOME: host.path("opt/turbopanel"),
      TURBOPANEL_RUNTIMES_DIR: host.path("opt/turbopanel/vendor"),
      TURBOPANEL_CONFIG_DIR: host.path("etc/turbopanel"),
      TURBOPANEL_STATE_DIR: host.path("var/lib/turbopanel"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: host.path("srv/users"),
    }, { forceMode: "production" });
    const unitFor = (serviceId: string) =>
      nativeAppUnitContent({
        layout,
        username: "alice",
        environmentId: "env1",
        environmentFile: true,
        app: {
          serviceId,
          composeServiceName: "web",
          listenPort: 3000,
        } as unknown as EnvironmentDeployNativeAppService,
      });
    const name = "turbopanel-app-svc1.service";
    const unit = unitFor("svc1");
    const own = `EnvironmentFile=${
      host.path("etc/turbopanel/node-app-env/svc1.env")
    }`;
    assertStringIncludes(unit, own);
    const result = await installUnit(host, name, unit);
    assertEquals(result.code, 0, result.stderr);

    const hostile: Array<[string, string]> = [
      // Another service's file: one tenant's unit would load another's secrets.
      ["another service's file", unitFor("svc2")],
      [
        // The folder the daemon stages into and can write: a unit naming it
        // would have systemd (root) read whatever the daemon put there.
        "the daemon-writable staging path",
        unit.replace(
          own,
          `EnvironmentFile=${
            host.path("etc/turbopanel/node-apps/envs/svc1.env")
          }`,
        ),
      ],
      [
        "a path outside the node-app-env tree",
        unit.replace(own, "EnvironmentFile=/etc/turbopanel/daemon.env"),
      ],
      [
        "the daemon's own environment file",
        unit.replace(
          own,
          `EnvironmentFile=${host.path("etc/turbopanel/daemon.env")}`,
        ),
      ],
      ["the optional (-) spelling", unit.replace(own, own.replace("=", "=-"))],
      [
        "a path that climbs out of the directory",
        unit.replace(
          own,
          own.replace("node-app-env/svc1.env", "node-app-env/../daemon.env"),
        ),
      ],
      [
        "a trailing-space spelling",
        unit.replace(own, `${own} `),
      ],
      [
        "a second EnvironmentFile",
        unit.replace(own, `${own}\n${own}`),
      ],
      [
        "an indented directive",
        unit.replace(own, ` ${own}`),
      ],
    ];
    for (const [label, content] of hostile) {
      await Deno.writeTextFile(host.path("tmp/bad"), content);
      try {
        await refused(host, [
          "install",
          "-m",
          "0644",
          "-o",
          "root",
          "-g",
          "root",
          host.path("tmp/bad"),
          host.path(`etc/systemd/system/${name}`),
        ]);
      } catch (err) {
        throw new Error(
          `${label}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Only app units: a cron unit (or any other tenant unit) gains nothing.
    const cronName = "turbopanel-cron-env1-web-nightly.service";
    const cron = cronServiceContent({
      layout,
      environmentId: "env1",
      composeServiceName: "web",
      job: {
        name: "nightly",
        schedule: "*-*-* 03:00:00",
        command: ["/usr/bin/true"],
      } as unknown as EnvironmentDeployCronJob,
      username: "alice",
      workingDirectory: host.path("srv/users/alice/sites/web/current"),
    });
    await refusedUnit(
      host,
      cronName,
      cron.replace("[Service]", `[Service]\n${own}`),
    );
  });
});

// --- app-env-install / app-env-remove ---------------------------------------
// A Node app's variables: tp-host copies the daemon's staged file into a folder
// only root can write, and the unit loads that copy. Run unprivileged in test
// mode, where "root" is the account running the tests; the one refusal that
// needs a second real account (a staged file owned by someone else) is proved
// in the root container run instead (see the PR).

const ENV_STAGED = "etc/turbopanel/node-apps/envs/svc1.env";
const ENV_COPY = "etc/turbopanel/node-app-env/svc1.env";

const ENV_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "LD_PRELOAD=/not/a/line",
  "-----END PRIVATE KEY-----",
].join("\n");

const ENV_ENTRIES = [
  { name: "PLAIN", value: "value" },
  { name: "DOLLAR", value: "pa$$word $HOME ${X}" },
  { name: "BACKSLASH", value: String.raw`C:\temp\new` },
  { name: "SPECIFIER", value: "%h %n" },
  { name: "BOTH_QUOTES", value: `it's "quoted" \`tick\`` },
  { name: "MULTILINE", value: "one\ntwo\n\nfour" },
  { name: "PEM", value: ENV_PEM },
  { name: "EMPTY", value: "" },
  { name: "TRAILING_BACKSLASH", value: "ends\\" },
];

async function stageEnv(host: Host, text: string, rel = ENV_STAGED) {
  await Deno.mkdir(host.path(rel.slice(0, rel.lastIndexOf("/"))), {
    recursive: true,
  });
  await Deno.writeTextFile(host.path(rel), text);
}

async function modeOf(path: string): Promise<number> {
  return (await Deno.stat(path)).mode! & 0o777;
}

async function refusedEnvInstall(host: Host, label: string, id = "svc1") {
  try {
    const stderr = await refused(host, ["app-env-install", id]);
    assertEquals(stderr.includes("root-only secret"), false, label);
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : err}`);
  }
  const copied = await Deno.lstat(host.path(ENV_COPY)).then(
    () => true,
    () => false,
  );
  assertEquals(copied, false, label);
}

test("app-env-install copies a checked file into a root-only folder, every value intact", async () => {
  await withHost(async (host) => {
    const text = renderNativeAppEnvFile(ENV_ENTRIES);
    await stageEnv(host, text);
    const result = await host.run(["app-env-install", "svc1"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(await Deno.readTextFile(host.path(ENV_COPY)), text);
    assertEquals(await modeOf(host.path(ENV_COPY)), 0o600);
    assertEquals(await modeOf(host.path("etc/turbopanel/node-app-env")), 0o700);
    // Nothing is left beside it: no scratch directory.
    assertEquals(
      [...Deno.readDirSync(host.path("etc/turbopanel/node-app-env"))].map((
        entry,
      ) => entry.name),
      ["svc1.env"],
    );
    // The daemon's staged file is its own to delete; tp-host leaves it alone.
    assertEquals(await Deno.readTextFile(host.path(ENV_STAGED)), text);
  });
});

test("app-env-install is idempotent and a later run replaces the copy", async () => {
  await withHost(async (host) => {
    const first = renderNativeAppEnvFile([{ name: "A", value: "1" }]);
    await stageEnv(host, first);
    for (const _ of [1, 2]) {
      const result = await host.run(["app-env-install", "svc1"]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(await Deno.readTextFile(host.path(ENV_COPY)), first);
    }
    const second = renderNativeAppEnvFile([{ name: "A", value: "2" }]);
    await stageEnv(host, second);
    assertEquals((await host.run(["app-env-install", "svc1"])).code, 0);
    assertEquals(await Deno.readTextFile(host.path(ENV_COPY)), second);
    assertEquals(await modeOf(host.path(ENV_COPY)), 0o600);
    // An empty file (an app whose names were all platform-managed never gets
    // here, but an empty one is a valid, empty set).
    await stageEnv(host, "");
    assertEquals((await host.run(["app-env-install", "svc1"])).code, 0);
  });
});

test("app-env-install refuses what is not a plain regular file the daemon owns", async () => {
  await withHost(async (host) => {
    const good = renderNativeAppEnvFile([{ name: "A", value: "1" }]);
    const envs = host.path("etc/turbopanel/node-apps/envs");
    const reset = async () => {
      await Deno.remove(host.path("etc/turbopanel/node-apps"), {
        recursive: true,
      }).catch(() => undefined);
      await stageEnv(host, good);
    };

    // A symlink at the staged path to a file only root can read: the daemon
    // would otherwise have root copy it where the unit reads it.
    await reset();
    await Deno.remove(host.path(ENV_STAGED));
    await Deno.symlink(host.path("outside/secret"), host.path(ENV_STAGED));
    await refusedEnvInstall(host, "symlink at the staged path");

    // A symlink to a file that is a valid env file: still a link.
    await reset();
    await Deno.writeTextFile(host.path("tmp/valid.env"), good);
    await Deno.remove(host.path(ENV_STAGED));
    await Deno.symlink(host.path("tmp/valid.env"), host.path(ENV_STAGED));
    await refusedEnvInstall(host, "symlink to an acceptable file");

    // The staging folder swapped for a link to another folder.
    await reset();
    await Deno.mkdir(host.path("outside/envs"), { recursive: true });
    await Deno.writeTextFile(host.path("outside/envs/svc1.env"), good);
    await Deno.rename(envs, host.path("tmp/envs-moved"));
    await Deno.symlink(host.path("outside/envs"), envs);
    await refusedEnvInstall(host, "staging folder swapped for a link");

    // The folder above it (node-apps) swapped for a link.
    await reset();
    await Deno.rename(
      host.path("etc/turbopanel/node-apps"),
      host.path("tmp/node-apps-moved"),
    );
    await Deno.symlink(
      host.path("tmp/node-apps-moved"),
      host.path("etc/turbopanel/node-apps"),
    );
    await refusedEnvInstall(host, "node-apps swapped for a link");

    // No staged file, a directory in its place, a named pipe in its place (a
    // plain open would block root), a second hard link.
    await reset();
    await Deno.remove(host.path(ENV_STAGED));
    await refusedEnvInstall(host, "no staged file");
    await Deno.mkdir(host.path(ENV_STAGED));
    await refusedEnvInstall(host, "a directory");
    await Deno.remove(host.path(ENV_STAGED));
    const fifo = await new Deno.Command("mkfifo", {
      args: [host.path(ENV_STAGED)],
    }).output();
    assertEquals(fifo.code, 0);
    await refusedEnvInstall(host, "a named pipe");
    await Deno.remove(host.path(ENV_STAGED));
    await Deno.writeTextFile(host.path(ENV_STAGED), good);
    await Deno.link(host.path(ENV_STAGED), host.path("tmp/second-link"));
    await refusedEnvInstall(host, "a second hard link");
  });
});

test("app-env-install refuses a file over the size limit", async () => {
  await withHost(async (host) => {
    const line = `A='${"x".repeat(60_000)}'\n`;
    await stageEnv(host, line.repeat(18));
    const stderr = await refused(host, ["app-env-install", "svc1"]);
    assertStringIncludes(stderr, "over 1048576 bytes");
    await assertRejects(
      () => Deno.lstat(host.path(ENV_COPY)),
      Deno.errors.NotFound,
    );
  });
});

test("app-env-install refuses every line shape the daemon never writes", async () => {
  await withHost(async (host) => {
    const bad: Array<[string, string]> = [
      ["a line that is not NAME=value", "just words\n"],
      ["an unquoted value", "A=1\n"],
      ["an empty unquoted value", "A=\n"],
      ["a name starting with a digit", "1A='x'\n"],
      ["a name with a dash", "A-B='x'\n"],
      ["a name with a space", "A B='x'\n"],
      ["an indented entry", " A='x'\n"],
      ["export", "export A='x'\n"],
      ["text after the closing quote", "A='x' B='y'\n"],
      ["a second entry glued on after a quote", "A='x'\nB='y'C\n"],
      ["an unterminated quote", "A='x\nB='y'\n"],
      ["an unterminated double quote", 'A="x\n'],
      ["an unescaped dollar in double quotes", `A="it's $HOME"\n`],
      ["an unescaped backtick in double quotes", 'A="it\'s `id`"\n'],
      ["an unknown escape", 'A="it\\\'s \\n"\n'],
      ["a trailing backslash in double quotes", 'A="x\\\n'],
      ["a repeated name", "A='1'\nA='2'\n"],
      ["a carriage return", "A='1'\r\nB='2'\n"],
      ["a NUL byte", "A='1'\u0000B='2'\n"],
      ["an EnvironmentFile-looking line", "EnvironmentFile=/etc/shadow\n"],
      ["a name over 255 characters", `${"N".repeat(256)}='x'\n`],
    ];
    for (const [label, text] of bad) {
      await stageEnv(host, text);
      await refusedEnvInstall(host, label);
    }
    // Quoted newlines are values, not lines: a "line" inside a PEM that looks
    // like an entry or a directive is fine, and the same text outside quotes
    // is not.
    await stageEnv(
      host,
      renderNativeAppEnvFile([{ name: "K", value: "a\nB=c\n#d" }]),
    );
    assertEquals((await host.run(["app-env-install", "svc1"])).code, 0);
    const before = await Deno.readTextFile(host.path(ENV_COPY));
    await stageEnv(host, "K='a'\nB=c\n");
    await refused(host, ["app-env-install", "svc1"]);
    // A refused file leaves the copy already in place as it was.
    assertEquals(await Deno.readTextFile(host.path(ENV_COPY)), before);
  });
});

test("app-env-install and app-env-remove take one service id and nothing that is a path", async () => {
  await withHost(async (host) => {
    await stageEnv(host, renderNativeAppEnvFile([{ name: "A", value: "1" }]));
    await stageEnv(host, "A='1'\n", "etc/turbopanel/node-apps/envs/-x.env");
    await Deno.writeTextFile(host.path("etc/turbopanel/daemon.env"), "A='1'\n");
    for (const verb of ["app-env-install", "app-env-remove"]) {
      for (
        const args of [
          [],
          ["svc1", "svc2"],
          [""],
          ["-x"],
          ["--"],
          [".."],
          ["../daemon"],
          ["svc1/../svc1"],
          ["/etc/turbopanel/daemon"],
          ["svc1.env"],
          ["svc 1"],
          ["svc1\\x"],
          ["a".repeat(129)],
          [host.path(ENV_STAGED)],
        ]
      ) {
        await refused(host, [verb, ...args]);
      }
    }
    await assertRejects(
      () => Deno.lstat(host.path("etc/turbopanel/node-app-env")),
      Deno.errors.NotFound,
    );
  });
});

test("app-env-install refuses a variables folder or parent that is not root's", async () => {
  await withHost(async (host) => {
    await stageEnv(host, renderNativeAppEnvFile([{ name: "A", value: "1" }]));
    // A folder someone made with a wider mode (or owner) is not trusted.
    await Deno.mkdir(host.path("etc/turbopanel/node-app-env"), { mode: 0o755 });
    await Deno.chmod(host.path("etc/turbopanel/node-app-env"), 0o755);
    await refusedEnvInstall(host, "a 0755 folder");
    await refused(host, ["app-env-remove", "svc1"]);
    await Deno.chmod(host.path("etc/turbopanel/node-app-env"), 0o700);
    assertEquals((await host.run(["app-env-install", "svc1"])).code, 0);
    // A config root the daemon could write would let it rename the folder.
    await Deno.chmod(host.path("etc/turbopanel"), 0o777);
    await Deno.remove(host.path(ENV_COPY));
    await refusedEnvInstall(host, "a world-writable config root");
    await Deno.chmod(host.path("etc/turbopanel"), 0o755);
    // A link where the folder should be.
    await Deno.remove(host.path("etc/turbopanel/node-app-env"));
    await Deno.mkdir(host.path("outside/app-env"));
    await Deno.symlink(
      host.path("outside/app-env"),
      host.path("etc/turbopanel/node-app-env"),
    );
    await refused(host, ["app-env-install", "svc1"]);
    await refused(host, ["app-env-remove", "svc1"]);
    assertEquals([...Deno.readDirSync(host.path("outside/app-env"))], []);
  });
});

test("app-env-remove deletes the copy, and an absent file or folder is fine", async () => {
  await withHost(async (host) => {
    assertEquals((await host.run(["app-env-remove", "svc1"])).code, 0);
    await stageEnv(host, renderNativeAppEnvFile([{ name: "A", value: "1" }]));
    assertEquals((await host.run(["app-env-install", "svc1"])).code, 0);
    await Deno.writeTextFile(
      host.path("etc/turbopanel/node-app-env/svc2.env"),
      "B='2'\n",
    );
    for (const _ of [1, 2]) {
      assertEquals((await host.run(["app-env-remove", "svc1"])).code, 0);
    }
    await assertRejects(
      () => Deno.lstat(host.path(ENV_COPY)),
      Deno.errors.NotFound,
    );
    // One id, one file: another app's copy stays.
    assertEquals(
      (await Deno.lstat(host.path("etc/turbopanel/node-app-env/svc2.env")))
        .isFile,
      true,
    );
  });
});

test("no generic verb reaches the variables folder, so only app-env-install can fill it", async () => {
  await withHost(async (host) => {
    const dirPath = host.path("etc/turbopanel/node-app-env");
    const file = `${dirPath}/svc1.env`;
    assertEquals(
      (await host.run(["app-env-install", "svc1"])).code === 0,
      false,
    );
    await stageEnv(host, renderNativeAppEnvFile([{ name: "A", value: "1" }]));
    assertEquals((await host.run(["app-env-install", "svc1"])).code, 0);
    await Deno.writeTextFile(host.path("tmp/plain"), "A='planted'\n");
    const attempts: string[][] = [
      ["install", "-m", "0600", host.path("tmp/plain"), file],
      [
        "install",
        "-m",
        "0600",
        "-o",
        "root",
        "-g",
        "root",
        host.path("tmp/plain"),
        `${dirPath}/svc9.env`,
      ],
      ["install", "-d", "-m", "0700", `${dirPath}/sub`],
      ["install", "-d", "-m", "0700", dirPath],
      ["mkdir", "-p", `${dirPath}/sub`],
      ["cp", "-p", "--", host.path("tmp/plain"), file],
      ["cp", "-p", "--", file, `${dirPath}/copy.env`],
      ["mv", "-T", host.path("tmp/plain"), file],
      ["mv", "-T", file, host.path("tmp/stolen")],
      ["mv", "-T", dirPath, host.path("tmp/dir-moved")],
      ["rm", "-f", file],
      ["rm", "-rf", dirPath],
      ["ln", "-s", "--", host.path("outside/secret"), `${dirPath}/link.env`],
      ["ln", "-s", "--", host.path("outside"), dirPath],
      ["chown", "tp", file],
      ["chmod", "0644", file],
      ["cat", file],
      ["cmp", file, host.path("tmp/plain")],
      ["ls", dirPath],
      ["tee", file],
      ["test", "-e", file],
      ["readlink", file],
      ["find", dirPath, "-maxdepth", "1"],
    ];
    for (const args of attempts) {
      await refused(host, args, "A='planted'\n");
    }
    assertEquals(
      await Deno.readTextFile(file),
      renderNativeAppEnvFile([{ name: "A", value: "1" }]),
    );
    assertEquals([...Deno.readDirSync(dirPath)].map((e) => e.name), [
      "svc1.env",
    ]);
  });
});

test("the hosting Caddy unit passes only as tpedge with CAP_NET_BIND_SERVICE alone", async () => {
  await withHost(async (host) => {
    const layout = resolveLayout({
      TURBOPANEL_HOME: host.path("opt/turbopanel"),
      TURBOPANEL_LIB_DIR: host.path("opt/turbopanel/lib"),
      TURBOPANEL_RUNTIMES_DIR: host.path("opt/turbopanel/vendor"),
      TURBOPANEL_CONFIG_DIR: host.path("etc/turbopanel"),
      TURBOPANEL_STATE_DIR: host.path("var/lib/turbopanel"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: host.path("srv/users"),
    }, { forceMode: "production" });
    const name = "turbopanel-hosting-caddy.service";
    const unit = caddyUnit(layout);
    const result = await installUnit(host, name, unit);
    assertEquals(result.code, 0, result.stderr);

    const drop = (pattern: RegExp) => unit.replace(pattern, "");
    const hostile: Array<[string, string]> = [
      ["root (no User=)", drop(/^User=.*\n/m)],
      ["User=root", unit.replace(/^User=.*$/m, "User=root")],
      ["the daemon account", unit.replace(/^User=.*$/m, "User=tp")],
      ["Group=tp", unit.replace(/^Group=.*$/m, "Group=tp")],
      ["no Group=", drop(/^Group=.*\n/m)],
      ["no NoNewPrivileges=", drop(/^NoNewPrivileges=.*\n/m)],
      [
        "NoNewPrivileges=no",
        unit.replace(/^NoNewPrivileges=.*$/m, "NoNewPrivileges=no"),
      ],
      [
        "a second ambient capability",
        unit.replace(
          /^AmbientCapabilities=.*$/m,
          "AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_SYS_ADMIN",
        ),
      ],
      [
        "another bounding capability",
        unit.replace(
          /^CapabilityBoundingSet=.*$/m,
          "CapabilityBoundingSet=CAP_SYS_ADMIN",
        ),
      ],
      ["no bounding set (keeps every capability)", drop(/^Capability.*\n/m)],
      ["no ambient capability", drop(/^AmbientCapabilities=.*\n/m)],
      [
        "a store inside the tp-owned tree",
        unit.replace(/^StateDirectory=.*$/m, "StateDirectory=turbopanel"),
      ],
      [
        "an extra environment variable",
        unit.replace(
          "[Service]",
          "[Service]\nEnvironment=LD_PRELOAD=/tmp/x.so",
        ),
      ],
      [
        "a data store the daemon owns",
        unit.replace(
          /^Environment=XDG_DATA_HOME=.*$/m,
          "Environment=XDG_DATA_HOME=/var/lib/turbopanel/hosting-caddy",
        ),
      ],
      [
        "another command",
        unit.replace(/^ExecStart=.*$/m, "ExecStart=/bin/sh -c id"),
      ],
      // Audit P0-1: a loopback TCP admin API is reachable by every tenant.
      [
        "a reload through a loopback TCP admin",
        unit.replace(/--address \S+$/m, "--address localhost:2029"),
      ],
      [
        "a reload through a socket outside the runtime directory",
        unit.replace(/--address \S+$/m, "--address unix//tmp/admin.sock"),
      ],
      ["no runtime directory", drop(/^RuntimeDirectory=.*\n/m)],
      [
        "a runtime directory the daemon owns",
        unit.replace(/^RuntimeDirectory=.*$/m, "RuntimeDirectory=turbopanel"),
      ],
      ["no runtime directory mode", drop(/^RuntimeDirectoryMode=.*\n/m)],
      [
        "a world-traversable runtime directory",
        unit.replace(/^RuntimeDirectoryMode=.*$/m, "RuntimeDirectoryMode=0755"),
      ],
      [
        "a privileged pre-start",
        unit.replace("[Service]", "[Service]\nExecStartPre=+/bin/true"),
      ],
    ];
    for (const [label, content] of hostile) {
      assertEquals(content === unit, false, `${label}: corpus did not change`);
      await refusedUnit(host, name, content);
    }
    // A tenant unit cannot borrow the hosting Caddy's capability.
    const tenant = cronServiceContent({
      layout,
      environmentId: "env1",
      composeServiceName: "web",
      job: {
        name: "nightly",
        schedule: "*-*-* 03:00:00",
        command: ["/bin/true"],
      } as unknown as EnvironmentDeployCronJob,
      username: "alice",
      workingDirectory: host.path("srv/users/alice/sites/web/current"),
    }).replace(
      /^AmbientCapabilities=.*$/m,
      "AmbientCapabilities=CAP_NET_BIND_SERVICE",
    );
    await refusedUnit(host, "turbopanel-cron-env1-web-nightly.service", tenant);
  });
});

test("setfacl grants tpedge the instance ACME socket and nothing else", async () => {
  await withHost(async (host) => {
    const sock = host.path("run/turbopanel/instance-acme.sock");
    const other = host.path("run/turbopanel/instance.sock");
    const listeners = [sock, other].map((path) =>
      Deno.listen({ transport: "unix", path })
    );
    try {
      const ok = await host.run(["setfacl", "-P", "-m", "u:tpedge:rw", sock]);
      assertEquals(ok.code, 0, ok.stderr);
      assertEquals(
        ok.stdout.trim(),
        "EXEC [setfacl] [-P] [-m] [u:tpedge:rw] [--] [instance-acme.sock]",
      );
      // Another socket in the run directory, another entity or permission,
      // and the form without -P are all refused.
      await refused(host, ["setfacl", "-P", "-m", "u:tpedge:rw", other]);
      await refused(host, ["setfacl", "-P", "-m", "u:tp:rw", sock]);
      await refused(host, ["setfacl", "-P", "-m", "u:tpedge:rwx", sock]);
      await refused(host, ["setfacl", "-m", "u:tpedge:rw", sock]);
      await refused(host, ["setfacl", "-P", "-m", "g:tpedge:rw", sock]);
      // A symlink swapped in for the socket is never acted on.
      await Deno.remove(sock);
      await Deno.symlink(other, sock);
      const stderr = await refused(host, [
        "setfacl",
        "-P",
        "-m",
        "u:tpedge:rw",
        sock,
      ]);
      assertStringIncludes(stderr, "is not a socket");
    } finally {
      for (const listener of listeners) listener.close();
    }
  });
});

test("scheduled-backup units pass only in their exact shape; tenant units gain nothing", async () => {
  await withHost(async (host) => {
    const layout = resolveLayout({
      TURBOPANEL_HOME: host.path("opt/turbopanel"),
      TURBOPANEL_LIB_DIR: host.path("opt/turbopanel/lib"),
      TURBOPANEL_RUNTIMES_DIR: host.path("opt/turbopanel/vendor"),
      TURBOPANEL_CONFIG_DIR: host.path("etc/turbopanel"),
      TURBOPANEL_STATE_DIR: host.path("var/lib/turbopanel"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: host.path("srv/users"),
    }, { forceMode: "production" });
    const serviceName = `turbopanel-backup-${BACKUP_ID}.service`;
    const timerName = `turbopanel-backup-${BACKUP_ID}.timer`;
    const service = backupServiceContent(layout, BACKUP_ID);
    const timer = backupTimerContent(BACKUP_ID, "*-*-* 03:00:00");

    // The daemon's own rendering passes, including a sub-hourly timer with
    // its tightened accuracy.
    const frequentTimer = backupTimerContent(BACKUP_ID, "*-*-* *:0/2:00");
    for (
      const [name, content] of [
        [serviceName, service],
        [timerName, timer],
        [timerName, frequentTimer],
      ]
    ) {
      const result = await installUnit(host, name, content);
      assertEquals(result.code, 0, `${name}: ${result.stderr}`);
    }

    const wrapper = `${host.path("opt/turbopanel/lib")}/tp-backup-run`;
    const hostileServices: Array<[string, string]> = [
      [
        "another policy's id in ExecStart",
        service.replace(
          `tp-backup-run ${BACKUP_ID}`,
          `tp-backup-run ${OTHER_BACKUP_ID}`,
        ),
      ],
      [
        "a second ExecStart",
        service.replace(
          "NoNewPrivileges=yes",
          `ExecStart=${wrapper} ${BACKUP_ID}\nNoNewPrivileges=yes`,
        ),
      ],
      ["a different binary", service.replace(wrapper, "/bin/sh")],
      [
        "an extra argument",
        service.replace(`${BACKUP_ID}\nNoNew`, `${BACKUP_ID} --x\nNoNew`),
      ],
      ["runs as root", service.replace("User=tp", "User=root")],
      ["root group", service.replace("Group=tp", "Group=root")],
      ["another service account", service.replace("User=tp", "User=tpnginx")],
      [
        "a principal instead of the daemon",
        service.replace("User=tp", "User=alice").replace(
          "Group=tp",
          "Group=alice",
        ),
      ],
      [
        "an Environment= line",
        service.replace(
          "NoNewPrivileges=yes",
          "Environment=DENO_DIR=/tmp\nNoNewPrivileges=yes",
        ),
      ],
      [
        "another EnvironmentFile",
        service.replace(
          /^EnvironmentFile=.*$/m,
          "EnvironmentFile=/tmp/steer.env",
        ),
      ],
      ["a raised priority", service.replace("Nice=10", "Nice=-20")],
      [
        "realtime IO",
        service.replace("IOSchedulingClass=idle", "IOSchedulingClass=realtime"),
      ],
      [
        "a slice",
        service.replace(
          "NoNewPrivileges=yes",
          "Slice=turbopanel-alice.slice\nNoNewPrivileges=yes",
        ),
      ],
      [
        "a reload command",
        service.replace(
          "NoNewPrivileges=yes",
          `ExecReload=${wrapper} ${BACKUP_ID}\nNoNewPrivileges=yes`,
        ),
      ],
      [
        "no NoNewPrivileges",
        service.replace("NoNewPrivileges=yes", "NoNewPrivileges=no"),
      ],
      [
        "capabilities",
        service.replace(
          "AmbientCapabilities=",
          "AmbientCapabilities=CAP_SYS_ADMIN",
        ),
      ],
      [
        "a privileged exec prefix",
        service.replace("ExecStart=", "ExecStart=+"),
      ],
      [
        "a line continuation that hides User=",
        service.replace("User=tp", "SyslogIdentifier=x \\\nUser=tp"),
      ],
    ];
    for (const [label, content] of hostileServices) {
      assertEquals(
        content === service,
        false,
        `fixture did not change: ${label}`,
      );
      await refusedUnit(host, serviceName, content);
    }

    // The timer may start only its own service.
    for (
      const other of [
        `turbopanel-backup-${OTHER_BACKUP_ID}.service`,
        "turbopanel-hosting-caddy.service",
      ]
    ) {
      await refusedUnit(
        host,
        timerName,
        timer.replace(/^Unit=.*$/m, `Unit=${other}`),
      );
    }

    // The prefix is reserved: only an exact lower-case uuid name gets the
    // backup check, and anything else under it is refused outright.
    for (
      const name of [
        `turbopanel-backup-${BACKUP_ID.toUpperCase()}.service`,
        "turbopanel-backup-nightly.service",
        `turbopanel-backup-${BACKUP_ID}x.service`,
        `turbopanel-backup-${BACKUP_ID}.slice`,
        "turbopanel-backup-../x",
      ]
    ) {
      await refusedUnit(host, name, service);
    }

    // A tenant unit cannot borrow the backup-only directives.
    const job = {
      name: "nightly",
      schedule: "*-*-* 03:00:00",
      command: ["/usr/bin/php8.4", "artisan", "schedule:run"],
    } as unknown as EnvironmentDeployCronJob;
    const cron = cronServiceContent({
      layout,
      environmentId: "env1",
      composeServiceName: "web",
      job,
      username: "alice",
      workingDirectory: host.path("srv/users/alice/sites/web/current"),
    });
    const cronName = "turbopanel-cron-env1-web-nightly.service";
    assertEquals((await installUnit(host, cronName, cron)).code, 0);
    for (
      const line of [
        `EnvironmentFile=-${host.path("etc/turbopanel")}/daemon.env`,
        "Nice=10",
        "IOSchedulingClass=idle",
      ]
    ) {
      await refusedUnit(
        host,
        cronName,
        cron.replace("NoNewPrivileges=yes", `${line}\nNoNewPrivileges=yes`),
      );
    }
    // And the backup shape is not a way to run as the daemon under a tenant name.
    await refusedUnit(host, cronName, service);
  });
});

test("numeric owner and group ids resolve to the same accounts the name checks allow", async () => {
  await withHost(async (host) => {
    // The daemon rewrites instance/runtime.env keeping the file's numeric
    // owner (Admin → Hostnames → Apply): `install -o 0 -g 9999` must mean
    // root:tp, exactly as the names would.
    await Deno.mkdir(host.path("etc/turbopanel/instance"), { recursive: true });
    const env = host.path("etc/turbopanel/instance/runtime.env");
    const ok = await host.run([
      "install",
      "-m",
      "0640",
      "-o",
      "0",
      "-g",
      "9999",
      host.path("tmp/staged"),
      env,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(ok.stdout, "EXEC [chown] [-h] [--] [root:tp] [./f]");
    assertEquals(await Deno.readTextFile(env), "staged content\n");

    // A principal's own ids on its own home, as names would be.
    const sites = host.path("srv/users/alice/home");
    await Deno.mkdir(sites);
    const mine = await host.run(["chown", "15001:15001", sites]);
    assertEquals(mine.code, 0, mine.stderr);
    assertStringIncludes(
      mine.stdout,
      "EXEC [chown] [-h] [--] [alice:alice] [./home]",
    );

    const staged = host.path("tmp/staged");
    // An id with no account, or one only a name the checks refuse maps to.
    await refused(host, ["install", "-m", "0640", "-o", "1000", staged, env]);
    await refused(host, ["install", "-m", "0640", "-g", "27", staged, env]);
    // A principal's uid is not a service account on the managed tree.
    await refused(host, ["install", "-m", "0640", "-o", "15001", staged, env]);
    // Leading zeros and over-long ids are not ids.
    await refused(host, ["install", "-m", "0640", "-o", "00", staged, env]);
    await refused(host, ["install", "-m", "0640", "-g", "09999", staged, env]);
    await refused(host, [
      "install",
      "-m",
      "0640",
      "-o",
      "12345678901",
      staged,
      env,
    ]);
    // Another principal's ids on alice's home stay refused.
    await refused(host, ["chown", "15003", sites]);
  });
});

test("rm, chown and chmod stay inside the trees and never follow a symlink", async () => {
  await withHost(async (host) => {
    const tree = host.path("var/lib/turbopanel/deployments/scratch");
    await Deno.mkdir(tree, { recursive: true });
    await Deno.symlink(host.path("outside"), join(tree, "escape"));
    const rm = await host.run(["rm", "-rf", "--", tree]);
    assertEquals(rm.code, 0, rm.stderr);
    assertEquals(
      await Deno.readTextFile(host.path("outside/secret")),
      "root-only secret\n",
    );
    await refused(host, ["rm", "-rf", "--", host.path("srv/users/alice")]);
    await refused(host, ["rm", "-rf", "--", host.path("etc/turbopanel")]);
    await refused(host, ["rm", "-rf", "--", host.path("outside")]);

    const release = host.path("srv/users/alice/sites/web/releases/r1");
    await Deno.mkdir(release, { recursive: true });
    const chown = await host.run(["chown", "-R", "root:alice", release]);
    assertEquals(chown.code, 0, chown.stderr);
    assertStringIncludes(
      chown.stdout,
      "EXEC [chown] [-R] [-h] [-P] [--] [root:alice] [./r1]",
    );
    await refused(host, ["chown", "alice", host.path("etc/turbopanel")]);
    await refused(host, ["chown", "-R", "tp", host.path("outside")]);
    await refused(host, [
      "chown",
      "alice:alice",
      host.path("var/lib/turbopanel/x"),
    ]);

    await Deno.symlink(
      host.path("outside/secret"),
      host.path("var/lib/turbopanel/link"),
    );
    await refused(host, [
      "chmod",
      "0600",
      host.path("var/lib/turbopanel/link"),
    ]);
  });
});

test("root reads go through a verified descriptor, not a planted symlink", async () => {
  await withHost(async (host) => {
    const cert = host.path("var/lib/turbopanel/cert.pem");
    await Deno.symlink(host.path("outside/secret"), cert);
    const stderr = await refused(host, ["cat", "--", cert]);
    assertStringIncludes(stderr, "resolves to");
    await Deno.remove(cert);
    await Deno.writeTextFile(cert, "CERT\n");
    const ok = await host.run(["cat", "--", cert]);
    assertEquals(ok.stdout, "CERT\n");
  });
});

test("test -d answers for a real directory, never a symlink to one", async () => {
  await withHost(async (host) => {
    const release = host.path("srv/users/alice/sites/web/releases/r1");
    await Deno.mkdir(join(release, "public"), { recursive: true });
    await Deno.mkdir(host.path("srv/users/bob/sites/web/public"), {
      recursive: true,
    });
    await Deno.symlink(
      host.path("srv/users/bob/sites/web/public"),
      join(release, "linked"),
    );
    await Deno.writeTextFile(join(release, "file"), "x");
    const real = await host.run(["test", "-d", join(release, "public")]);
    assertEquals(real.code, 0, real.stderr);
    for (const name of ["linked", "file", "missing"]) {
      const answer = await host.run(["test", "-d", join(release, name)]);
      assertEquals(answer.code === 0, false, name);
    }
    // `-e` still follows the last component, as the `current` check needs.
    const exists = await host.run(["test", "-e", join(release, "linked")]);
    assertEquals(exists.code, 0, exists.stderr);
    await refused(host, ["test", "-f", join(release, "file")]);
  });
});

test("systemctl, journalctl, sysctl, ip, xtables and wg accept only the daemon's shapes", async () => {
  await withHost(async (host) => {
    const ok = await host.run([
      "systemctl",
      "enable",
      "--now",
      "turbopanel-cron-env1-web-nightly.timer",
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(
      ok.stdout,
      "EXEC [systemctl] [--no-pager] [enable] [--now]",
    );
    for (
      const args of [
        ["systemctl", "link", host.path("tmp/evil.service")],
        ["systemctl", "edit", "turbopanel-app-x.service"],
        ["systemctl", "start", "evil.service"],
        ["systemctl", "set-environment", "LD_PRELOAD=/tmp/x.so"],
        [
          "journalctl",
          "--unit=sshd",
          "-n",
          "10",
          "--no-pager",
          "--output=short-iso",
        ],
        ["sysctl", "-w", "kernel.core_pattern=|/tmp/x"],
        ["ip", "netns", "exec", "x", "/bin/sh"],
        ["ip", "link", "set", "dev", "eth0", "down"],
        ["iptables", "--modprobe=/tmp/x", "-L"],
        ["iptables-restore", host.path("outside/secret")],
        [
          "wg",
          "set",
          "tp0",
          "peer",
          "abc=",
          "private-key",
          host.path("outside/secret"),
          "x",
          "y",
        ],
        ["find", host.path("var/lib/turbopanel"), "-exec", "/bin/sh", ";"],
        ["tee", host.path("etc/sudoers.d/evil")],
        [
          "cp",
          "-a",
          "--",
          `${host.path("outside")}/.`,
          host.path("srv/users/alice/sites/web"),
        ],
      ]
    ) {
      await refused(host, args);
    }
    const sysctl = await host.run(["sysctl", "-w", "net.ipv4.ip_forward=1"]);
    assertEquals(sysctl.code, 0, sysctl.stderr);
    const empty = host.path("tmp/empty.conf");
    await Deno.writeTextFile(empty, "");
    await refused(host, ["wg", "syncconf", "tp0", empty]);
  });
});

test("accounts: only principals are created or changed, and only into registry groups", async () => {
  await withHost(async (host) => {
    const home = host.path("srv/users/carol/home");
    const add = await host.run([
      "useradd",
      "-K",
      "UID_MIN=15001",
      "-K",
      "UID_MAX=60000",
      "-g",
      "carol",
      "-d",
      home,
      "-M",
      "-s",
      "/bin/bash",
      "carol",
    ]);
    assertEquals(add.code, 0, add.stderr);
    // The id range must reach useradd: dropping it leaves login.defs in
    // charge, which on a host with a 9999 account yields uid 10000/10001.
    assertStringIncludes(
      add.stdout,
      "EXEC [useradd] [-K] [UID_MIN=15001] [-K] [UID_MAX=60000] [-g] [carol]",
    );
    const addU = await host.run([
      "useradd",
      "-u",
      "15555",
      "-g",
      "carol",
      "-d",
      home,
      "-M",
      "-s",
      "/bin/bash",
      "carol",
    ]);
    assertEquals(addU.code, 0, addU.stderr);
    assertStringIncludes(
      addU.stdout,
      "EXEC [useradd] [-u] [15555] [-g] [carol]",
    );
    for (
      const args of [
        [
          "useradd",
          "-u",
          "0",
          "-g",
          "carol",
          "-d",
          home,
          "-M",
          "-s",
          "/bin/bash",
          "carol",
        ],
        [
          "useradd",
          "-K",
          "UID_MIN=15001",
          "-K",
          "UID_MAX=60000",
          "-g",
          "carol",
          "-d",
          "/root",
          "-M",
          "-s",
          "/bin/bash",
          "carol",
        ],
        [
          "useradd",
          "-K",
          "UID_MIN=15001",
          "-K",
          "UID_MAX=60000",
          "-g",
          "tp",
          "-d",
          home,
          "-M",
          "-s",
          "/bin/bash",
          "carol",
        ],
        [
          "useradd",
          "-K",
          "UID_MIN=15001",
          "-K",
          "UID_MAX=60000",
          "-g",
          "carol",
          "-d",
          home,
          "-M",
          "-s",
          "/tmp/sh",
          "carol",
        ],
        ["usermod", "-aG", "sudo", "alice"],
        ["usermod", "-aG", "docker", "tp"],
        ["usermod", "-s", "/bin/bash", "root"],
        ["usermod", "-p", "!", "tp"],
        ["gpasswd", "-d", "alice", "alice"],
        ["getent", "shadow", "--", "root"],
        // The per-version runtime groups are gone from the registry, so a
        // principal can no longer be put in one.
        ["usermod", "-aG", "tpphp84", "alice"],
        ["usermod", "-aG", "tpnode24", "alice"],
        // The registry name is matched literally: `.` is not a wildcard.
        ["usermod", "-aG", "tps.ell", "alice"],
      ]
    ) {
      await refused(host, args);
    }
    for (
      const args of [
        ["usermod", "-aG", "tpshell", "alice"],
        ["usermod", "-aG", "tpsftp", "alice"],
        ["usermod", "-aG", "alice", "tpnginx"],
        ["gpasswd", "-d", "alice", "tpshell"],
        ["usermod", "-p", "!", "alice"],
      ]
    ) {
      const result = await host.run(args);
      assertEquals(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    }
    const hash = `$6$abcdefgh$${"A".repeat(86)}`;
    await refused(host, ["chpasswd", "-e"], `root:${hash}\n`);
    await refused(host, ["chpasswd", "-e"], `alice:${hash}\nroot:${hash}\n`);
    const pw = await host.run(["chpasswd", "-e"], `alice:${hash}\n`);
    assertEquals(pw.code, 0, pw.stderr);
  });
});

test("tp-host refuses unknown verbs and arguments with a newline", async () => {
  await withHost(async (host) => {
    await refused(host, ["bash", "-c", "id"]);
    await refused(host, ["python3", "-c", "import os"]);
    await refused(host, [
      "rm",
      "-f",
      "--",
      `${host.path("var/lib/turbopanel/x")}\nroot`,
    ]);
  });
});

test("find: every daemon-built find argv is accepted; anything else is refused", async () => {
  await withHost(async (host) => {
    // instance-acme-http01.ts: the issued certificate lookup (Let's Encrypt
    // apply polls it until the certificate appears).
    const root = host.path(
      "var/lib/turbopanel/instance-acme/caddy/certificates",
    );
    const dir = join(
      root,
      "acme-v02.api.letsencrypt.org-directory",
      "canary.example.com",
    );
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "canary.example.com.crt"), "cert\n");
    await Deno.writeTextFile(join(dir, "canary.example.com.key"), "key\n");
    const found = await host.run(
      issuedCertificateFindArgs(root, "canary.example.com"),
    );
    assertEquals(found.code, 0, found.stderr);
    assertEquals(found.stdout.trim(), join(dir, "canary.example.com.crt"));

    // site.ts: setgid on a principal's web tree.
    const webroot = host.path("srv/users/alice/sites/web/webroot");
    await Deno.mkdir(webroot, { recursive: true });
    const setgid = await host.run(setgidDirectoriesFindArgs(webroot));
    assertEquals(setgid.code, 0, setgid.stderr);

    // release-links.ts: where each link under a sealed release resolves,
    // physically — through a chain that leaves the tree and comes back.
    const release = host.path("srv/users/alice/sites/web/releases/r1");
    await Deno.mkdir(join(release, "public"), { recursive: true });
    await Deno.symlink(host.path("outside/hop"), join(release, "public/x"));
    await Deno.symlink(host.path("srv/users/bob"), host.path("outside/hop"));
    await Deno.symlink("../shared", join(release, "public/up"));
    const links = await host.run(releaseLinkTargetsFindArgs(release));
    assertEquals(links.code, 0, links.stderr);
    assertEquals(links.stdout.split("\0").filter(Boolean).sort(), [
      host.path("srv/users/alice/sites/web/releases/r1/shared"),
      host.path("srv/users/bob"),
    ]);
    const linkArgs = releaseLinkTargetsFindArgs(release);
    // Rollback: the same links with their unresolved texts, relative paths.
    const texts = await host.run(releaseLinkTextsFindArgs(release));
    assertEquals(texts.code, 0, texts.stderr);
    assertEquals(
      parseReleaseLinkTexts(texts.stdout).sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
      [
        { path: "public/up", text: "../shared" },
        { path: "public/x", text: host.path("outside/hop") },
      ],
    );
    const textArgs = releaseLinkTextsFindArgs(release);

    const lookup = issuedCertificateFindArgs(root, "canary.example.com");
    for (
      const args of [
        releaseLinkTargetsFindArgs(host.path("outside")),
        releaseLinkTextsFindArgs(host.path("outside")),
        [...textArgs.slice(0, -1), "%p\\0%l\\0"],
        [...textArgs, "-quit"],
        [...linkArgs.slice(0, -1), ";"],
        linkArgs.map((arg) => arg === "realpath" ? "cat" : arg),
        [...lookup, "-print"],
        lookup.slice(0, -1),
        issuedCertificateFindArgs(root, "*.example.com"),
        issuedCertificateFindArgs(root, "../canary.example.com"),
        [...lookup.slice(0, -1), "canary.example.com.key"],
        issuedCertificateFindArgs(host.path("outside"), "canary.example.com"),
        [
          "find",
          root,
          "-mindepth",
          "2",
          "-maxdepth",
          "3",
          "-type",
          "f",
          "-name",
          "a.crt",
        ],
      ]
    ) {
      await refused(host, args);
    }
  });
});

/** Run tp_unit_meta_parse over `meta` and report the parsed fields. */
async function parseUnitMeta(meta: string) {
  const source = await Deno.readTextFile(SCRIPT);
  const start = source.indexOf("tp_unit_meta_parse() {");
  const end = source.indexOf("\n}\n", start);
  const fn = source.slice(start, end + 3);
  const script = `${fn}
if tp_unit_meta_parse "$1"; then
  printf 'ok [%s] [%s] [%s] [%s]\\n' "$_uk_user" "$_uk_group" "$_uk_slice" "$_uk_nnp"
else
  echo refused
fi`;
  const out = await new Deno.Command("sh", {
    args: ["-c", script, "sh", meta],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

test("tp-host unit metadata is parsed by key and never shifts on an empty field", async () => {
  const meta = (u: string, g: string, s: string, n: string) =>
    `user=${u}\ngroup=${g}\nslice=${s}\nnnp=${n}`;
  assertEquals(
    await parseUnitMeta(meta("a", "a", "a.slice", "yes")),
    "ok [a] [a] [a.slice] [yes]",
  );
  // Empty first, middle and last fields stay in place.
  assertEquals(
    await parseUnitMeta(meta("", "g", "s", "yes")),
    "ok [] [g] [s] [yes]",
  );
  assertEquals(
    await parseUnitMeta(meta("u", "", "s", "yes")),
    "ok [u] [] [s] [yes]",
  );
  assertEquals(
    await parseUnitMeta(meta("u", "g", "s", "")),
    "ok [u] [g] [s] []",
  );
  // The previously shifted case: empty user with the rest populated.
  assertEquals(
    await parseUnitMeta(meta("", "alice", "turbopanel-alice.slice", "yes")),
    "ok [] [alice] [turbopanel-alice.slice] [yes]",
  );
  // A value may hold `=` and a literal "-".
  assertEquals(
    await parseUnitMeta(meta("-", "a=b", "s", "yes")),
    "ok [-] [a=b] [s] [yes]",
  );
  // Malformed input is refused outright.
  for (
    const bad of [
      "user=u\ngroup=g\nslice=s\nnnp=yes\nextra=1",
      "user=u\ngroup=g\nslice=s",
      "user=u\ngroup=g\nslice=s\nnnp=yes\nuser=v",
      "user=u\ngroup=g\nslice=s\nnope=yes",
      "u\tg\ts\tyes",
      "user=u\ngroup=g\n\nslice=s\nnnp=yes",
      "",
    ]
  ) {
    assertEquals(await parseUnitMeta(bad), "refused", JSON.stringify(bad));
  }
});

test("tp-host refuses a tenant unit whose User= is empty", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path("tmp"), { recursive: true });
    const unit = [
      "[Service]",
      "User=",
      "Group=alice",
      "Slice=turbopanel-alice.slice",
      "NoNewPrivileges=yes",
      "ExecStart=/bin/true",
      "",
    ].join("\n");
    await refusedUnit(host, "turbopanel-app-alice-web.service", unit);
  });
});

/** `install -d -m MODE [-o OWNER] [-g GROUP] PATH`, the daemon's directory shape. */
function installDir(
  path: string,
  mode: string,
  owner?: string,
  group?: string,
): string[] {
  return [
    "install",
    "-d",
    "-m",
    mode,
    ...(owner === undefined ? [] : ["-o", owner]),
    ...(group === undefined ? [] : ["-g", group]),
    path,
  ];
}

test("principal home: the home root itself is still root:root", async () => {
  await withHost(async (host) => {
    const root = host.path("srv/users");
    const ok = await host.run(installDir(root, "0750", "root", "root"));
    assertEquals(ok.code, 0, ok.stderr);
    await refused(host, installDir(root, "0750", "alice", "alice"));
  });
});

test("principal home: the skeleton is root's, never group-writable, and only root:<p>", async () => {
  await withHost(async (host) => {
    const home = host.path("srv/users/alice");
    const sealed = await host.run(
      installDir(home, "0750", "root", "alice"),
    );
    assertEquals(sealed.code, 0, sealed.stderr);
    assertStringIncludes(
      sealed.stdout,
      "EXEC [chown] [-h] [--] [root:alice] [.]",
    );
    const structural = [
      home,
      `${home}/sites`,
      `${home}/volumes`,
      `${home}/sites/web`,
      `${home}/sites/web/releases`,
      `${home}/sites/web/releases/r1`,
    ];
    for (const dir of structural) {
      // The tenant owning any of these could rename root's paths below it.
      await refused(host, installDir(dir, "0750", "alice", "alice"));
      await refused(host, installDir(dir, "0750", "15001"));
      await refused(host, ["chown", "alice:alice", dir]);
      await refused(host, ["chown", "tpnginx", dir]);
      // The engines are in alice: group write is the same rename hole.
      await refused(host, installDir(dir, "0770", "root", "alice"));
      await refused(host, installDir(dir, "0752", "root", "alice"));
      await refused(host, installDir(dir, "2750", "root", "alice"));
      // Another principal's group, or an engine's, never holds the skeleton.
      await refused(host, installDir(dir, "0750", "root", "carol"));
      await refused(host, installDir(dir, "0750", "root", "tpnginx"));
    }
    await Deno.mkdir(`${home}/sites/web/releases/r1`, { recursive: true });
    await Deno.mkdir(`${home}/volumes`);
    for (const dir of structural) {
      await refused(host, ["chmod", "0770", dir]);
      await refused(host, ["chmod", "0751", dir]);
      await refused(host, ["chmod", "-R", "u=rwX,g=rX,o=", dir]);
      if (dir.endsWith("/releases/r1")) {
        // A release directory appears only through publish, sealed.
        await refused(host, installDir(dir, "0750", "root", "alice"));
        continue;
      }
      const ok = await host.run(installDir(dir, "0750", "root", "alice"));
      assertEquals(ok.code, 0, `${dir}: ${ok.stderr}`);
    }
    // Recursion from a skeleton directory would walk the tenant's leaves as
    // root; only a release (all root's) is re-owned in one sweep.
    for (const dir of structural.slice(0, 5)) {
      await refused(host, ["chown", "-R", "root:alice", dir]);
      await refused(host, ["chmod", "-R", "0750", dir]);
      await refused(host, setgidDirectoriesFindArgs(dir));
    }
    const seal = await host.run([
      "chown",
      "-R",
      "root:alice",
      `${home}/sites/web/releases/r1`,
    ]);
    assertEquals(seal.code, 0, seal.stderr);
  });
});

test("principal home: home/, data/ and tmp/ are the principal's alone, in a sealed home", async () => {
  await withHost(async (host) => {
    const home = host.path("srv/users/alice");
    await Deno.chmod(home, 0o750);
    for (const name of ["home", "data", "tmp"]) {
      const dir = `${home}/${name}`;
      const ok = await host.run(installDir(dir, "0700", "alice", "alice"));
      assertEquals(ok.code, 0, ok.stderr);
      assertEquals((await Deno.lstat(dir)).isDirectory, true);
      assertStringIncludes(
        ok.stdout,
        "EXEC [chown] [-h] [--] [alice:alice] [.]",
      );
      // 0700: the engine accounts in alice stay out.
      await refused(host, installDir(dir, "0750", "alice", "alice"));
      await refused(host, installDir(dir, "0701", "alice", "alice"));
      await refused(host, ["chmod", "0770", dir]);
      await refused(host, ["chmod", "u=rwX,g=rX,o=", dir]);
      await refused(host, ["chmod", "-R", "u=rwX,g=rX,o=", dir]);
      // Nobody else owns them: not root, an engine, or another principal.
      await refused(host, installDir(dir, "0700", "tpnginx", "alice"));
      await refused(host, installDir(dir, "0700", "alice", "carol"));
      await refused(host, installDir(dir, "0700", "alice", "tpnginx"));
      await refused(host, ["chown", "root", dir]);
    }
    // The principal still owns the leaves of its sites and volumes.
    for (
      const leaf of ["sites/web/shared", "sites/web/webroot", "volumes/v1"]
    ) {
      const ok = await host.run(
        installDir(`${home}/${leaf}`, "0750", "alice", "alice"),
      );
      assertEquals(ok.code, 0, `${leaf}: ${ok.stderr}`);
    }
  });
});

test("principal home: a planted link or an unsealed parent stops the tenant directories", async () => {
  await withHost(async (host) => {
    const home = host.path("srv/users/alice");
    const outside = host.path("outside");
    await Deno.chmod(outside, 0o755);
    // home/ planted as a link to somewhere else: never created or re-owned
    // through it.
    await Deno.symlink(outside, `${home}/home`);
    await refused(
      host,
      installDir(`${home}/home`, "0700", "alice", "alice"),
    );
    assertEquals((await Deno.stat(outside)).mode! & 0o777, 0o755);
    await refused(host, ["chmod", "0700", `${home}/home`]);
    // A group-writable home lets anyone in the group rename home/ away.
    await Deno.chmod(home, 0o770);
    const stderr = await refused(
      host,
      installDir(`${home}/data`, "0700", "alice", "alice"),
    );
    assertStringIncludes(stderr, "not sealed");
    await refused(
      host,
      installDir(`${home}/sites`, "0750", "root", "alice"),
    );
    await Deno.chmod(home, 0o750);
    const ok = await host.run(
      installDir(`${home}/data`, "0700", "alice", "alice"),
    );
    assertEquals(ok.code, 0, ok.stderr);
  });
});

test("useradd: the passwd home is <root>/<name>/home and nothing else", async () => {
  await withHost(async (host) => {
    const users = host.path("srv/users");
    const useradd = (home: string) => [
      "useradd",
      "-u",
      "15003",
      "-g",
      "carol",
      "-d",
      home,
      "-M",
      "-s",
      "/usr/sbin/nologin",
      "carol",
    ];
    const ok = await host.run(useradd(`${users}/carol/home`));
    assertEquals(ok.code, 0, ok.stderr);
    for (
      const home of [
        `${users}/carol`,
        `${users}/carol/data`,
        `${users}/carol/home/x`,
        `${users}/alice/home`,
        `${users}/carol/home/`,
        `${users}/carol/./home`,
      ]
    ) {
      await refused(host, useradd(home));
    }
  });
});

// --- per-site PHP (turbopanel-php-<siteId>) ----------------------------------

const PHP_SITE = "shop-1";
type PhpMode = "fastcgi" | "fpm" | "lsphp";
type Mutation = [label: string, mutate: (unit: string) => string];

/** A second principal and the web server groups the PHP shapes name. */
async function addPhpAccounts(host: Host) {
  for (const user of ["alice", "bob"]) {
    await Deno.mkdir(host.path(`srv/users/${user}/tmp`), { recursive: true });
  }
  await Deno.mkdir(host.path("etc/turbopanel/php/sites"), { recursive: true });
  const bob = `bob:x:15002:15002::${host.prefix}/srv/users/bob:/bin/bash\n`;
  await Deno.writeTextFile(host.path("etc/passwd"), bob, { append: true });
  await Deno.writeTextFile(
    host.path("etc/group"),
    "bob:x:15002:\ntpapache:x:9991:\ntpols:x:9992:\n",
    { append: true },
  );
}

async function withPhpHost(fn: (host: Host) => Promise<void>): Promise<void> {
  await withHost(async (host) => {
    await addPhpAccounts(host);
    await fn(host);
  });
}

function phpConfDir(host: Host, site = PHP_SITE): string {
  return host.path(`etc/turbopanel/php/sites/${site}`);
}

function phpExec(host: Host, mode: PhpMode, site = PHP_SITE): string {
  const cfg = phpConfDir(host, site);
  if (mode === "fastcgi") return `/usr/bin/php-cgi8.4 -c ${cfg}/php.ini`;
  if (mode === "fpm") {
    return `/usr/sbin/php-fpm8.4 --nodaemonize --fpm-config ${cfg}/php-fpm.conf -c ${cfg}/php.ini`;
  }
  return host.path("opt/turbopanel/vendor/lsphp/8.3/current/bin/lsphp");
}

/** The shape WP4's renderers will write for one site, per mode. */
function phpService(host: Host, mode: PhpMode): string {
  const home = host.path("srv/users/alice");
  const byMode: Record<PhpMode, string[]> = {
    fastcgi: [
      "StandardInput=socket",
      "Environment=PHP_FCGI_CHILDREN=4",
      "Environment=PHP_FCGI_MAX_REQUESTS=10000",
    ],
    fpm: [
      "Type=notify",
      "ExecReload=/bin/kill -USR2 $MAINPID",
      `RuntimeDirectory=turbopanel-php-${PHP_SITE}`,
      "RuntimeDirectoryMode=0711",
    ],
    lsphp: [
      "StandardInput=socket",
      `Environment=PHPRC=${phpConfDir(host)}/php.ini`,
      "Environment=LSAPI_CHILDREN=10",
      "Environment=LSAPI_PGRP_MAX_IDLE=15",
    ],
  };
  const socket = `turbopanel-php-${PHP_SITE}.socket`;
  return [
    "[Unit]",
    `Description=PHP for site ${PHP_SITE}`,
    ...(mode === "fpm" ? [] : [`Requires=${socket}`, `After=${socket}`]),
    "",
    "[Service]",
    `ExecStartPre=+${host.path("opt/turbopanel/lib")}/tp-php-loopback sync`,
    `ExecStart=${phpExec(host, mode)}`,
    ...byMode[mode],
    "User=alice",
    "Group=alice",
    "Slice=turbopanel-alice.slice",
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateDevices=yes",
    "IPAddressDeny=localhost link-local multicast 0.0.0.0/8 fc00::/7",
    "IPAddressAllow=127.0.0.1 127.0.0.53",
    `BindPaths=${home}/tmp:/tmp`,
    `TemporaryFileSystem=${host.path("etc/turbopanel")}:ro`,
    `BindReadOnlyPaths=${phpConfDir(host)}`,
    `ReadWritePaths=${home}/tmp ${home}/sites/${PHP_SITE}/shared`,
    "StandardOutput=journal",
    "StandardError=journal",
    "Restart=on-failure",
    "MemoryMax=512M",
    ...(mode === "fpm" ? ["", "[Install]", "WantedBy=multi-user.target"] : []),
    "",
  ].join("\n");
}

function phpSocket(name = "php.sock"): string {
  return [
    "[Unit]",
    `Description=PHP socket for site ${PHP_SITE}`,
    "",
    "[Socket]",
    `ListenStream=/run/turbopanel-php-${PHP_SITE}/${name}`,
    "SocketUser=alice",
    "SocketGroup=tpnginx",
    "SocketMode=0660",
    "DirectoryMode=0711",
    "Accept=no",
    "",
    "[Install]",
    "WantedBy=sockets.target",
    "",
  ].join("\n");
}

const phpServiceName = `turbopanel-php-${PHP_SITE}.service`;
const phpSocketName = `turbopanel-php-${PHP_SITE}.socket`;

/** Replace one whole line (`key=` prefix) or drop it with `null`. */
function line(key: string, next: string | null): (unit: string) => string {
  return (unit) => {
    const re = new RegExp(`^${key.replaceAll("$", "\\$")}.*\\n`, "m");
    if (!re.test(unit)) throw new Error(`no ${key} line`);
    return unit.replace(re, next === null ? "" : `${next}\n`);
  };
}

/** Add lines right after the section header. */
function add(section: string, ...lines: string[]): (unit: string) => string {
  return (unit) =>
    unit.replace(`[${section}]\n`, `[${section}]\n${lines.join("\n")}\n`);
}

test("per-site PHP units: each mode's pinned shape installs, with its socket", async () => {
  await withPhpHost(async (host) => {
    for (const mode of ["fastcgi", "fpm", "lsphp"] as const) {
      const result = await installUnit(
        host,
        phpServiceName,
        phpService(host, mode),
      );
      assertEquals(result.code, 0, `${mode}: ${result.stderr}`);
    }
    for (const name of ["php.sock", "lsphp.sock"]) {
      const result = await installUnit(host, phpSocketName, phpSocket(name));
      assertEquals(result.code, 0, `${name}: ${result.stderr}`);
    }
    // systemctl takes the socket and the service by name.
    const start = await host.run(["systemctl", "start", phpSocketName]);
    assertStringIncludes(
      start.stdout,
      `EXEC [systemctl] [--no-pager] [start] [${phpSocketName}]`,
    );
  });
});

test("per-site PHP services: a hostile corpus is refused in every mode", async () => {
  await withPhpHost(async (host) => {
    const home = host.path("srv/users/alice");
    const bobHome = host.path("srv/users/bob");
    const otherCfg = phpConfDir(host, "other-site");
    const common: Mutation[] = [
      ["runs as root", line("User=", "User=root")],
      ["runs as a web server account", line("User=", "User=tpnginx")],
      ["runs as another principal", line("User=", "User=bob")],
      ["root group", line("Group=", "Group=root")],
      ["web server group", line("Group=", "Group=tpnginx")],
      ["another principal's group", line("Group=", "Group=bob")],
      [
        "another principal's slice",
        line("Slice=", "Slice=turbopanel-bob.slice"),
      ],
      ["no slice", line("Slice=", null)],
      ["NoNewPrivileges=no", line("NoNewPrivileges=", "NoNewPrivileges=no")],
      ["no NoNewPrivileges", line("NoNewPrivileges=", null)],
      [
        "a bounding capability",
        line("CapabilityBoundingSet=", "CapabilityBoundingSet=CAP_SETUID"),
      ],
      [
        "an ambient capability",
        line(
          "AmbientCapabilities=",
          "AmbientCapabilities=CAP_NET_BIND_SERVICE",
        ),
      ],
      ["no CapabilityBoundingSet", line("CapabilityBoundingSet=", null)],
      ["no AmbientCapabilities", line("AmbientCapabilities=", null)],
      ["a shell instead of PHP", line("ExecStart=", "ExecStart=/bin/sh -c id")],
      [
        "a privileged exec prefix",
        (u) => u.replace("ExecStart=", "ExecStart=+"),
      ],
      [
        "an ignore-failure exec prefix",
        (u) => u.replace("ExecStart=", "ExecStart=-"),
      ],
      [
        "an extra exec argument",
        (u) => u.replace(/^(ExecStart=.*)$/m, "$1 -d auto_prepend_file=/tmp/x"),
      ],
      [
        "another site's config",
        (u) => u.replaceAll(phpConfDir(host), otherCfg),
      ],
      ["a second ExecStart", add("Service", "ExecStart=/bin/true")],
      ["an ExecStartPre", add("Service", "ExecStartPre=/bin/sh -c id")],
      ["WorkingDirectory", add("Service", "WorkingDirectory=/root")],
      ["PrivateTmp", add("Service", "PrivateTmp=yes")],
      [
        "another owner's tmp on /tmp",
        line("BindPaths=", `BindPaths=${bobHome}/tmp:/tmp`),
      ],
      ["the root on /tmp", line("BindPaths=", "BindPaths=/:/tmp")],
      ["no BindPaths", line("BindPaths=", null)],
      ["no tmpfs over the config tree", line("TemporaryFileSystem=", null)],
      [
        "a writable tmpfs",
        line(
          "TemporaryFileSystem=",
          `TemporaryFileSystem=${host.path("etc/turbopanel")}`,
        ),
      ],
      [
        "a tmpfs over the root",
        line("TemporaryFileSystem=", "TemporaryFileSystem=/:ro"),
      ],
      [
        "a tmpfs over the homes",
        line(
          "TemporaryFileSystem=",
          `TemporaryFileSystem=${host.path("srv/users")}:ro`,
        ),
      ],
      ["a second tmpfs", add("Service", "TemporaryFileSystem=/var:ro")],
      ["no config bind", line("BindReadOnlyPaths=", null)],
      [
        "another site's config bound",
        line("BindReadOnlyPaths=", `BindReadOnlyPaths=${otherCfg}`),
      ],
      [
        "the whole config tree bound",
        line(
          "BindReadOnlyPaths=",
          `BindReadOnlyPaths=${host.path("etc/turbopanel")}`,
        ),
      ],
      [
        "/etc/shadow bound",
        line("BindReadOnlyPaths=", "BindReadOnlyPaths=/etc/shadow"),
      ],
      [
        "a remapped config bind",
        line(
          "BindReadOnlyPaths=",
          `BindReadOnlyPaths=${phpConfDir(host)}:/srv`,
        ),
      ],
      [
        "a second read-only bind",
        add("Service", "BindReadOnlyPaths=/etc/shadow"),
      ],
      ["a second BindPaths", add("Service", "BindPaths=/etc:/srv/etc")],
      ["ProtectSystem=full", line("ProtectSystem=", "ProtectSystem=full")],
      ["no ProtectSystem", line("ProtectSystem=", null)],
      ["PrivateDevices=no", line("PrivateDevices=", "PrivateDevices=no")],
      ["no IPAddressDeny", line("IPAddressDeny=", null)],
      [
        "loopback left open",
        line("IPAddressDeny=", "IPAddressDeny=link-local"),
      ],
      [
        "the whole of loopback allowed back",
        line("IPAddressAllow=", "IPAddressAllow=127.0.0.0/8"),
      ],
      [
        "link-local allowed back",
        line("IPAddressAllow=", "IPAddressAllow=127.0.0.53 169.254.169.254"),
      ],
      [
        "another loopback address allowed back",
        line(
          "IPAddressAllow=",
          "IPAddressAllow=127.0.0.1 127.0.0.2 127.0.0.53",
        ),
      ],
      [
        "127.0.0.1 without the resolver stub",
        line("IPAddressAllow=", "IPAddressAllow=127.0.0.1"),
      ],
      // 127.0.0.1 is open, so the loopback guard that closes its other ports
      // must be there, exact, and the only root hook.
      ["no loopback guard", line("ExecStartPre=", null)],
      [
        "a guard without the root prefix",
        line(
          "ExecStartPre=",
          `ExecStartPre=${
            host.path("opt/turbopanel/lib")
          }/tp-php-loopback sync`,
        ),
      ],
      [
        "a root hook elsewhere",
        line("ExecStartPre=", "ExecStartPre=+/bin/sh -c true"),
      ],
      [
        "a guard with another verb",
        line(
          "ExecStartPre=",
          `ExecStartPre=+${
            host.path("opt/turbopanel/lib")
          }/tp-php-loopback flush`,
        ),
      ],
      [
        "a second root hook",
        add("Service", "ExecStartPre=+/bin/true"),
      ],
      ["a root stop hook", add("Service", "ExecStopPost=+/bin/true")],
      [
        "ULA (IPv6 metadata) left open",
        line("IPAddressDeny=", "IPAddressDeny=localhost link-local"),
      ],
      ["an allow reset", add("Service", "IPAddressAllow=any")],
      ["a second deny", add("Service", "IPAddressDeny=")],
      [
        "ReadWritePaths=/etc",
        line("ReadWritePaths=", `ReadWritePaths=${home}/tmp /etc`),
      ],
      [
        "writes into another home",
        line("ReadWritePaths=", `ReadWritePaths=${home}/tmp ${bobHome}/sites`),
      ],
      [
        "writes the whole home",
        line("ReadWritePaths=", `ReadWritePaths=${home}/tmp ${home}`),
      ],
      [
        "writes without tmp",
        line("ReadWritePaths=", `ReadWritePaths=${home}/sites`),
      ],
      [
        "a glob in ReadWritePaths",
        line("ReadWritePaths=", `ReadWritePaths=${home}/tmp ${home}/*`),
      ],
      [
        "a dot-dot in ReadWritePaths",
        line("ReadWritePaths=", `ReadWritePaths=${home}/tmp ${home}/../bob`),
      ],
      ["an empty ReadWritePaths reset", add("Service", "ReadWritePaths=")],
      ["LD_PRELOAD", add("Service", "Environment=LD_PRELOAD=/tmp/x.so")],
      [
        "two assignments in one Environment",
        add("Service", "Environment=A=1 B=2"),
      ],
      [
        "StandardOutput to the socket",
        line("StandardOutput=", "StandardOutput=socket"),
      ],
      ["a dependency on another unit", add("Unit", "Wants=emergency.target")],
      [
        "a dependency on another site",
        add("Unit", "Requires=turbopanel-php-other.socket"),
      ],
      [
        "a [Socket] section",
        (u) => `${u}\n[Socket]\nListenStream=/run/x.sock\n`,
      ],
      [
        "a line continuation",
        (u) => u.replace("User=alice", "Description=x \\\nUser=alice"),
      ],
      ["spaces around =", line("User=", "User = alice")],
    ];
    const perMode: Record<PhpMode, Mutation[]> = {
      fastcgi: [
        ["an unknown PHP series", (u) => u.replace("php-cgi8.4", "php-cgi9.1")],
        [
          "a patch-level series",
          (u) => u.replace("php-cgi8.4", "php-cgi8.4.1"),
        ],
        [
          "PHPRC on FastCGI",
          add("Service", `Environment=PHPRC=${phpConfDir(host)}/php.ini`),
        ],
        [
          "a non-numeric child count",
          line(
            "Environment=PHP_FCGI_CHILDREN",
            "Environment=PHP_FCGI_CHILDREN=4x",
          ),
        ],
        ["no StandardInput=socket", line("StandardInput=", null)],
        ["Type=notify", add("Service", "Type=notify")],
        [
          "a runtime directory in /run/turbopanel",
          add("Service", "RuntimeDirectory=turbopanel"),
        ],
        [
          "started at boot",
          (u) => `${u}\n[Install]\nWantedBy=multi-user.target\n`,
        ],
      ],
      fpm: [
        ["Type=simple", line("Type=", "Type=simple")],
        ["no Type", line("Type=", null)],
        [
          "php-fpm allowed to run as root (-R)",
          (u) => u.replace("--nodaemonize", "--nodaemonize -R"),
        ],
        [
          "a config from /tmp",
          (u) =>
            u.replace(`${phpConfDir(host)}/php-fpm.conf`, "/tmp/evil.conf"),
        ],
        [
          "a runtime directory of /run/turbopanel",
          line("RuntimeDirectory=", "RuntimeDirectory=turbopanel"),
        ],
        [
          "another site's runtime directory",
          line("RuntimeDirectory=", "RuntimeDirectory=turbopanel-php-other"),
        ],
        [
          "a world-writable runtime directory",
          line("RuntimeDirectoryMode=", "RuntimeDirectoryMode=0777"),
        ],
        ["no RuntimeDirectory", line("RuntimeDirectory=", null)],
        ["a shell reload", line("ExecReload=", "ExecReload=/bin/sh -c id")],
        ["StandardInput=socket", add("Service", "StandardInput=socket")],
        ["an environment", add("Service", "Environment=PHP_FCGI_CHILDREN=4")],
        [
          "started by another target",
          line("WantedBy=", "WantedBy=sysinit.target"),
        ],
      ],
      lsphp: [
        [
          "another site's PHPRC",
          line("Environment=PHPRC", `Environment=PHPRC=${otherCfg}/php.ini`),
        ],
        ["no PHPRC", line("Environment=PHPRC", null)],
        [
          "lsphp from outside the vendor tree",
          line("ExecStart=", "ExecStart=/usr/local/lsws/lsphp83/bin/lsphp"),
        ],
        [
          "a path through the series",
          (u) =>
            u.replace(
              "lsphp/8.3/current",
              "lsphp/8.3/../../../outside/current",
            ),
        ],
        [
          "a non-numeric LSAPI value",
          line("Environment=LSAPI_CHILDREN", "Environment=LSAPI_CHILDREN=ten"),
        ],
        ["no StandardInput=socket", line("StandardInput=", null)],
      ],
    };
    for (const mode of ["fastcgi", "fpm", "lsphp"] as const) {
      const base = phpService(host, mode);
      // The corpus means something only while the pinned shape itself passes.
      assertEquals((await installUnit(host, phpServiceName, base)).code, 0);
      for (const [label, mutate] of [...common, ...perMode[mode]]) {
        const content = mutate(base);
        assertEquals(
          content === base,
          false,
          `${mode}: ${label} changed nothing`,
        );
        const result = await installUnit(host, phpServiceName, content);
        assertEquals(result.code === 0, false, `${mode}: accepted ${label}`);
      }
    }
  });
});

test("per-site PHP units: only exact names, and the generic tenant shape gains nothing", async () => {
  await withPhpHost(async (host) => {
    const fpm = phpService(host, "fpm");
    for (
      const name of [
        "turbopanel-php-Shop.service",
        "turbopanel-php-.service",
        "turbopanel-php--x.service",
        "turbopanel-php-a.b.service",
        `turbopanel-php-${"a".repeat(65)}.service`,
        "turbopanel-php-other-site.service",
        `turbopanel-php-${PHP_SITE}.timer`,
        `turbopanel-php-${PHP_SITE}.slice`,
        "turbopanel-app-alice.socket",
      ]
    ) {
      await refusedUnit(host, name, fpm);
    }
    // A unit the generic tenant check accepts gets no php name.
    const tenant = [
      "[Service]",
      "User=alice",
      "Group=alice",
      "Slice=turbopanel-alice.slice",
      "NoNewPrivileges=yes",
      "ExecStart=/bin/sh -c id",
      "",
    ].join("\n");
    assertEquals(
      (await installUnit(host, "turbopanel-app-alice-x.service", tenant)).code,
      0,
    );
    await refusedUnit(host, phpServiceName, tenant);
  });
});

test("per-site PHP sockets: a hostile corpus is refused", async () => {
  await withPhpHost(async (host) => {
    const corpus: Mutation[] = [
      [
        "inside /run/turbopanel",
        line(
          "ListenStream=",
          `ListenStream=/run/turbopanel/php/${PHP_SITE}.sock`,
        ),
      ],
      [
        "another site's directory",
        line(
          "ListenStream=",
          "ListenStream=/run/turbopanel-php-other/php.sock",
        ),
      ],
      [
        "another file name",
        line(
          "ListenStream=",
          `ListenStream=/run/turbopanel-php-${PHP_SITE}/x.sock`,
        ),
      ],
      ["a TCP port", line("ListenStream=", "ListenStream=127.0.0.1:9000")],
      [
        "a second ListenStream",
        add(
          "Socket",
          `ListenStream=/run/turbopanel-php-${PHP_SITE}/lsphp.sock`,
        ),
      ],
      ["no ListenStream", line("ListenStream=", null)],
      ["owned by root", line("SocketUser=", "SocketUser=root")],
      ["owned by a web server", line("SocketUser=", "SocketUser=tpnginx")],
      ["group tp", line("SocketGroup=", "SocketGroup=tp")],
      ["group root", line("SocketGroup=", "SocketGroup=root")],
      ["the owner's group", line("SocketGroup=", "SocketGroup=alice")],
      [
        "the Caddy site account",
        line("SocketGroup=", "SocketGroup=tpcaddysite"),
      ],
      ["no SocketGroup", line("SocketGroup=", null)],
      ["world-writable", line("SocketMode=", "SocketMode=0666")],
      ["no SocketMode", line("SocketMode=", null)],
      [
        "a world-writable directory",
        line("DirectoryMode=", "DirectoryMode=0777"),
      ],
      ["per-connection instances", line("Accept=", "Accept=yes")],
      [
        "another service",
        add("Socket", "Service=turbopanel-app-alice.service"),
      ],
      ["an exec line", add("Socket", "ExecStartPre=/bin/sh -c id")],
      ["a FIFO", add("Socket", "ListenFIFO=/run/x")],
      ["a symlink", add("Socket", "Symlinks=/etc/turbopanel/x.sock")],
      ["a [Service] section", (u) => `${u}\n[Service]\nUser=root\n`],
      [
        "started by another target",
        line("WantedBy=", "WantedBy=multi-user.target"),
      ],
    ];
    const base = phpSocket();
    assertEquals((await installUnit(host, phpSocketName, base)).code, 0);
    for (const [label, mutate] of corpus) {
      const content = mutate(base);
      assertEquals(content === base, false, `${label} changed nothing`);
      const result = await installUnit(host, phpSocketName, content);
      assertEquals(result.code === 0, false, `accepted ${label}`);
    }
  });
});

const PHP_INI = `[PHP]
memory_limit = 256M
error_reporting = E_ALL & ~E_DEPRECATED
disable_functions = "exec,passthru,shell_exec"
session.save_path = /tmp
upload_tmp_dir = /tmp
expose_php = 0

[opcache]
opcache.enable = 1
opcache.memory_consumption = 128
opcache.validate_permission = 1
opcache.validate_root = 1
`;

function phpFpmConf(host: Host): string {
  const run = `/run/turbopanel-php-${PHP_SITE}`;
  return `[global]
error_log = syslog
daemonize = no

[${PHP_SITE}]
listen = ${run}/php.sock
listen.mode = 0660
listen.acl_users = tpnginx
pm = ondemand
pm.max_children = 20
pm.process_idle_timeout = 30s
chdir = ${host.path("srv/users/alice/sites")}/${PHP_SITE}/current
catch_workers_output = yes
clear_env = no
php_admin_value[open_basedir] = ${
    host.path("srv/users/alice/sites")
  }/${PHP_SITE}:/tmp
php_admin_value[memory_limit] = 256M
`;
}

async function installPhpConf(
  host: Host,
  name: string,
  content: string,
  opts: { mode?: string; owner?: string; group?: string } = {},
) {
  await Deno.writeTextFile(host.path("tmp/conf"), content);
  return host.run([
    "install",
    "-m",
    opts.mode ?? "0640",
    "-o",
    opts.owner ?? "root",
    "-g",
    opts.group ?? "alice",
    host.path("tmp/conf"),
    `${phpConfDir(host)}/${name}`,
  ]);
}

test("per-site PHP config: root:<owner>, 0750/0640, directives on an allowlist", async () => {
  await withPhpHost(async (host) => {
    const dir = phpConfDir(host);
    const mkdir = (
      path: string,
      mode = "0750",
      owner = "root",
      group = "alice",
    ) =>
      host.run(["install", "-d", "-m", mode, "-o", owner, "-g", group, path]);
    const made = await mkdir(dir);
    assertEquals(made.code, 0, made.stderr);
    assertStringIncludes(
      made.stdout,
      "EXEC [chown] [-h] [--] [root:alice] [.]",
    );
    for (
      const [mode, owner, group, path] of [
        ["0755", "root", "alice", dir],
        ["0770", "root", "alice", dir],
        ["0750", "alice", "alice", dir],
        ["0750", "tp", "alice", dir],
        ["0750", "root", "tpnginx", dir],
        ["0750", "root", "carol", dir],
        ["0750", "root", "alice", phpConfDir(host, "Shop")],
        ["0750", "root", "alice", `${dir}/deeper`],
        ["0755", "root", "root", host.path("etc/turbopanel/php/sites")],
      ]
    ) {
      assertEquals(
        (await mkdir(path, mode, owner, group)).code === 0,
        false,
        `${mode} ${owner}:${group} ${path}`,
      );
    }

    for (
      const [name, content] of [["php.ini", PHP_INI], [
        "php-fpm.conf",
        phpFpmConf(host),
      ]]
    ) {
      const ok = await installPhpConf(host, name, content);
      assertEquals(ok.code, 0, `${name}: ${ok.stderr}`);
      assertStringIncludes(
        ok.stdout,
        "EXEC [chown] [-h] [--] [root:alice] [./f]",
      );
      assertEquals(await Deno.readTextFile(`${dir}/${name}`), content);
      for (
        const opts of [{ mode: "0644" }, { mode: "0660" }, { owner: "alice" }, {
          owner: "tp",
        }, {
          group: "tpnginx",
        }, { group: "root" }]
      ) {
        assertEquals(
          (await installPhpConf(host, name, content, opts)).code === 0,
          false,
          JSON.stringify(opts),
        );
      }
    }
    assertEquals(
      (await installPhpConf(host, "php.ini.tpprev", PHP_INI)).code === 0,
      false,
      ".tpprev",
    );
    assertEquals(
      (await installPhpConf(host, "pool.conf", PHP_INI)).code === 0,
      false,
      "pool.conf",
    );

    const home = host.path("srv/users/alice");
    const badIni = [
      "extension = /tmp/evil.so",
      "extension = redis",
      "extension = ../curl.so",
      "extension = mysqli.so.1",
      "zend_extension = /tmp/evil.so",
      "auto_prepend_file = /tmp/x.php",
      "sendmail_path = /bin/sh -c id",
      "include_path = .:/etc",
      "[PATH=/srv/users/alice]\nmemory_limit = 1G",
      `[PATH=${host.path("srv/users/bob")}]\nmemory_limit = 1G`,
      `[PATH=${home}/sites]\nmemory_limit = 1G`,
      `[PATH=${home}/../bob]`,
      `[PATH=${home}]\nextension = /tmp/evil.so`,
      "[HOST=example.com]",
      "opcache.validate_permission = 0",
      "opcache.validate_root = Off",
      "error_log = /etc/cron.d/x",
      `session.save_path = ${host.path("srv/users/bob/tmp")}`,
      "session.save_path = 2;/tmp",
      "upload_tmp_dir = /tmp/../etc",
      "open_basedir = /",
      `open_basedir = ${home}:/etc`,
      "memory_limit = ${HOME}",
      "memory_limit = `id`",
      'memory_limit = "1G" ; x',
      "extension_dir = /tmp",
      // The edges of the new extension allowlist: a path, a near-name, a
      // module the vendored lsphp does not ship, a second zend extension,
      // and extension directories that only look like the allowed ones.
      "extension = /usr/lib/php/x/curl.so",
      "extension = curl.so.so",
      "extension = curlx",
      "extension = pdo_pgsql",
      "zend_extension = /usr/lib/php/20240924/opcache.so",
      "zend_extension = xdebug.so",
      "extension_dir = /usr/lib/php/20240924x",
      "extension_dir = /usr/lib/php/20240924/../../../tmp",
      `extension_dir = ${host.path("opt/turbopanel/vendor/lsphp-evil")}`,
      `extension_dir = ${
        host.path("opt/turbopanel/vendor/lsphp/8.4/../../../../tmp")
      }`,
      "no equals sign",
    ];
    for (const bad of badIni) {
      assertEquals(
        (await installPhpConf(host, "php.ini", `${PHP_INI}${bad}\n`)).code ===
          0,
        false,
        bad,
      );
    }
    // A detached lsphp ini names the vendored modules itself (PHPRC replaces
    // the php.ini next to the binary).
    const lsphpExt = host.path(
      "opt/turbopanel/vendor/lsphp/8.4/current/lib/php/ext",
    );
    const lsphpIni = [
      `extension_dir = ${lsphpExt}`,
      "zend_extension = opcache.so",
      "extension = curl.so",
      "extension = mysqli.so",
      "extension = pdo_mysql",
      "extension = pgsql.so",
      "extension = pdo_pgsql",
    ].join("\n");
    const lsphp = await installPhpConf(
      host,
      "php.ini",
      `${PHP_INI}${lsphpIni}\n`,
    );
    assertEquals(lsphp.code, 0, lsphp.stderr);

    const fpm = phpFpmConf(host);
    const badFpm: Mutation[] = [
      ["user", add(PHP_SITE, "user = root")],
      ["group", add(PHP_SITE, "group = root")],
      ["listen.owner", add(PHP_SITE, "listen.owner = tpnginx")],
      ["listen.group", add(PHP_SITE, "listen.group = tpnginx")],
      [
        "a socket in /run/turbopanel",
        line("listen = ", `listen = /run/turbopanel/php/8.4/${PHP_SITE}.sock`),
      ],
      ["a TCP listener", line("listen = ", "listen = 127.0.0.1:9000")],
      [
        "a second listen",
        add(PHP_SITE, "listen = /run/turbopanel-php-shop-1/php.sock"),
      ],
      [
        "the daemon on the ACL",
        line("listen.acl_users", "listen.acl_users = tp"),
      ],
      ["a world-writable socket", line("listen.mode", "listen.mode = 0666")],
      ["include", add("global", "include = /etc/turbopanel/*.conf")],
      ["chroot", add(PHP_SITE, "chroot = /")],
      ["prefix", add(PHP_SITE, "prefix = /")],
      [
        "another pool",
        (u) => `${u}[other]\nlisten = /run/turbopanel-php-other/php.sock\n`,
      ],
      ["a second pool for the site", (u) => `${u}[${PHP_SITE}]\npm = static\n`],
      [
        "an admin value off the list",
        add(PHP_SITE, "php_admin_value[auto_prepend_file] = /tmp/x.php"),
      ],
      ["an extension", add(PHP_SITE, "php_admin_value[extension] = /tmp/x.so")],
      ["env[]", add(PHP_SITE, "env[LD_PRELOAD] = /tmp/x.so")],
      ["a slowlog outside the home", add(PHP_SITE, "slowlog = /etc/x")],
      ["an error log in /var/log", line("error_log", "error_log = /var/log/x")],
      ["an error log in /tmp", line("error_log", "error_log = /tmp/fpm.log")],
      [
        "an error log on stderr",
        line("error_log", "error_log = /proc/self/fd/2"),
      ],
      [
        "an error log in the runtime directory",
        line(
          "error_log",
          `error_log = /run/turbopanel-php-${PHP_SITE}/fpm.log`,
        ),
      ],
      ["an access log in /tmp", add(PHP_SITE, "access.log = /tmp/x")],
      ["daemonize", line("daemonize", "daemonize = yes")],
      ["rlimit_core", add(PHP_SITE, "rlimit_core = unlimited")],
      ["process.dumpable", add(PHP_SITE, "process.dumpable = yes")],
      ["a variable", line("pm.max_children", "pm.max_children = ${pool}")],
      ["a status listener", add(PHP_SITE, "pm.status_listen = 0.0.0.0:9000")],
      ["an unlisted pm key", add(PHP_SITE, "pm.unknown = 1")],
      ["chdir outside the home", line("chdir", "chdir = /etc")],
    ];
    for (const [label, mutate] of badFpm) {
      const content = mutate(fpm);
      assertEquals(content === fpm, false, `${label} changed nothing`);
      assertEquals(
        (await installPhpConf(host, "php-fpm.conf", content)).code === 0,
        false,
        label,
      );
    }
  });
});

test("per-site PHP config: symlinks, other verbs and the rollout copy", async () => {
  await withPhpHost(async (host) => {
    const dir = phpConfDir(host);
    const ini = `${dir}/php.ini`;
    // A symlinked site directory is never entered.
    await Deno.symlink(host.path("outside"), dir);
    await refused(host, [
      "install",
      "-d",
      "-m",
      "0750",
      "-o",
      "root",
      "-g",
      "alice",
      dir,
    ]);
    assertEquals(
      (await installPhpConf(host, "php.ini", PHP_INI)).code === 0,
      false,
      "through a symlinked dir",
    );
    await Deno.remove(dir);
    await Deno.mkdir(dir);
    // A symlink at the file is replaced, never written through.
    await Deno.symlink(host.path("outside/secret"), ini);
    assertEquals((await installPhpConf(host, "php.ini", PHP_INI)).code, 0);
    assertEquals(
      await Deno.readTextFile(host.path("outside/secret")),
      "root-only secret\n",
    );
    assertEquals((await Deno.lstat(ini)).isSymlink, false);

    const staged = host.path("tmp/staged");
    for (
      const args of [
        ["tee", ini],
        ["chmod", "0666", ini],
        ["chown", "alice:alice", ini],
        ["chown", "tp", dir],
        ["chmod", "0777", dir],
        ["cp", "-p", "--", ini, `${dir}/php-fpm.conf`],
        ["mv", "-f", "--", `${dir}/php-fpm.conf`, ini],
        ["mkdir", "-p", `${dir}/sub`],
        [
          "install",
          "-m",
          "0644",
          "-o",
          "root",
          "-g",
          "root",
          staged,
          `${dir}/x.conf`,
        ],
      ]
    ) {
      await refused(host, args, args[0] === "tee" ? "x\n" : undefined);
    }
    // The rollout: keep a copy, restore it, remove it.
    const keep = await host.run(["cp", "-p", "--", ini, `${ini}.tpprev`]);
    assertEquals(keep.code, 0, keep.stderr);
    const restore = await host.run(["mv", "-f", "--", `${ini}.tpprev`, ini]);
    assertEquals(restore.code, 0, restore.stderr);
    assertEquals(
      (await host.run(["cmp", "-s", "--", host.path("tmp/conf"), ini])).code,
      0,
    );
    assertEquals((await host.run(["rm", "-f", "--", ini])).code, 0);
    assertEquals((await host.run(["rm", "-rf", "--", dir])).code, 0);
    // Nor is a whole new php/ renamed over the one holding sites/.
    await Deno.remove(host.path("etc/turbopanel/php"), { recursive: true });
    await Deno.mkdir(host.path("etc/turbopanel/php.new/sites/shop-1"), {
      recursive: true,
    });
    await refused(host, [
      "mv",
      "-f",
      "--",
      host.path("etc/turbopanel/php.new"),
      host.path("etc/turbopanel/php"),
    ]);
  });
});

test("php-test runs the installed unit's binary on its own config, as the owner", async () => {
  await withPhpHost(async (host) => {
    const cfg = phpConfDir(host);
    const prefix =
      "EXEC [timeout] [30] [setpriv] [--reuid=15001] [--regid=15001] [--init-groups] " +
      "[--no-new-privs] [--] [env] [-i] [PATH=/usr/bin:/bin]";
    const want: Record<PhpMode, string> = {
      fastcgi: `${prefix} [/usr/bin/php-cgi8.4] [-c] [/proc/self/fd/3] [-v]`,
      fpm:
        `${prefix} [/usr/sbin/php-fpm8.4] [--test] [--fpm-config] [/proc/self/fd/4] [-c] [/proc/self/fd/3]`,
      lsphp: `${prefix} [PHPRC=/proc/self/fd/3] [${
        phpExec(host, "lsphp")
      }] [-v]`,
    };
    await refused(host, ["php-test", PHP_SITE]);
    await Deno.mkdir(cfg);
    await Deno.writeTextFile(`${cfg}/php.ini`, PHP_INI);
    await Deno.writeTextFile(`${cfg}/php-fpm.conf`, phpFpmConf(host));
    for (const mode of ["fastcgi", "fpm", "lsphp"] as const) {
      assertEquals(
        (await installUnit(host, phpServiceName, phpService(host, mode))).code,
        0,
      );
      const result = await host.run(["php-test", PHP_SITE]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(result.stdout.trim(), want[mode]);
    }
    // A config file that is a symlink is not opened for the test.
    await Deno.remove(`${cfg}/php.ini`);
    await Deno.symlink(host.path("outside/secret"), `${cfg}/php.ini`);
    await refused(host, ["php-test", PHP_SITE]);
    const unit = host.path(`etc/systemd/system/${phpServiceName}`);
    // A unit changed behind tp-host's back is checked again, not trusted.
    await Deno.writeTextFile(
      unit,
      phpService(host, "fpm").replace("User=alice", "User=root"),
    );
    await refused(host, ["php-test", PHP_SITE]);
    await Deno.remove(unit);
    await Deno.symlink(host.path("outside/secret"), unit);
    await refused(host, ["php-test", PHP_SITE]);
    for (
      const args of [["php-test"], ["php-test", "Shop"], ["php-test", "../x"], [
        "php-test",
        PHP_SITE,
        "x",
      ]]
    ) {
      await refused(host, args);
    }
  });
});

test("per-site PHP: what the daemon renders for each mode and web server passes tp-host", async () => {
  await withPhpHost(async (host) => {
    const home = host.path("srv/users/alice");
    const site = `${home}/sites/shop`;
    const combos = [
      ...(["fastcgi", "fpm"] as const).flatMap((mode) =>
        (["tpnginx", "tpapache", "tpols"] as const).map((webAccount) =>
          [mode, webAccount] as const
        )
      ),
      ["lsphp-detached", "tpols"] as const,
    ];
    for (const [mode, webAccount] of combos) {
      {
        const id = sitePhpRuntimeId(sitePhpKey("env1", "shop"), mode, "8.4");
        const spec: SitePhpRuntimeSpec = {
          id,
          mode,
          series: "8.4",
          user: "alice",
          group: "alice",
          home,
          configDir: host.path("etc/turbopanel"),
          libDir: host.path("opt/turbopanel/lib"),
          runtimesDir: host.path("opt/turbopanel/vendor"),
          webAccount,
        };
        const dir = sitePhpConfigDir(spec.configDir, id);
        const made = await host.run([
          "install",
          "-d",
          "-m",
          "0750",
          "-o",
          "root",
          "-g",
          "alice",
          dir,
        ]);
        assertEquals(made.code, 0, made.stderr);
        const configs: Array<[string, string]> = [[
          "php.ini",
          sitePhpIni(
            [
              { key: "memory_limit", value: "256M" },
              { key: "open_basedir", value: `${site}/current/public:/tmp` },
              { key: "realpath_cache_ttl", value: "0" },
              { key: "session.save_path", value: "/var/lib/php/sessions" },
            ],
            home,
            spec,
          ),
        ]];
        if (mode === "fpm") {
          configs.push([
            "php-fpm.conf",
            sitePhpFpmConf(spec, {
              pool: [{ key: "pm.max_children", value: "8" }],
              chdir: `${site}/current/public`,
            }),
          ]);
        }
        for (const [name, content] of configs) {
          await Deno.writeTextFile(host.path("tmp/conf"), content);
          const put = await host.run([
            "install",
            "-m",
            "0640",
            "-o",
            "root",
            "-g",
            "alice",
            host.path("tmp/conf"),
            `${dir}/${name}`,
          ]);
          assertEquals(put.code, 0, `${mode} ${name}: ${put.stderr}`);
        }
        if (mode !== "fpm") {
          const socket = await installUnit(
            host,
            sitePhpSocketName(id),
            sitePhpSocketUnit(spec),
          );
          assertEquals(socket.code, 0, socket.stderr);
        }
        const service = await installUnit(
          host,
          sitePhpServiceName(id),
          sitePhpServiceUnit(spec, {
            writablePaths: [`-${site}/shared`, `-${site}/webroot`],
          }),
        );
        assertEquals(
          service.code,
          0,
          `${mode} ${webAccount}: ${service.stderr}`,
        );
        const tested = await host.run(["php-test", id]);
        assertEquals(tested.code, 0, tested.stderr);
      }
    }
  });
});

test("one site is bound to one owner across its service, socket and config", async () => {
  await withPhpHost(async (host) => {
    assertEquals(
      (await installUnit(host, phpServiceName, phpService(host, "fastcgi")))
        .code,
      0,
    );
    // The service names alice; a socket for the same site owned by bob and a
    // config group of bob's are all refused.
    const other = phpSocket().replace("SocketUser=alice", "SocketUser=bob");
    assertEquals(
      (await installUnit(host, phpSocketName, other)).code === 0,
      false,
    );
    assertEquals((await installUnit(host, phpSocketName, phpSocket())).code, 0);
    await refused(host, [
      "install",
      "-d",
      "-m",
      "0750",
      "-o",
      "root",
      "-g",
      "bob",
      phpConfDir(host),
    ]);
  });
});

// --- sftp-chroot ---------------------------------------------------------------

/** Put alice on the new layout (root-owned 0750 home, home/, passwd home). */
async function newLayoutAlice(host: Host, groups: string[] = []) {
  await Deno.mkdir(host.path("srv/users/alice/home"), { recursive: true });
  await Deno.chmod(host.path("srv/users/alice"), 0o750);
  const passwd = await Deno.readTextFile(host.path("etc/passwd"));
  await Deno.writeTextFile(
    host.path("etc/passwd"),
    passwd.replace(
      `${host.prefix}/srv/users/alice:`,
      `${host.prefix}/srv/users/alice/home:`,
    ),
  );
  const group = await Deno.readTextFile(host.path("etc/group"));
  await Deno.writeTextFile(
    host.path("etc/group"),
    group.replace("tpsftp:x:9986:", "tpsftp:x:9986:alice") +
      groups.join("\n") + (groups.length > 0 ? "\n" : ""),
  );
}

const SWITCH = "etc/ssh/turbopanel-sftp-chroot";

test("sftp-chroot switches on only when every tpsftp member is on the new layout", async () => {
  await withHost(async (host) => {
    await newLayoutAlice(host);
    assertEquals((await host.run(["sftp-chroot", "status"])).stdout, "off\n");
    const check = await host.run(["sftp-chroot", "check"]);
    assertEquals(check.code, 0, check.stdout + check.stderr);

    const on = await host.run(["sftp-chroot", "on"]);
    assertEquals(on.code, 0, on.stderr);
    assertEquals(await Deno.readTextFile(host.path(SWITCH)), "on\n");
    assertStringIncludes(on.stdout, "EXEC [chown] [-h] [--] [root:root] [./f]");
    // The status names the root it validated, for the daemon to render.
    assertEquals(
      (await host.run(["sftp-chroot", "status"])).stdout,
      `on ${host.path("srv/users")}\n`,
    );
    const verify = await host.run(["sftp-chroot", "verify"]);
    assertEquals(verify.code, 0, verify.stderr);
    assertStringIncludes(
      verify.stderr,
      "EXEC [/usr/sbin/sshd] [-T] [-C] [user=alice,host=localhost,addr=127.0.0.1]",
    );

    // Off is the rollback and is never gated.
    assertEquals((await host.run(["sftp-chroot", "off"])).code, 0);
    assertEquals((await host.run(["sftp-chroot", "status"])).stdout, "off\n");
  });
});

test("sftp-chroot refuses a member still on the tenant-owned layout", async () => {
  await withHost(async (host) => {
    // The fixture's alice: passwd home is the home root, no home/ inside it.
    const group = await Deno.readTextFile(host.path("etc/group"));
    await Deno.writeTextFile(
      host.path("etc/group"),
      group.replace("tpsftp:x:9986:", "tpsftp:x:9986:alice"),
    );
    const check = await host.run(["sftp-chroot", "check"]);
    assertEquals(check.code === 0, false);
    assertStringIncludes(check.stdout, "alice: passwd home is not");
    assertStringIncludes(
      check.stdout,
      "/srv/users/alice/home is not a directory",
    );

    const stderr = await refused(host, ["sftp-chroot", "on"]);
    assertStringIncludes(stderr, "refusing to switch on");
    await Deno.stat(host.path(SWITCH)).then(
      () => {
        throw new Error("switch written despite the refusal");
      },
      () => {},
    );
  });
});

test("sftp-chroot refuses a home or parent sshd would reject as a chroot", async () => {
  await withHost(async (host) => {
    await newLayoutAlice(host);
    await Deno.chmod(host.path("srv/users/alice"), 0o770);
    let check = await host.run(["sftp-chroot", "check"]);
    assertStringIncludes(
      check.stdout,
      "alice: " + host.path("srv/users/alice") + " is not a root-owned",
    );

    await Deno.chmod(host.path("srv/users/alice"), 0o750);
    await Deno.chmod(host.path("srv/users"), 0o757);
    check = await host.run(["sftp-chroot", "check"]);
    assertStringIncludes(
      check.stdout,
      host.path("srv/users") + ": not a root-owned",
    );
    assertEquals(check.code === 0, false);
  });
});

test("sftp-chroot refuses a member that also holds the shell level", async () => {
  await withHost(async (host) => {
    await newLayoutAlice(host, ["tpshell:x:9985:alice"]);
    const check = await host.run(["sftp-chroot", "check"]);
    assertEquals(check.code === 0, false);
    assertStringIncludes(check.stdout, "alice: in both tpsftp and tpshell");
  });
});

test("sftp-chroot accepts only check, on, off and status", async () => {
  await withHost(async (host) => {
    for (
      const args of [[], ["enable"], ["on", "now"], ["status", "-v"], [
        "--",
        "on",
      ]]
    ) {
      await refused(host, ["sftp-chroot", ...args]);
    }
  });
});

test("only sftp-chroot on and off can write or remove the switch", async () => {
  await withHost(async (host) => {
    const sw = host.path(SWITCH);
    await refused(host, [
      "install",
      "-m",
      "0644",
      "-o",
      "root",
      "-g",
      "root",
      host.path("tmp/staged"),
      sw,
    ]);
    await refused(host, ["tee", sw], "on\n");
    await Deno.writeTextFile(sw, "on\n");
    await refused(host, ["rm", "-f", "--", sw]);
    await refused(host, ["cat", "--", sw]);
  });
});

test("sftp-chroot verify refuses while the switch is off", async () => {
  await withHost(async (host) => {
    await newLayoutAlice(host);
    const stderr = await refused(host, ["sftp-chroot", "verify"]);
    assertStringIncludes(stderr, "needs the switch on");
  });
});

test("sftp-chroot checks an account whose primary group is tpsftp", async () => {
  await withHost(async (host) => {
    await newLayoutAlice(host);
    const passwd = await Deno.readTextFile(host.path("etc/passwd"));
    await Deno.writeTextFile(
      host.path("etc/passwd"),
      passwd + `dave:x:15004:9986::${host.prefix}/srv/users/dave:/bin/sh\n`,
    );
    const check = await host.run(["sftp-chroot", "check"]);
    assertEquals(check.code === 0, false);
    assertStringIncludes(check.stdout, "dave: passwd home is not");
    assertEquals(check.stdout.includes("alice:"), false, check.stdout);
  });
});

async function selfSignedCert(
  dir: string,
  host: string,
  days: number,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const made = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${host}`,
      "-days",
      String(days),
      "-keyout",
      join(dir, `${host}.key`),
      "-out",
      join(dir, `${host}.crt`),
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(made.success, true);
}

test("cert-dates prints only notAfter dates, skips internal certs, symlinks and takes no arguments", async () => {
  await withHost(async (host) => {
    const passwd = await Deno.readTextFile(host.path("etc/passwd"));
    await Deno.writeTextFile(
      host.path("etc/passwd"),
      passwd + `tpedge:x:${Deno.uid}:${Deno.gid}::/nonexistent:/bin/false\n`,
    );
    const group = await Deno.readTextFile(host.path("etc/group"));
    await Deno.writeTextFile(
      host.path("etc/group"),
      group + `tpedge:x:${Deno.gid}:\n`,
    );
    const certs = host.path(
      "var/lib/turbopanel-hosting-caddy/data/caddy/certificates",
    );
    await selfSignedCert(
      join(certs, "acme-v02.api.letsencrypt.org-directory", "shop.example.com"),
      "shop.example.com",
      30,
    );
    await selfSignedCert(
      join(certs, "local", "intranet.test"),
      "intranet.test",
      10,
    );
    await Deno.symlink(
      host.path("outside"),
      join(certs, "acme-v02.api.letsencrypt.org-directory", "linked"),
    );
    const result = await host.run(["cert-dates"]);
    assertEquals(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assertEquals(lines.length, 1, result.stdout);
    assertEquals(
      /^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4} GMT$/.test(lines[0]!),
      true,
      lines[0],
    );
    assertEquals(result.stdout.includes("example.com"), false);
    await refused(host, ["cert-dates", "x"]);
  });
});

test("cert-dates prints nothing when the hosting Caddy has issued no certificates", async () => {
  await withHost(async (host) => {
    const result = await host.run(["cert-dates"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout, "");
  });
});

test("site-caddy-mounts lists only the nosymfollow mounts under the home root, and nothing when the unit is down", async () => {
  await withHost(async (host) => {
    // No unit, no answer.
    const down = await host.run(["site-caddy-mounts"]);
    assertEquals(down.code, 0, down.stderr);
    assertEquals(down.stdout, "");

    const homes = host.path("srv/users");
    const procs = host.path(
      "sys/fs/cgroup/system.slice/turbopanel-site-caddy.service",
    );
    await Deno.mkdir(procs, { recursive: true });
    await Deno.writeTextFile(join(procs, "cgroup.procs"), "4242\n4243\n");
    await Deno.mkdir(host.path("proc/4242"), { recursive: true });
    const line = (mp: string, opts: string) =>
      `36 35 8:1 /x ${mp} ${opts} shared:1 - ext4 /dev/sda1 rw`;
    await Deno.writeTextFile(
      host.path("proc/4242/mountinfo"),
      [
        line(`${homes}/alice/sites/web/webroot`, "ro,nosuid,nodev,nosymfollow"),
        line(`${homes}/alice/sites/web/releases`, "ro,nosymfollow"),
        // Not nosymfollow, or not under the home root: never reported.
        line(`${homes}/alice/sites/other/webroot`, "ro,nosuid"),
        line("/srv/elsewhere/webroot", "ro,nosymfollow"),
        line(`${homes}x/alice/webroot`, "ro,nosymfollow"),
      ].join("\n") + "\n",
    );
    const up = await host.run(["site-caddy-mounts"]);
    assertEquals(up.code, 0, up.stderr);
    assertEquals(up.stdout.trim().split("\n"), [
      `${homes}/alice/sites/web/webroot`,
      `${homes}/alice/sites/web/releases`,
    ]);
    await refused(host, ["site-caddy-mounts", "/etc"]);
  });
});

test("site-usage prints home and site sizes only, never follows a symlink and takes no arguments", async () => {
  await withHost(async (host) => {
    const sites = host.path("srv/users/alice/sites");
    await Deno.mkdir(join(sites, "web"), { recursive: true });
    await Deno.writeFile(join(sites, "web", "blob"), new Uint8Array(200_000));
    await Deno.mkdir(join(sites, "tiny"), { recursive: true });
    await Deno.writeTextFile(join(sites, "tiny", "a"), "x");
    await Deno.mkdir(host.path("outside/big"), { recursive: true });
    await Deno.writeFile(
      host.path("outside/big/huge"),
      new Uint8Array(5_000_000),
    );
    await Deno.symlink(host.path("outside/big"), join(sites, "escape"));
    await Deno.symlink(host.path("outside"), host.path("srv/users/mallory"));
    const result = await host.run(["site-usage"]);
    assertEquals(result.code, 0, result.stderr);
    const rows = result.stdout.trim().split("\n").map((l) => l.split(" "));
    const bytes = (kind: string, name: string) =>
      Number(rows.find((r) => r[0] === kind && r[2] === name)?.[1]);
    assertEquals(bytes("site", "web") >= 200_000, true, result.stdout);
    assertEquals(bytes("site", "web") < 400_000, true, result.stdout);
    assertEquals(bytes("home", "alice") >= bytes("site", "web"), true);
    assertEquals(rows.some((r) => r[2] === "escape"), false, result.stdout);
    assertEquals(rows.some((r) => r[2] === "mallory"), false, result.stdout);
    assertEquals(
      rows.every((r) => r.length === 3 && /^\d+$/.test(r[1]!)),
      true,
    );
    // One walk per home: each home and each site appears exactly once.
    assertEquals(
      rows.filter((r) => r[0] === "home" && r[2] === "alice").length,
      1,
    );
    assertEquals(
      rows.filter((r) => r[0] === "site" && r[2] === "web").length,
      1,
    );
    const script = await Deno.readTextFile(
      new URL("../../orchestration/scripts/tp-host", import.meta.url),
    );
    assertEquals(/ionice -c3 nice -n 19 du /.test(script), true);
    assertEquals(
      /timeout -k 5 "\$TP_SITE_USAGE_HOME_SECONDS"/.test(script),
      true,
    );
    await refused(host, ["site-usage", "/etc"]);
  });
});

test("sshd accepts -t, -T and exactly -T -C user=<name>,host=localhost,addr=127.0.0.1", async () => {
  await withHost(async (host) => {
    for (const argv of [["-t"], ["-T"]]) {
      const ok = await host.run(["sshd", ...argv]);
      assertEquals(ok.code, 0, ok.stderr);
    }
    const spec = "user=alice,host=localhost,addr=127.0.0.1";
    const ok = await host.run(["sshd", "-T", "-C", spec]);
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(
      ok.stdout,
      `EXEC [/usr/sbin/sshd] [-T] [-C] [${spec}]`,
    );
  });
});

test("sshd -T -C refuses anything but the one fixed spec", async () => {
  await withHost(async (host) => {
    const tail = ",host=localhost,addr=127.0.0.1";
    for (
      const argv of [
        ["-T", "-C", "user=alice,host=localhost,addr=127.0.0.1,laddr=1.2.3.4"],
        ["-T", "-C", "user=alice,host=localhost"],
        ["-T", "-C", "host=localhost,addr=127.0.0.1,user=alice"],
        ["-T", "-C", "user=alice,addr=127.0.0.1,host=localhost"],
        ["-T", "-C", "user=alice,host=example.com,addr=127.0.0.1"],
        ["-T", "-C", "user=alice,host=localhost,addr=10.0.0.1"],
        ["-T", "-C", "user=,host=localhost,addr=127.0.0.1"],
        ["-T", "-C", `user=-oProxyCommand=x${tail}`],
        ["-T", "-C", `user=-x${tail}`],
        ["-T", "-C", `user=a b${tail}`],
        ["-T", "-C", `user=a;id${tail}`],
        ["-T", "-C", `user=a,user=b${tail}`],
        ["-T", "-C", `user=${"a".repeat(33)}${tail}`],
        ["-T", "-C", `user=a\nb${tail}`],
        ["-T", "-C", "user=alice" + tail + "\n"],
        ["-t", "-C", `user=alice${tail}`],
        ["-C", `user=alice${tail}`, "-T"],
        ["-T", "-C", `user=alice${tail}`, "-f", "/tmp/x"],
        ["-T", "-f", "/tmp/x"],
        ["-T", "-C"],
        ["-f", "/tmp/x"],
        ["-T", "-o", "AllowTcpForwarding=yes"],
        [],
      ]
    ) {
      const stderr = await refused(host, ["sshd", ...argv]);
      // Refused either by the verb or earlier, by the newline guard.
      assertEquals(
        stderr.includes("refusing") || stderr.includes("sshd: only"),
        true,
        stderr,
      );
    }
  });
});

test("php-loopback-sync runs the installed guard with sync and nothing else", async () => {
  await withHost(async (host) => {
    const ok = await host.run(["php-loopback-sync"]);
    assertEquals(ok.code, 0, ok.stderr);
    assertEquals(
      ok.stdout.trim(),
      `EXEC [${host.path("opt/turbopanel/lib")}/tp-php-loopback] [sync]`,
    );
    const extra = await host.run(["php-loopback-sync", "alice"]);
    assertEquals(extra.code, 1);
  });
});

test("the top of the config and state roots is root's: no verb removes, renames, re-owns or writes a root-owned entry there", async () => {
  await withHost(async (host) => {
    const staged = host.path("tmp/staged");
    const config = host.path("etc/turbopanel");
    const state = host.path("var/lib/turbopanel");
    await Deno.mkdir(join(config, "instance"), { recursive: true });
    await Deno.mkdir(join(state, "nginx"), { recursive: true });
    await Deno.writeTextFile(join(config, "daemon.env"), "A=1\n");

    // A root-owned regular file at the top of either root is refused,
    // whatever its name and whether or not the owner is spelled out.
    for (const dest of [join(config, "nginx.conf"), join(state, "x.json")]) {
      for (const owner of [["-o", "root", "-g", "tp"], ["-g", "tp"], []]) {
        await refused(host, ["install", "-m", "0640", ...owner, staged, dest]);
      }
    }
    await refused(host, ["tee", join(config, "daemon.env")]);

    // The daemon's own loose files are fine, owned by it.
    const loose = join(config, "firewall.v4");
    const ok = await host.run([
      "install",
      "-m",
      "0644",
      "-o",
      "tp",
      "-g",
      "tp",
      staged,
      loose,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assertEquals((await host.run(["rm", "-f", "--", loose])).code, 0);

    // Root's entries cannot be removed, renamed (either side) or re-owned.
    for (const entry of [join(config, "instance"), join(state, "nginx")]) {
      await refused(host, ["rm", "-rf", "--", entry]);
      await refused(host, ["rm", "-f", "--", entry]);
      await refused(host, ["chown", "tp:tp", entry]);
      await refused(host, ["install", "-d", "-m", "0750", "-o", "tp", entry]);
      await refused(host, ["mv", "-T", "-f", "--", entry, `${entry}-x`]);
    }
    await refused(host, [
      "mv",
      "-T",
      "-f",
      "--",
      join(config, "daemon.env"),
      join(config, "instance"),
    ]);
    await refused(host, [
      "mv",
      "-T",
      "-f",
      "--",
      join(config, "daemon.env"),
      join(config, "hosting"),
    ]);

    // The daemon's leaves stay its own to rearrange, and root's own folders
    // are still created (root-owned) by callers that need them.
    await Deno.mkdir(join(config, "hosting"), { recursive: true });
    assertEquals(
      (await host.run(["rm", "-rf", "--", join(config, "hosting")])).code,
      0,
    );
    const made = await host.run([
      "install",
      "-d",
      "-m",
      "0750",
      join(config, "instance-acme"),
    ]);
    assertEquals(made.code, 0, made.stderr);
  });
});

test("tp-host's leaf lists equal the layout tables", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  const fn = (name: string) => {
    const start = script.indexOf(`${name}() {`);
    return script.slice(start, script.indexOf("\n}\n", start));
  };
  const names = (body: string, root: string) =>
    [...body.matchAll(new RegExp(`"\\$${root}"/([A-Za-z0-9.-]+)`, "g"))]
      .map((match) => match[1]).sort();
  const leaves = fn("tp_daemon_leaf_name");
  const top = (leaf: { name: string }) => !leaf.name.includes("/");
  assertEquals(
    names(leaves, "R_CONFIG"),
    DAEMON_CONFIG_LEAVES.filter(top).map((leaf) => leaf.name).sort(),
  );
  assertEquals(
    names(leaves, "R_STATE"),
    DAEMON_STATE_LEAVES.filter(top).map((leaf) => leaf.name).sort(),
  );
});

test("iptables and ip6tables: only the options the daemon sends, in no spelling of --modprobe", async () => {
  await withHost(async (host) => {
    for (const bin of ["iptables", "ip6tables"]) {
      for (
        const args of [
          ["-w", "5", "-S", "INPUT"],
          [
            "-w",
            "5",
            "-C",
            "INPUT",
            "-p",
            "tcp",
            "--dport",
            "5432",
            "-j",
            "ACCEPT",
          ],
          [
            "-A",
            "TP-MGD-1",
            "-s",
            "203.0.113.7",
            "-p",
            "tcp",
            "-m",
            "conntrack",
            "--ctorigdst",
            "198.51.100.2",
            "--ctorigdstport",
            "5432",
            "-j",
            "ACCEPT",
          ],
          ["-I", "DOCKER-USER", "1", "-j", "TP-FORWARD"],
          ["-A", "TP-FORWARD", "-i", "tp0", "-o", "tp0", "-j", "DROP"],
          [
            "-A",
            "TP-FORWARD",
            "-m",
            "conntrack",
            "--ctstate",
            "RELATED,ESTABLISHED",
            "-j",
            "ACCEPT",
          ],
          ["-N", "TP-FORWARD"],
          ["-F", "TP-FORWARD"],
          ["-X", "TP-FORWARD"],
          ["-D", "DOCKER-USER", "-j", "TP-FORWARD"],
          ["--version"],
          ["-V"],
        ]
      ) {
        const ok = await host.run([bin, ...args]);
        assertEquals(ok.code, 0, `${bin} ${args.join(" ")}: ${ok.stderr}`);
      }
      for (
        const args of [
          ["-M/var/lib/turbopanel/spool/x", "-L"],
          ["-t", "security", "-M/x", "-L"],
          ["-nM/x", "-L"],
          ["-vM/x", "-L"],
          ["-M", "/x", "-L"],
          ["--mod=/x", "-L"],
          ["--modp", "/x", "-L"],
          ["--modprobe=/x", "-L"],
          ["--modprobe", "/x", "-L"],
          ["-s", "-M/x"],
          ["-L"],
          ["-nL"],
          ["-t", "nat", "-S"],
          ["-w5", "-S"],
          ["--table=nat", "-S"],
          ["-S", "--list"],
          ["-A", "X", "-j", "ACCEPT", "--wait=5"],
          ["-A", "X", "-m", "comment", "--comment", "x", "-j", "ACCEPT"],
        ]
      ) {
        await refused(host, [bin, ...args]);
      }
    }
  });
});

test("tenant units: output goes to the journal, never a file target", async () => {
  await withHost(async (host) => {
    const layout = resolveLayout({
      TURBOPANEL_HOME: host.path("opt/turbopanel"),
      TURBOPANEL_RUNTIMES_DIR: host.path("opt/turbopanel/vendor"),
      TURBOPANEL_CONFIG_DIR: host.path("etc/turbopanel"),
      TURBOPANEL_STATE_DIR: host.path("var/lib/turbopanel"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: host.path("srv/users"),
    }, { forceMode: "production" });
    const service = cronServiceContent({
      layout,
      environmentId: "env1",
      composeServiceName: "web",
      job: {
        name: "nightly",
        schedule: "*-*-* 03:00:00",
        command: ["/usr/bin/php8.4", "artisan", "schedule:run"],
      } as unknown as EnvironmentDeployCronJob,
      username: "alice",
      workingDirectory: host.path("srv/users/alice/sites/web/current"),
    });
    const name = "turbopanel-cron-env1-web-nightly.service";
    const install = (content: string) =>
      stageContent(host, content).then((staged) =>
        host.run([
          "install",
          "-m",
          "0644",
          "-o",
          "root",
          "-g",
          "root",
          staged,
          host.path(`etc/systemd/system/${name}`),
        ])
      );
    for (const value of ["journal", "null", "inherit"]) {
      const ok = await install(
        service.replace("StandardOutput=journal", `StandardOutput=${value}`),
      );
      assertEquals(ok.code, 0, ok.stderr);
    }
    for (
      const value of [
        "append:/etc/sudoers.d/x",
        "file:/etc/sudoers.d/x",
        "truncate:/etc/x",
        "journal+console",
        "kmsg",
        "socket",
        "tty",
        "",
        " journal",
      ]
    ) {
      for (const key of ["StandardOutput", "StandardError"]) {
        const hostile = service.replace(`${key}=journal`, `${key}=${value}`);
        assertEquals(hostile === service, false);
        assertEquals(
          (await install(hostile)).code === 0,
          false,
          `${key}=${value}`,
        );
      }
    }
  });
});

test("the root php-fpm master's own config and conf.d are not the daemon's to write", async () => {
  await withHost(async (host) => {
    for (
      const dir of [
        "etc/turbopanel/php/8.4/conf.d",
        "etc/turbopanel/php/8.4/pool.d",
        "etc/turbopanel/php/conf.d",
      ]
    ) {
      await Deno.mkdir(host.path(dir), { recursive: true });
    }
    const staged = await stageContent(
      host,
      "extension=/var/lib/turbopanel/spool/x.so\n",
    );
    // pool.d is still the daemon's.
    const pool = await host.run([
      "install",
      "-m",
      "0644",
      staged,
      host.path("etc/turbopanel/php/8.4/pool.d/svc1.conf"),
    ]);
    assertEquals(pool.code, 0, pool.stderr);
    for (
      const dest of [
        "etc/turbopanel/php/8.4/conf.d/zz.ini",
        "etc/turbopanel/php/conf.d/zz.ini",
        "etc/turbopanel/php/8.4/php-fpm.conf",
      ]
    ) {
      await refused(host, ["install", "-m", "0644", staged, host.path(dest)]);
      await refused(host, ["tee", host.path(dest)], "x\n");
    }
    await refused(host, [
      "install",
      "-d",
      "-m",
      "0755",
      host.path("etc/turbopanel/php/8.4/conf.d/sub"),
    ]);
  });
});

async function stageContent(host: Host, content: string): Promise<string> {
  const staged = host.path("tmp/content");
  await Deno.writeTextFile(staged, content);
  return staged;
}

const WG_KEY = `${"B".repeat(43)}=`;
const WG_CONF = [
  "[Interface]",
  `PrivateKey = ${WG_KEY}`,
  "Address = 10.77.0.1/24",
  "ListenPort = 51820",
  "",
  "[Peer]",
  `PublicKey = ${WG_KEY}`,
  "AllowedIPs = 10.77.0.2/32, fd00::2/128",
  "Endpoint = node-2.example.net:51820",
  `PresharedKey = ${WG_KEY}`,
  "PersistentKeepalive = 25",
  "",
].join("\n");

async function stage(host: Host, content: string): Promise<string> {
  const staged = host.path("tmp/content");
  await Deno.writeTextFile(staged, content);
  return staged;
}

test("the WireGuard config: only the keys the daemon renders, never a hook", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path("etc/wireguard"), { recursive: true });
    const dest = host.path("etc/wireguard/tp0.conf");
    const install = (staged: string) =>
      host.run([
        "install",
        "-m",
        "0600",
        "-o",
        "root",
        "-g",
        "root",
        staged,
        dest,
      ]);
    const ok = await install(await stage(host, WG_CONF));
    assertEquals(ok.code, 0, ok.stderr);
    const cp = await host.run(["cp", await stage(host, WG_CONF), dest]);
    assertEquals(cp.code, 0, cp.stderr);

    const hostile = [
      "PostUp = /var/lib/turbopanel/spool/x",
      "PreUp = /x",
      "PostDown = /x",
      "PreDown = /x",
      "SaveConfig = true",
      "postup = /x",
      "PostUp=/x",
      "Table = off",
      "DNS = 1.1.1.1",
      "MTU = 1380",
      "FwMark = 1",
      "PostUp\t= /x",
      "PostUp  = /x",
      " PostUp = /x",
      `PrivateKey = ${WG_KEY};`,
      "Address = 10.0.0.1/24; id",
      "Address = 10.0.0.1/24,",
      "ListenPort = 51820 ",
      "ListenPort = 5182000",
    ];
    for (const line of hostile) {
      const conf = WG_CONF.replace("ListenPort = 51820", line);
      await refused(host, [
        "install",
        "-m",
        "0600",
        "-o",
        "root",
        "-g",
        "root",
        await stage(host, conf),
        dest,
      ]);
      await refused(host, ["cp", await stage(host, conf), dest]);
      // The same line under [Peer] is no better.
      await refused(host, [
        "install",
        "-m",
        "0600",
        "-o",
        "root",
        "-g",
        "root",
        await stage(host, `${WG_CONF}${line}\n`),
        dest,
      ]);
    }
    for (
      const conf of [
        "PostUp = /x\n[Interface]\n",
        `${WG_CONF}[Peer]\nEndpoint = a:1\nPostUp = /x\n`,
        WG_CONF.replace("[Peer]", "[Peer]\r"),
        WG_CONF.replace("PostUp", "x") + "\0PostUp = /x\n",
        WG_CONF.replace("[Interface]", "[Interface]\nPost\0Up = /x"),
        WG_CONF.replace(
          "Endpoint = node-2.example.net:51820",
          "Endpoint = $(id):1",
        ),
        WG_CONF.replace("[Peer]", "[Script]"),
        WG_CONF.replace(
          "AllowedIPs = 10.77.0.2/32, fd00::2/128",
          "AllowedIPs = ",
        ),
        `${WG_CONF}# x\rPostUp = /x\n`,
        `${WG_CONF}# x\0PostUp = /x\n`,
      ]
    ) {
      await refused(host, [
        "install",
        "-m",
        "0600",
        "-o",
        "root",
        "-g",
        "root",
        await stage(host, conf),
        dest,
      ]);
    }
  });
});

test("the sysctl drop-in: only the forwarding switch, through install and tee", async () => {
  await withHost(async (host) => {
    const dest = host.path("etc/sysctl.d/99-turbopanel-fabric.conf");
    for (
      const content of [
        "net.ipv4.ip_forward=1\n",
        "# x\nnet.ipv4.ip_forward = 1\n",
      ]
    ) {
      const t = await host.run(["tee", dest], content);
      assertEquals(t.code, 0, t.stderr);
      const i = await host.run([
        "install",
        "-m",
        "0644",
        await stage(host, content),
        dest,
      ]);
      assertEquals(i.code, 0, i.stderr);
    }
    for (
      const content of [
        "kernel.core_pattern=|/var/lib/turbopanel/spool/x\n",
        "kernel.core_pattern = |/x\n",
        "kernel.modprobe=/x\n",
        "kernel.uevent_helper=/x\n",
        "net.ipv4.ip_forward=1\nkernel.core_pattern=|/x\n",
        "net.ipv4.ip_forward=0\n",
        "net.ipv4.ip_forward=1 \n",
        "-kernel.modprobe=/x\n",
        "; x\nkernel.modprobe=/x\n",
        "net.ipv4.ip_forward=1\0\nkernel.modprobe=/x\n",
        // systemd-sysctl ends a line at a carriage return too.
        "# x\rkernel.core_pattern=|/var/lib/turbopanel/spool/x\n",
        "net.ipv4.ip_forward=1\rkernel.modprobe=/x\n",
        "; x\0kernel.core_pattern=|/x\n",
      ]
    ) {
      await refused(host, ["tee", dest], content);
      await refused(host, [
        "install",
        "-m",
        "0644",
        await stage(host, content),
        dest,
      ]);
    }
  });
});

test("the sshd drop-in: only the renderer's Match blocks, never a global or root-capable directive", async () => {
  await withHost(async (host) => {
    const dest = host.path("etc/ssh/sshd_config.d/60-turbopanel.conf");
    const groups = {
      sftpGroup: "tpsftp",
      shellGroup: "tpshell",
      passwordGroup: "tppasswd",
      principalGroup: "tpprincipal",
      authorizedKeysDir: host.path("etc/ssh/turbopanel/authorized_keys"),
    };
    for (
      const content of [
        sshdDropInContent(groups),
        sshdDropInContent({
          ...groups,
          sftpChrootRoot: host.path("srv/users"),
        }),
      ]
    ) {
      const ok = await host.run([
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        await stage(host, content),
        dest,
      ]);
      assertEquals(ok.code, 0, ok.stderr);
    }
    // A drop-in installed as the rollback copy gets the same check.
    await refused(host, [
      "install",
      "-m",
      "0644",
      await stage(host, "PermitRootLogin yes\n"),
      `${dest}.tpprev`,
    ]);
    const good = sshdDropInContent(groups);
    const keys = host.path("etc/ssh/turbopanel/authorized_keys");
    const hostile = [
      "PermitRootLogin yes\n",
      `PermitRootLogin yes\nAuthorizedKeysFile ${keys}/%u\n`,
      `AuthorizedKeysFile ${keys}/%u\n`,
      `Match all\nPermitRootLogin yes\n`,
      `Match User root\n  PermitRootLogin yes\n`,
      `Match Group root\n  PubkeyAuthentication yes\n  AuthorizedKeysFile ${keys}/%u\n`,
      `Match Group tpsftp\n  PermitRootLogin yes\n`,
      `Match Group tpsftp\n  AuthorizedKeysCommand /usr/local/bin/x\n`,
      `Match Group tpsftp\n  AuthorizedKeysFile /etc/ssh/other/%u\n`,
      `Match Group tpsftp\n  ForceCommand /bin/sh\n`,
      `Match Group tpsftp\n  ChrootDirectory /\n`,
      `Match Group tpsftp\n  AllowTcpForwarding yes\n`,
      `Match Group tpsftp,root\n  PubkeyAuthentication yes\n`,
      `Match Group tpsftp\n  PubkeyAuthentication yes # x\n`,
      `Match Group tpsftp\n  PubkeyAuthentication yes\r\n`,
      `Match Group tpsftp\n  Include /tmp/x\n`,
      `Match Group tpsftp\n\tPubkeyAuthentication yes\n`,
      `Match Group tpsftp\n  PubkeyAuthentication yes\0\n  PermitRootLogin yes\n`,
      `${good}PermitRootLogin yes\n`,
      `${good}Include /tmp/x\n`,
      // A comment hides what follows a carriage return from this check only.
      `${good}# x\rPermitRootLogin yes\n`,
      `${good}# x\0PermitRootLogin yes\n`,
      // A block left open would swallow the host config included after it.
      "Match Group tpsftp\n  PubkeyAuthentication yes\n",
      good.replace(/Match all\n$/, ""),
      `${good}Match Group tpsftp\n  PubkeyAuthentication yes\n`,
    ];
    for (const content of hostile) {
      await refused(host, [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        await stage(host, content),
        dest,
      ]);
    }
  });
});

test("the sshd drop-in's allowed groups equal the registry's access groups", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  const found = /^SSHD_MATCH_GROUPS="([^"]*)"$/m.exec(script)?.[1] ?? "";
  assertEquals(
    found.split(" ").sort(),
    [...allAccessGroups()].sort(),
  );
});

test("units: a carriage return or NUL never hides a directive from the check", async () => {
  await withHost(async (host) => {
    const layout = resolveLayout({
      TURBOPANEL_HOME: host.path("opt/turbopanel"),
      TURBOPANEL_RUNTIMES_DIR: host.path("opt/turbopanel/vendor"),
      TURBOPANEL_CONFIG_DIR: host.path("etc/turbopanel"),
      TURBOPANEL_STATE_DIR: host.path("var/lib/turbopanel"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: host.path("srv/users"),
    }, { forceMode: "production" });
    const service = cronServiceContent({
      layout,
      environmentId: "env1",
      composeServiceName: "web",
      job: {
        name: "nightly",
        schedule: "*-*-* 03:00:00",
        command: ["/usr/bin/php8.4", "artisan", "schedule:run"],
      } as unknown as EnvironmentDeployCronJob,
      username: "alice",
      workingDirectory: host.path("srv/users/alice/sites/web/current"),
    });
    const name = "turbopanel-cron-env1-web-nightly.service";
    const dest = host.path(`etc/systemd/system/${name}`);
    const ok = await host.run([
      "install",
      "-m",
      "0644",
      "-o",
      "root",
      "-g",
      "root",
      await stage(host, service),
      dest,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    for (
      const hostile of [
        service.replace("[Service]", "[Service]\n# x\rUser=root"),
        service.replace("[Service]", "[Service]\n; x\rExecStartPre=+/bin/sh"),
        service.replace(
          "Description=",
          "Description=x\rExecStart=+/bin/sh\rUser=root\rignored=",
        ),
        service.replace("[Service]", "[Service]\n# x\0User=root"),
        service.replace("[Service]", "[Service]\r\nUser=root"),
      ]
    ) {
      assertEquals(hostile === service, false);
      await refused(host, [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        await stage(host, hostile),
        dest,
      ]);
    }
    // The slice, timer and hosting classes go through the same gate.
    await refused(host, [
      "install",
      "-m",
      "0644",
      "-o",
      "root",
      "-g",
      "root",
      await stage(host, "[Slice]\n# x\rCPUQuota=1\n"),
      host.path("etc/systemd/system/turbopanel-alice.slice"),
    ]);
  });
});

test("shared php-fpm master pools: only what the daemon renders, never a root worker or the master's own section", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path("etc/turbopanel/php/8.4/pools"), {
      recursive: true,
    });
    const dest = host.path("etc/turbopanel/php/8.4/pools/tp-env1-phpapp.conf");
    const base = {
      composeServiceName: "phpapp",
      engine: "nginx" as const,
      root: "public",
      listenPort: 18081,
    };
    const rendered = [
      phpFpmPoolConfig(
        "env1",
        { ...base, php: { version: "8.4" } },
        "/srv/root",
        "/run/turbopanel/php/8.4/tp-env1-phpapp.sock",
      ),
      phpFpmPoolConfig(
        "env1",
        {
          ...base,
          php: {
            version: "8.4",
            pool: { pm: "static", "pm.max_children": "8" },
            settings: { memory_limit: "256M" },
          },
          principal: {
            principalId: "00000000-0000-4000-8000-000000000099",
            username: "site_user",
          },
        },
        "/var/lib/turbopanel/sites/env1/phpapp/public",
        "/run/turbopanel/php/tp-env1-phpapp.sock",
        {
          openBasedir: ["/var/lib/turbopanel/sites/env1/phpapp/public", "/tmp"],
          releaseSymlinkSwap: true,
        },
      ),
    ];
    for (const content of rendered) {
      for (const target of [dest, `${dest}.candidate`]) {
        const ok = await host.run([
          "install",
          "-m",
          "0640",
          "-o",
          "root",
          "-g",
          "tpnginx",
          await stage(host, content),
          target,
        ]);
        assertEquals(ok.code, 0, ok.stderr);
      }
      const t = await host.run(["tee", dest], content);
      assertEquals(t.code, 0, t.stderr);
    }
    const good = rendered[0];
    const hostile = [
      good.replace("user = tpnginx", "user = root"),
      good.replace("group = tpnginx", "group = root"),
      good.replace("[tp-env1-phpapp]", "[global]"),
      good.replace("[tp-env1-phpapp]", "[GLOBAL]"),
      `${good}[global]\nerror_log = /etc/cron.d/x\n`,
      `${good}include = /var/lib/turbopanel/spool/x.conf\n`,
      `${good}prefix = /\n`,
      `${good}chroot = /\n`,
      `${good}php_admin_value[extension] = /var/lib/turbopanel/spool/x.so\n`,
      `${good}php_admin_value[zend_extension] = /x.so\n`,
      `${good}php_admin_value[EXTENSION_DIR] = /x\n`,
      `${good}security.limit_extensions =\n`,
      `${good}; x\ruser = root\n`,
      `${good}; x\0user = root\n`,
      "user = root\n",
      good.replace("listen.mode = 0660", "listen.mode = 0666 ; x"),
      good.replace("pm = ondemand", "pm = ondemand\npm.status_path = /x"),
    ];
    for (const content of hostile) {
      assertEquals(content === good, false);
      await refused(host, [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "tpnginx",
        await stage(host, content),
        dest,
      ]);
      await refused(host, ["tee", dest], content);
    }
  });
});

test("a directory renamed over a php-fpm series or pools directory is refused", async () => {
  await withHost(async (host) => {
    const php = host.path("etc/turbopanel/php");
    await Deno.mkdir(`${php}/8.4/pools`, { recursive: true });
    await Deno.mkdir(`${php}/8.4/evil`, { recursive: true });
    await Deno.mkdir(`${php}/evil`, { recursive: true });
    await refused(host, [
      "mv",
      "-T",
      "-f",
      `${php}/8.4/evil`,
      `${php}/8.4/pools`,
    ]);
    await refused(host, ["mv", "-T", "-f", `${php}/evil`, `${php}/8.4`]);
    await refused(host, ["mv", "-f", `${php}/evil`, `${php}/8.4`]);
    // The daemon's own candidate-to-live rename inside pools/ still works.
    await Deno.writeTextFile(`${php}/8.4/pools/a.conf.candidate`, "x\n");
    const ok = await host.run([
      "mv",
      "-f",
      "--",
      `${php}/8.4/pools/a.conf.candidate`,
      `${php}/8.4/pools/a.conf`,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
  });
});
