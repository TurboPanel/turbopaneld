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
error_log = ${run}/php-fpm.log
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
        ["0755", "root", "root", host.path("etc/turbopanel/php-sites")],
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
        [
          "install",
          "-m",
          "0640",
          "-o",
          "root",
          "-g",
          "root",
          staged,
          host.path("etc/turbopanel/php-sites/shop-1"),
        ],
        ["tee", host.path("etc/turbopanel/php-sites/shop-1")],
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
      "EXEC [timeout] [30] [setpriv] [--reuid=15001] [--regid=15001] [--clear-groups] " +
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

test("php-site-register writes the launcher registry from the account database only", async () => {
  await withPhpHost(async (host) => {
    const entry = host.path(`etc/turbopanel/php-sites/${PHP_SITE}`);
    const ok = await host.run([
      "php-site-register",
      PHP_SITE,
      "alice",
      "lsphp-attached",
      "8.3",
      "10",
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(ok.stdout, "EXEC [chown] [-h] [--] [root:root] [./f]");
    const home = host.path("srv/users/alice");
    assertEquals(
      await Deno.readTextFile(entry),
      [
        "version=1",
        `site=${PHP_SITE}`,
        "mode=lsphp-attached",
        "user=alice",
        "uid=15001",
        "group=alice-grp",
        "gid=15001",
        `home=${home}`,
        `tmp=${home}/tmp`,
        "php=8.3",
        `bin=${phpExec(host, "lsphp")}`,
        `ini=${phpConfDir(host)}/php.ini`,
        "children=10",
        "",
      ].join("\n"),
    );
    for (
      const args of [
        [PHP_SITE, "root", "lsphp-attached", "8.3", "10"],
        [PHP_SITE, "tpnginx", "lsphp-attached", "8.3", "10"],
        [PHP_SITE, "carol", "lsphp-attached", "8.3", "10"],
        [PHP_SITE, "alice", "php-fpm", "8.3", "10"],
        [PHP_SITE, "alice", "lsphp-attached", "9.1", "10"],
        [PHP_SITE, "alice", "lsphp-attached", "8.3.1", "10"],
        [PHP_SITE, "alice", "lsphp-attached", "8.3", "0"],
        [PHP_SITE, "alice", "lsphp-attached", "8.3", "65"],
        [PHP_SITE, "alice", "lsphp-attached", "8.3", "010"],
        ["Shop", "alice", "lsphp-attached", "8.3", "10"],
        ["../x", "alice", "lsphp-attached", "8.3", "10"],
        [PHP_SITE, "alice", "lsphp-attached", "8.3"],
        [PHP_SITE, "alice", "lsphp-attached", "8.3", "10", "uid=0"],
      ]
    ) {
      await refused(host, ["php-site-register", ...args]);
    }
    for (
      const args of [["chown", "tp", entry], ["chmod", "0666", entry], [
        "cp",
        "-p",
        "--",
        entry,
        `${entry}.x`,
      ]]
    ) {
      await refused(host, args);
    }
    assertEquals((await host.run(["rm", "-f", "--", entry])).code, 0);
  });
});
