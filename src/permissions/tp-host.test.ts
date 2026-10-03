/**
 * tp-host, run unprivileged in its test mode (TP_HOST_TEST_PREFIX): every
 * managed path lives under a throwaway prefix, account lookups read the
 * prefix's etc/passwd and etc/group, file mechanics run for real, and the
 * privileged commands (chown, useradd, systemctl, iptables, …) are printed
 * as `EXEC [argv]…` instead of run. Unit files come from the daemon's own
 * renderers, so the allowlist is proven against what the daemon writes.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type Host,
  refused,
  TP_HOST_SCRIPT as SCRIPT,
  withHost,
} from "../testing/tp-host-fixture.ts";
import { resolveLayout } from "../paths/layout.ts";
import { cronServiceContent, cronTimerContent } from "../deploy/cron/unit.ts";
import {
  nativeAppUnitContent,
  principalSliceContent,
} from "../deploy/native/unit.ts";
import { caddyUnit } from "../deploy/ingress.ts";
import { backupServiceContent, backupTimerContent } from "../backups/units.ts";
import { issuedCertificateFindArgs } from "../deploy/instance-acme-http01.ts";
import { setgidDirectoriesFindArgs } from "../deploy/site.ts";
import { releaseLinkTargetsFindArgs } from "../deploy/release/release-links.ts";
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
    const dest = host.path("etc/turbopanel/nginx.conf");
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
    const planted = host.path("etc/turbopanel/app.conf");
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
      host.path("etc/turbopanel/linked"),
    );
    await refused(host, [
      "install",
      "-m",
      "0640",
      host.path("tmp/staged"),
      host.path("etc/turbopanel/linked/evil"),
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
      "alice-grp",
      dir,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assertEquals((await Deno.stat(dir)).isDirectory, true);
    assertStringIncludes(
      ok.stdout,
      "EXEC [chown] [-h] [--] [alice:alice-grp] [.]",
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

    // The daemon's own rendering passes.
    for (
      const [name, content] of [[serviceName, service], [timerName, timer]]
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
          "Group=alice-grp",
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
      "EXEC [chown] [-h] [--] [alice:alice-grp] [./home]",
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
    const tree = host.path("var/lib/turbopanel/scratch");
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
    const chown = await host.run(["chown", "-R", "root:alice-grp", release]);
    assertEquals(chown.code, 0, chown.stderr);
    assertStringIncludes(
      chown.stdout,
      "EXEC [chown] [-R] [-h] [-P] [--] [root:alice-grp] [./r1]",
    );
    await refused(host, ["chown", "alice", host.path("etc/turbopanel")]);
    await refused(host, ["chown", "-R", "tp", host.path("outside")]);
    await refused(host, [
      "chown",
      "alice:alice-grp",
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
      "carol-grp",
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
      "EXEC [useradd] [-K] [UID_MIN=15001] [-K] [UID_MAX=60000] [-g] [carol-grp]",
    );
    const addU = await host.run([
      "useradd",
      "-u",
      "15555",
      "-g",
      "carol-grp",
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
      "EXEC [useradd] [-u] [15555] [-g] [carol-grp]",
    );
    for (
      const args of [
        [
          "useradd",
          "-u",
          "0",
          "-g",
          "carol-grp",
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
          "carol-grp",
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
          "carol-grp",
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
        ["gpasswd", "-d", "alice", "alice-grp"],
        ["getent", "shadow", "--", "root"],
      ]
    ) {
      await refused(host, args);
    }
    for (
      const args of [
        ["usermod", "-aG", "tpphp84", "alice"],
        ["usermod", "-aG", "tpsftp", "alice"],
        ["usermod", "-aG", "alice-grp", "tpnginx"],
        ["gpasswd", "-d", "alice", "tpphp84"],
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

    const lookup = issuedCertificateFindArgs(root, "canary.example.com");
    for (
      const args of [
        releaseLinkTargetsFindArgs(host.path("outside")),
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
    await parseUnitMeta(meta("a", "a-grp", "a.slice", "yes")),
    "ok [a] [a-grp] [a.slice] [yes]",
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
    await parseUnitMeta(meta("", "alice-grp", "turbopanel-alice.slice", "yes")),
    "ok [] [alice-grp] [turbopanel-alice.slice] [yes]",
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
      "Group=alice-grp",
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
    await refused(host, installDir(root, "0750", "alice", "alice-grp"));
  });
});

test("principal home: the skeleton is root's, never group-writable, and only root:<p>-grp", async () => {
  await withHost(async (host) => {
    const home = host.path("srv/users/alice");
    const sealed = await host.run(
      installDir(home, "0750", "root", "alice-grp"),
    );
    assertEquals(sealed.code, 0, sealed.stderr);
    assertStringIncludes(
      sealed.stdout,
      "EXEC [chown] [-h] [--] [root:alice-grp] [.]",
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
      await refused(host, installDir(dir, "0750", "alice", "alice-grp"));
      await refused(host, installDir(dir, "0750", "15001"));
      await refused(host, ["chown", "alice:alice-grp", dir]);
      await refused(host, ["chown", "tpnginx", dir]);
      // The engines are in alice-grp: group write is the same rename hole.
      await refused(host, installDir(dir, "0770", "root", "alice-grp"));
      await refused(host, installDir(dir, "0752", "root", "alice-grp"));
      await refused(host, installDir(dir, "2750", "root", "alice-grp"));
      // Another principal's group, or an engine's, never holds the skeleton.
      await refused(host, installDir(dir, "0750", "root", "carol-grp"));
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
        await refused(host, installDir(dir, "0750", "root", "alice-grp"));
        continue;
      }
      const ok = await host.run(installDir(dir, "0750", "root", "alice-grp"));
      assertEquals(ok.code, 0, `${dir}: ${ok.stderr}`);
    }
    // Recursion from a skeleton directory would walk the tenant's leaves as
    // root; only a release (all root's) is re-owned in one sweep.
    for (const dir of structural.slice(0, 5)) {
      await refused(host, ["chown", "-R", "root:alice-grp", dir]);
      await refused(host, ["chmod", "-R", "0750", dir]);
      await refused(host, setgidDirectoriesFindArgs(dir));
    }
    const seal = await host.run([
      "chown",
      "-R",
      "root:alice-grp",
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
      const ok = await host.run(installDir(dir, "0700", "alice", "alice-grp"));
      assertEquals(ok.code, 0, ok.stderr);
      assertEquals((await Deno.lstat(dir)).isDirectory, true);
      assertStringIncludes(
        ok.stdout,
        "EXEC [chown] [-h] [--] [alice:alice-grp] [.]",
      );
      // 0700: the engine accounts in alice-grp stay out.
      await refused(host, installDir(dir, "0750", "alice", "alice-grp"));
      await refused(host, installDir(dir, "0701", "alice", "alice-grp"));
      await refused(host, ["chmod", "0770", dir]);
      await refused(host, ["chmod", "u=rwX,g=rX,o=", dir]);
      await refused(host, ["chmod", "-R", "u=rwX,g=rX,o=", dir]);
      // Nobody else owns them: not root, an engine, or another principal.
      await refused(host, installDir(dir, "0700", "tpnginx", "alice-grp"));
      await refused(host, installDir(dir, "0700", "alice", "carol-grp"));
      await refused(host, installDir(dir, "0700", "alice", "tpnginx"));
      await refused(host, ["chown", "root", dir]);
    }
    // The principal still owns the leaves of its sites and volumes.
    for (
      const leaf of ["sites/web/shared", "sites/web/webroot", "volumes/v1"]
    ) {
      const ok = await host.run(
        installDir(`${home}/${leaf}`, "0750", "alice", "alice-grp"),
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
      installDir(`${home}/home`, "0700", "alice", "alice-grp"),
    );
    assertEquals((await Deno.stat(outside)).mode! & 0o777, 0o755);
    await refused(host, ["chmod", "0700", `${home}/home`]);
    // A group-writable home lets anyone in the group rename home/ away.
    await Deno.chmod(home, 0o770);
    const stderr = await refused(
      host,
      installDir(`${home}/data`, "0700", "alice", "alice-grp"),
    );
    assertStringIncludes(stderr, "not sealed");
    await refused(
      host,
      installDir(`${home}/sites`, "0750", "root", "alice-grp"),
    );
    await Deno.chmod(home, 0o750);
    const ok = await host.run(
      installDir(`${home}/data`, "0700", "alice", "alice-grp"),
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
      "carol-grp",
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
    "bob-grp:x:15002:\ntpapache:x:9991:\ntpols:x:9992:\n",
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
    "Group=alice-grp",
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
      ["another principal's group", line("Group=", "Group=bob-grp")],
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
      "Group=alice-grp",
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
      ["the owner's group", line("SocketGroup=", "SocketGroup=alice-grp")],
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
    opts.group ?? "alice-grp",
    host.path("tmp/conf"),
    `${phpConfDir(host)}/${name}`,
  ]);
}

test("per-site PHP config: root:<owner>-grp, 0750/0640, directives on an allowlist", async () => {
  await withPhpHost(async (host) => {
    const dir = phpConfDir(host);
    const mkdir = (
      path: string,
      mode = "0750",
      owner = "root",
      group = "alice-grp",
    ) =>
      host.run(["install", "-d", "-m", mode, "-o", owner, "-g", group, path]);
    const made = await mkdir(dir);
    assertEquals(made.code, 0, made.stderr);
    assertStringIncludes(
      made.stdout,
      "EXEC [chown] [-h] [--] [root:alice-grp] [.]",
    );
    for (
      const [mode, owner, group, path] of [
        ["0755", "root", "alice-grp", dir],
        ["0770", "root", "alice-grp", dir],
        ["0750", "alice", "alice-grp", dir],
        ["0750", "tp", "alice-grp", dir],
        ["0750", "root", "tpnginx", dir],
        ["0750", "root", "carol-grp", dir],
        ["0750", "root", "alice-grp", phpConfDir(host, "Shop")],
        ["0750", "root", "alice-grp", `${dir}/deeper`],
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
        "EXEC [chown] [-h] [--] [root:alice-grp] [./f]",
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
      "alice-grp",
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
        ["chown", "alice:alice-grp", ini],
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
    for (const mode of ["fastcgi", "fpm"] as const) {
      for (const webAccount of ["tpnginx", "tpapache"] as const) {
        const id = sitePhpRuntimeId(sitePhpKey("env1", "shop"), mode, "8.4");
        const spec: SitePhpRuntimeSpec = {
          id,
          mode,
          series: "8.4",
          user: "alice",
          group: "alice-grp",
          home,
          configDir: host.path("etc/turbopanel"),
          libDir: host.path("opt/turbopanel/lib"),
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
          "alice-grp",
          dir,
        ]);
        assertEquals(made.code, 0, made.stderr);
        const configs: Array<[string, string]> = [[
          "php.ini",
          sitePhpIni([
            { key: "memory_limit", value: "256M" },
            { key: "open_basedir", value: `${site}/current/public:/tmp` },
            { key: "realpath_cache_ttl", value: "0" },
            { key: "session.save_path", value: "/var/lib/php/sessions" },
          ], home),
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
            "alice-grp",
            host.path("tmp/conf"),
            `${dir}/${name}`,
          ]);
          assertEquals(put.code, 0, `${mode} ${name}: ${put.stderr}`);
        }
        if (mode === "fastcgi") {
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
