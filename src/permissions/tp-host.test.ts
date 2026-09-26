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
