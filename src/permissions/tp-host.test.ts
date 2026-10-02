/**
 * tp-host, run unprivileged in its test mode (TP_HOST_TEST_PREFIX): every
 * managed path lives under a throwaway prefix, account lookups read the
 * prefix's etc/passwd and etc/group, file mechanics run for real, and the
 * privileged commands (chown, useradd, systemctl, iptables, …) are printed
 * as `EXEC [argv]…` instead of run. Unit files come from the daemon's own
 * renderers, so the allowlist is proven against what the daemon writes.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
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
import type {
  EnvironmentDeployCronJob,
  EnvironmentDeployNativeAppService,
} from "../contracts/commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const repo = join(dirname(fromFileUrl(import.meta.url)), "../..");
const SCRIPT = join(repo, "orchestration/scripts/tp-host");
const REGISTRY = join(repo, "orchestration/runtime-registry.json");

type Host = {
  prefix: string;
  run: (
    args: string[],
    stdin?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  path: (rel: string) => string;
  cleanup: () => Promise<void>;
};

async function makeHost(): Promise<Host> {
  const prefix = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-host-" }),
  );
  const path = (rel: string) => join(prefix, rel);
  for (
    const dir of [
      "opt/turbopanel/lib",
      "opt/turbopanel/share/orchestration",
      "opt/turbopanel/vendor/caddy/2.11.4",
      "etc/turbopanel",
      "var/lib/turbopanel",
      "var/log/turbopanel",
      "run/turbopanel",
      "srv/users/alice/sites",
      "etc/systemd/system",
      "etc/ssh/sshd_config.d",
      "etc/ssh/turbopanel/authorized_keys",
      "etc/sysctl.d",
      "outside",
      "tmp",
    ]
  ) {
    await Deno.mkdir(path(dir), { recursive: true });
  }
  await Deno.copyFile(SCRIPT, path("opt/turbopanel/lib/tp-host"));
  await Deno.chmod(path("opt/turbopanel/lib/tp-host"), 0o755);
  await Deno.copyFile(
    REGISTRY,
    path("opt/turbopanel/share/orchestration/runtime-registry.json"),
  );
  await Deno.writeTextFile(
    path("etc/passwd"),
    [
      "root:x:0:0:root:/root:/bin/bash",
      "tp:x:9999:9999::/var/lib/turbopanel:/usr/sbin/nologin",
      "tpnginx:x:9990:9990::/nonexistent:/usr/sbin/nologin",
      `alice:x:15001:15001::${prefix}/srv/users/alice:/bin/bash`,
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    path("etc/group"),
    [
      "root:x:0:",
      "sudo:x:27:",
      "docker:x:998:tp",
      "tp:x:9999:",
      "tpnginx:x:9990:",
      "tpphp84:x:9902:",
      "tpsftp:x:9986:",
      "alice-grp:x:15001:",
      "carol-grp:x:15003:",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(path("outside/secret"), "root-only secret\n");
  await Deno.writeTextFile(path("tmp/staged"), "staged content\n");
  const script = path("opt/turbopanel/lib/tp-host");
  return {
    prefix,
    path,
    run: async (args, stdin) => {
      const child = new Deno.Command("sh", {
        args: [script, ...args],
        clearEnv: true,
        env: { PATH: "/usr/bin:/bin", TP_HOST_TEST_PREFIX: prefix },
        stdin: stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      if (stdin !== undefined) {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(stdin));
        await writer.close();
      }
      const out = await child.output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    },
    cleanup: () => Deno.remove(prefix, { recursive: true }),
  };
}

async function withHost(fn: (host: Host) => Promise<void>): Promise<void> {
  const host = await makeHost();
  try {
    await fn(host);
  } finally {
    await host.cleanup();
  }
}

async function refused(
  host: Host,
  args: string[],
  stdin?: string,
): Promise<string> {
  const result = await host.run(args, stdin);
  assertEquals(result.code === 0, false, `accepted: ${args.join(" ")}`);
  assertEquals(result.stdout.includes("EXEC"), false, args.join(" "));
  return result.stderr;
}

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
    const dir = host.path("srv/users/alice/sites/web/releases");
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
    const sites = host.path("srv/users/alice/sites");
    const mine = await host.run(["chown", "15001:15001", sites]);
    assertEquals(mine.code, 0, mine.stderr);
    assertStringIncludes(
      mine.stdout,
      "EXEC [chown] [-h] [--] [alice:alice-grp] [./sites]",
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

    const release = host.path("srv/users/alice/sites/web");
    const chown = await host.run(["chown", "-R", "root:alice-grp", release]);
    assertEquals(chown.code, 0, chown.stderr);
    assertStringIncludes(
      chown.stdout,
      "EXEC [chown] [-R] [-h] [-P] [--] [root:alice-grp] [./web]",
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
    const home = host.path("srv/users/carol");
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
    const setgid = await host.run(
      setgidDirectoriesFindArgs(host.path("srv/users/alice/sites")),
    );
    assertEquals(setgid.code, 0, setgid.stderr);

    const lookup = issuedCertificateFindArgs(root, "canary.example.com");
    for (
      const args of [
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
