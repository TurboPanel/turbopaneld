/**
 * `tp-host build-run` / `build-handover` / `build-return`: the root half of
 * the build sandbox. The verb takes ids and the site owner's name only, fixes
 * every unit property itself (a throwaway DynamicUser= in the owner's build
 * slice), and hands a work tree to the build's user and back without
 * following a symlink. The systemd-run argv is pinned here in full: a
 * property that changes must change this test too.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";
import { forEachSequential } from "../util/sequential.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const RUNNER = join(
  dirname(fromFileUrl(import.meta.url)),
  "../../orchestration/scripts/tp-build-runner",
);
/** The build's throwaway user, as tp-host names it for `alice` / `p1`. */
async function dynUser(owner = "alice", project = "p1"): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${owner}/${project}`),
  );
  return `tpb-${encodeHex(new Uint8Array(digest)).slice(0, 16)}`;
}

type BuildHostOptions = {
  /** Extra `/etc/group` lines. */
  groups?: string[];
  /** Extra `/etc/passwd` lines. */
  accounts?: string[];
  resolvConf?: string;
  systemdVersion?: string;
};

/** A host with the build-user role's layout, a checked-out work tree `b1`. */
async function setUpBuildHost(
  host: Host,
  options: BuildHostOptions = {},
): Promise<void> {
  if (options.accounts) {
    await Deno.writeTextFile(
      host.path("etc/passwd"),
      `${options.accounts.join("\n")}\n`,
      { append: true },
    );
  }
  const groups = [
    // Leftovers of the old per-version runtime groups: a build gets none of
    // them (every installed runtime is readable by everyone now).
    "tpnodeapp:x:9910:",
    "tpnode24:x:9911:alice",
    "tpnode26:x:9925:",
    "tpnode99:x:15050:",
    "tpdeno2:x:9941:",
    "tpdeno3:x:15051:",
    ...(options.groups ?? []),
  ];
  await Deno.writeTextFile(host.path("etc/group"), `${groups.join("\n")}\n`, {
    append: true,
  });
  await Deno.mkdir(host.path("var/lib/turbopanel-build/work/b1/app"), {
    recursive: true,
  });
  await Deno.chmod(host.path("var/lib/turbopanel-build"), 0o711);
  await Deno.chmod(host.path("var/lib/turbopanel-build/work"), 0o1770);
  await Deno.mkdir(host.path("var/lib/turbopanel-build/caches"));
  await Deno.chmod(host.path("var/lib/turbopanel-build/caches"), 0o700);
  await Deno.copyFile(RUNNER, host.path("opt/turbopanel/lib/tp-build-runner"));
  await Deno.chmod(host.path("opt/turbopanel/lib/tp-build-runner"), 0o750);
  await Deno.writeTextFile(
    host.path("etc/resolv.conf"),
    options.resolvConf ?? "nameserver 9.9.9.9\n",
  );
  if (options.systemdVersion !== undefined) {
    await Deno.writeTextFile(
      host.path("run/systemd-version"),
      `${options.systemdVersion}\n`,
    );
  }
}

/** The build cache of `owner` / `project`, as build-run leaves it. */
async function makeBuildCache(
  host: Host,
  owner = "alice",
  project = "p1",
): Promise<string> {
  const dir = host.path(`var/lib/turbopanel-build/caches/${owner}/${project}`);
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

/** The unit's RuntimeDirectory=, as systemd leaves it for the build's user. */
async function makeRuntimeDir(host: Host): Promise<void> {
  await Deno.mkdir(host.path("run/turbopanel-build-b1"), { recursive: true });
  await Deno.writeTextFile(
    host.path("run/self-cgroup"),
    "/turbopanel.slice/turbopanel-alice.slice/turbopanel-alice-build.slice/turbopanel-build-b1.service\n",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function execLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("EXEC "));
}

function execLine(argv: string[]): string {
  return `EXEC ${argv.map((arg) => `[${arg}]`).join(" ")}`;
}

/** The disk watcher build-run starts before the build unit. */
function expectedWatcher(prefix: string): string {
  return execLine([
    "systemd-run",
    "--unit=turbopanel-buildwatch-b1",
    "--collect",
    "--quiet",
    "--no-block",
    `--setenv=SUDO_UID=${Deno.uid()}`,
    `--setenv=SUDO_GID=${Deno.gid()}`,
    "-p",
    "RuntimeMaxSec=2100",
    "--",
    `${prefix}/opt/turbopanel/lib/tp-host`,
    "build-watch",
    "b1",
    "p1",
    "alice",
  ]);
}

/**
 * The full systemd-run argv for build `b1` of project `p1`, owned by `alice`,
 * systemd 257.
 */
function expectedSystemdRun(
  prefix: string,
  user: string,
  tier: {
    floor?: boolean;
    privatePids?: boolean;
    bindDeny?: boolean;
    hostDeny?: string;
  } = {},
): string[] {
  const build = `${prefix}/var/lib/turbopanel-build`;
  const work = `${build}/work/b1`;
  const hidden = [
    "etc/turbopanel",
    "var/lib/turbopanel",
    "var/log/turbopanel",
    "run/turbopanel",
    "srv/users",
    "srv",
    "backup",
    "run/docker.sock",
    "var/run/docker.sock",
    "run/containerd",
    "run/turbopanel-gate",
    "var/lib/docker",
    "etc/ssh",
    "etc/wireguard",
    "run/systemd/resolve/io.systemd.Resolve",
    "run/dbus/system_bus_socket",
  ].flatMap((rel) => ["-p", `InaccessiblePaths=-${prefix}/${rel}`]);
  const floor = tier.floor ?? true;
  return [
    "systemd-run",
    "--unit=turbopanel-build-b1",
    "--service-type=exec",
    "--wait",
    "--pipe",
    "--quiet",
    "--collect",
    ...[
      "DynamicUser=yes",
      `User=${user}`,
      `WorkingDirectory=${work}`,
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "AmbientCapabilities=",
      "RestrictSUIDSGID=yes",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateDevices=yes",
      `TemporaryFileSystem=${build}:ro`,
      "RuntimeDirectory=turbopanel-build-b1",
      "RuntimeDirectoryMode=0700",
      `ReadOnlyPaths=${prefix}/run/turbopanel-build-b1`,
      `LoadCredential=tp-build-runner:${prefix}/opt/turbopanel/lib/tp-build-runner`,
      `BindPaths=${work}`,
      `BindPaths=${build}/caches/alice/p1`,
      `BindReadOnlyPaths=${prefix}/run/tpbuild/resolv.conf:${prefix}/etc/resolv.conf`,
    ].flatMap((property) => ["-p", property]),
    ...hidden,
    ...[
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectKernelLogs=yes",
      "ProtectControlGroups=yes",
      "ProtectHostname=yes",
      "LockPersonality=yes",
      "RestrictRealtime=yes",
      "RestrictNamespaces=yes",
      "RemoveIPC=yes",
      "SystemCallFilter=@system-service",
      "SystemCallErrorNumber=EPERM",
      "SystemCallArchitectures=native",
      ...(floor
        ? ["ProtectClock=yes", "ProtectProc=invisible", "PrivateIPC=yes"]
        : []),
      ...((tier.privatePids ?? true) ? ["PrivatePIDs=yes"] : []),
      ...((tier.bindDeny ?? true)
        ? [
          "SocketBindDeny=tcp:18080-18999",
          "SocketBindDeny=udp:18080-18999",
          "SocketBindDeny=tcp:19100-19799",
          "SocketBindDeny=udp:19100-19799",
        ]
        : []),
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      // No loopback here: lib/tp-build-loopback filters it by port instead.
      "IPAddressDeny=0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 " +
      "169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 " +
      "198.18.0.0/15 224.0.0.0/3 ::/128 64:ff9b::/96 2002::/16 " +
      "fc00::/7 fe80::/10 ff00::/8" + (tier.hostDeny ?? ""),
      `ExecStartPre=+${prefix}/opt/turbopanel/lib/tp-build-loopback sync b1 alice`,
      `ExecStartPre=+/usr/bin/env SUDO_UID=${Deno.uid()} SUDO_GID=${Deno.gid()} ${prefix}/opt/turbopanel/lib/tp-host build-handover b1 p1 alice`,
      "Slice=turbopanel-alice-build.slice",
      "MemoryMax=4G",
      "MemorySwapMax=0",
      "CPUQuota=200%",
      "TasksMax=1024",
      "IOWeight=50",
      "LimitFSIZE=4G",
      "LimitNOFILE=65536",
      "LimitCORE=0",
      "RuntimeMaxSec=1800",
      "KillMode=control-group",
      "OOMPolicy=continue",
      "UMask=0022",
    ].flatMap((property) => ["-p", property]),
    "--",
    "/bin/sh",
    "${CREDENTIALS_DIRECTORY}/tp-build-runner",
    work,
  ];
}

test("build-run starts the runner as a throwaway user in the site owner's build slice", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    const result = await host.run(["build-run", "b1", "p1", "alice"], "spec\n");
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stderr, "");
    assertEquals(execLines(result.stdout), [
      // Nothing is handed over yet: the build's user exists only once its
      // unit starts, and the unit hands the tree over itself.
      execLine([`${host.prefix}/opt/turbopanel/lib/tp-build-loopback`, "sync"]),
      // A watcher an earlier run of this build id left waiting is stopped, or
      // its unit name would make the new one fail to start.
      execLine([
        "systemctl",
        "stop",
        "--",
        "turbopanel-buildwatch-b1.service",
      ]),
      expectedWatcher(host.prefix),
      execLine(expectedSystemdRun(host.prefix, await dynUser())),
    ]);
    // The owner's project cache exists, root's until the unit hands it over;
    // nothing else is handed over yet either.
    const made = ["alice", "alice/p1"];
    const infos = await Promise.all(
      made.map((rel) =>
        Deno.stat(host.path(`var/lib/turbopanel-build/caches/${rel}`))
      ),
    );
    infos.forEach((info, index) => {
      assertEquals((info.mode ?? 0) & 0o777, 0o700, made[index]);
      assertEquals(info.uid, Deno.uid(), made[index]);
    });
    assertEquals(
      await exists(host.path("var/cache/private/turbopanel-build")),
      false,
    );
  });
});

test("each site owner and project gets its own build user, slice and cache", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, {
      accounts: ["bob:x:15002:15002::/srv/users/bob:/bin/bash"],
    });
    const runs = new Map<string, string>();
    // One at a time: build-run rewrites the build's resolv.conf on each run.
    await forEachSequential([
      ["alice", "p1"],
      ["alice", "p2"],
      ["bob", "p1"],
    ], async ([owner, project]) => {
      const result = await host.run(["build-run", "b1", project, owner]);
      assertEquals(result.code, 0, result.stderr);
      const run = execLines(result.stdout).at(-1) ?? "";
      const user = await dynUser(owner, project);
      assertStringIncludes(run, `[User=${user}]`);
      assertStringIncludes(run, `[Slice=turbopanel-${owner}-build.slice]`);
      assertStringIncludes(
        run,
        `[BindPaths=${
          host.path(`var/lib/turbopanel-build/caches/${owner}/${project}`)
        }]`,
      );
      runs.set(`${owner}/${project}`, user);
    });
    assertEquals(new Set(runs.values()).size, 3);
    // Never a fixed account, never the site owner's own user or group.
    const run = execLines(
      (await host.run(["build-run", "b1", "p1", "alice"])).stdout,
    ).at(-1) ?? "";
    for (
      const forbidden of [
        "User=alice]",
        "Group=",
        "tpbuild]",
        "CacheDirectory=",
        "StateDirectory=",
      ]
    ) {
      assertEquals(run.includes(forbidden), false, forbidden);
    }
  });
});

test("a build with no site owner runs in the platform's own build slice", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    const result = await host.run(["build-run", "b1", "p1", "tpbuild"]);
    assertEquals(result.code, 0, result.stderr);
    const run = execLines(result.stdout).at(-1) ?? "";
    assertStringIncludes(run, "[Slice=turbopanel-tpbuild.slice]");
    assertStringIncludes(run, `[User=${await dynUser("tpbuild", "p1")}]`);
    assertStringIncludes(
      run,
      `[BindPaths=${host.path("var/lib/turbopanel-build/caches/tpbuild/p1")}]`,
    );
  });
});

test("build-run refuses an owner that is not a site owner's Linux user, or a taken build user name", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, {
      accounts: [
        // Names a site owner can never have, or a uid a site owner never
        // has: above the band is systemd's throwaway build users' range,
        // which nss-systemd resolves while a build runs.
        "containers:x:15010:15010::/srv/users/containers:/bin/bash",
        "tpx:x:15011:15011::/srv/users/tpx:/bin/bash",
        "ghost:x:61500:61500::/:/usr/sbin/nologin",
        "toohigh:x:60001:60001::/srv/users/toohigh:/bin/bash",
      ],
    });
    await forEachSequential([
      "root",
      "tp",
      "tpnginx",
      "tpx",
      "containers",
      "ghost",
      "toohigh",
      "nobody-here",
      "alice-",
      "al--ice",
      "-alice",
      "alice.x",
      "a".repeat(33),
      "Alice",
    ], (owner) => refused(host, ["build-run", "b1", "p1", owner]));
    // systemd would run the build as a host account of the same name.
    const name = await dynUser();
    await Deno.writeTextFile(
      host.path("etc/passwd"),
      `${name}:x:1500:1500::/:/bin/sh\n`,
      { append: true },
    );
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "exists as a host account",
    );
  });
});

async function buildResolvConf(host: { path: (rel: string) => string }) {
  return await Deno.readTextFile(host.path("run/tpbuild/resolv.conf"));
}

test("build-run never opens a resolver through the private-range deny, on any port", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, {
      resolvConf: [
        "# generated",
        "nameserver 127.0.0.53",
        "nameserver 169.254.169.254",
        "nameserver fe80::1%eth0",
        "nameserver 192.168.1.1 ; trailing",
        "nameserver 10.0.0.1",
        "nameserver 100.100.100.100",
        "nameserver ::1",
        "nameserver fd00::53",
        "nameserver 64:ff9b::a00:1",
        "nameserver 2002:a00:1::1",
        "nameserver evil.example",
        "nameserver 9.9.9.9",
        "nameserver 2620:fe::fe",
        "search lan",
        "",
      ].join("\n"),
    });
    const result = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stderr, "");
    const run = execLines(result.stdout).at(-1) ?? "";
    assertEquals(
      run,
      execLine(expectedSystemdRun(host.prefix, await dynUser())),
    );
    // Allow wins over deny for every port, so nothing is ever allowed back.
    assertEquals(run.includes("IPAddressAllow"), false);
    // Name lookups cannot go around the bound resolv.conf: nss-resolve's
    // varlink socket and the system bus are out of the namespace.
    for (
      const socket of [
        "run/systemd/resolve/io.systemd.Resolve",
        "run/dbus/system_bus_socket",
      ]
    ) {
      assertStringIncludes(
        run,
        `[InaccessiblePaths=-${host.prefix}/${socket}]`,
      );
    }
    assertStringIncludes(
      run,
      `[BindReadOnlyPaths=${host.prefix}/run/tpbuild/resolv.conf:${host.prefix}/etc/resolv.conf]`,
    );
    assertStringIncludes(run, "64:ff9b::/96 2002::/16");
    assertEquals(
      await buildResolvConf(host),
      "nameserver 9.9.9.9\nnameserver 2620:fe::fe\n",
    );
    const info = await Deno.stat(host.path("run/tpbuild/resolv.conf"));
    assertEquals((info.mode ?? 0) & 0o777, 0o644);
  });
});

test("build-run denies the host's own public addresses but never a resolver or a private one", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await Deno.writeTextFile(
      host.path("run/host-addrs"),
      [
        "203.0.113.7/24",
        "9.9.9.9/32",
        "10.1.2.3/8",
        "2001:db8::5/64",
        "fe80::1/64",
        "bad;addr/1",
        "",
      ].join("\n"),
    );
    const result = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      execLines(result.stdout).at(-1),
      execLine(
        expectedSystemdRun(host.prefix, await dynUser(), {
          hostDeny: " 203.0.113.7/32 2001:db8::5/128",
        }),
      ),
    );
  });
});

test("behind a loopback stub the build uses systemd-resolved's public upstreams", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, { resolvConf: "nameserver 127.0.0.53\n" });
    await Deno.mkdir(host.path("run/systemd/resolve"), { recursive: true });
    await Deno.writeTextFile(
      host.path("run/systemd/resolve/resolv.conf"),
      "nameserver 192.168.1.1\nnameserver 1.0.0.1\n",
    );
    const result = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stderr, "");
    assertEquals(await buildResolvConf(host), "nameserver 1.0.0.1\n");
  });
});

test("a host with only local or private resolvers builds through the vetted public fallback", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, {
      resolvConf: "nameserver 127.0.0.53\nnameserver 192.168.1.1\n",
    });
    const result = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stderr, "no public nameserver");
    assertEquals(
      execLines(result.stdout).at(-1),
      execLine(expectedSystemdRun(host.prefix, await dynUser())),
    );
    assertEquals(
      await buildResolvConf(host),
      "nameserver 1.1.1.1\nnameserver 8.8.8.8\n",
    );
    await Deno.remove(host.path("etc/resolv.conf"));
    const none = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(none.code, 0, none.stderr);
    assertEquals(
      await buildResolvConf(host),
      "nameserver 1.1.1.1\nnameserver 8.8.8.8\n",
    );
  });
});

test("build-run keeps the build unprivileged below the OS floor, with a warning", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, { systemdVersion: "255" });
    const ubuntu = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(ubuntu.code, 0, ubuntu.stderr);
    assertEquals(ubuntu.stderr, "");
    assertEquals(
      execLines(ubuntu.stdout).at(-1),
      execLine(
        expectedSystemdRun(host.prefix, await dynUser(), {
          privatePids: false,
        }),
      ),
    );

    await Deno.writeTextFile(host.path("run/systemd-version"), "252\n");
    const old = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(old.code, 0, old.stderr);
    assertStringIncludes(old.stderr, "below the supported floor");
    assertStringIncludes(old.stderr, "Debian 13 / Ubuntu 24.04");
    assertEquals(
      execLines(old.stdout).at(-1),
      execLine(
        expectedSystemdRun(host.prefix, await dynUser(), {
          floor: false,
          privatePids: false,
        }),
      ),
    );

    await Deno.writeTextFile(host.path("run/systemd-version"), "246\n");
    const stderr = await refused(host, ["build-run", "b1", "p1", "alice"]);
    assertStringIncludes(stderr, "cannot sandbox a build");
  });
});

test("build-run takes two well-formed ids and an owner, and nothing else", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await forEachSequential(
      [
        ["build-run"],
        ["build-run", "b1"],
        ["build-run", "b1", "p1"],
        ["build-run", "b1", "p1", "alice", "extra"],
        ["build-run", "B1", "p1", "alice"],
        ["build-run", "b1", "P1", "alice"],
        ["build-run", "", "p1", "alice"],
        ["build-run", "-b1", "p1", "alice"],
        ["build-run", "..", "p1", "alice"],
        ["build-run", "b1/../../x", "p1", "alice"],
        ["build-run", "b1", "../p1", "alice"],
        ["build-run", "b_1", "p1", "alice"],
        ["build-run", "a".repeat(65), "p1", "alice"],
        ["build-run", "--uid=0", "p1", "alice"],
        ["build-run", "b1", "p1", "../alice"],
        ["build-run", "b1", "p1", "alice/x"],
        ["build-return"],
        ["build-return", "b1", "extra"],
        ["build-return", "../b1"],
        ["build-handover", "b1", "p1"],
        ["build-handover", "b1", "p1", "alice", "extra"],
        ["build-handover", "../b1", "p1", "alice"],
      ],
      (args) => refused(host, args),
    );
    await Deno.mkdir(
      host.path(`var/lib/turbopanel-build/work/${"a".repeat(64)}`),
    );
    const longest = await host.run([
      "build-run",
      "a".repeat(64),
      "p".repeat(64),
      "alice",
    ]);
    assertEquals(longest.code, 0, longest.stderr);
  });
});

test("build-run refuses a symlinked or missing work tree and a loosened build layout", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    const work = host.path("var/lib/turbopanel-build/work");
    await Deno.symlink(host.path("var/lib/turbopanel"), join(work, "b2"));
    assertStringIncludes(
      await refused(host, ["build-run", "b2", "p1", "alice"]),
      "symlink",
    );
    await refused(host, ["build-run", "b3", "p1", "alice"]);

    await Deno.chmod(work, 0o770);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "sticky",
    );
    await Deno.chmod(work, 0o1777);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "world-writable",
    );
    await Deno.chmod(work, 0o1770);

    const runner = host.path("opt/turbopanel/lib/tp-build-runner");
    await Deno.chmod(runner, 0o770);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "writable by others",
    );
    await Deno.remove(runner);
    await Deno.symlink(host.path("outside/secret"), runner);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "no build runner",
    );
  });
});

test("the build gets no supplementary group, even with old runtime groups on the host", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, {
      groups: ["tpnode30x:x:9930:", "tpnode31:x:999:", "tpdeno2x:x:9942:"],
    });
    const result = await host.run(["build-run", "b1", "p1", "alice"]);
    assertEquals(result.code, 0, result.stderr);
    const run = execLines(result.stdout).at(-1) ?? "";
    // Docker and the rest only appear as InaccessiblePaths= sockets.
    assertEquals(run.includes("SupplementaryGroups"), false);
    assertEquals(run.includes("Group="), false);
  });
});

test("build-handover gives the work tree and cache to the unit's throwaway user, from inside that unit only", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await makeBuildCache(host);
    const args = ["build-handover", "b1", "p1", "alice"];
    const self = String(Deno.uid());
    const inRange = { TP_TEST_DYN_MIN: self, TP_TEST_DYN_MAX: self };
    // Started any other way (the daemon through sudo): its cgroup is not the
    // build unit's.
    assertStringIncludes(
      await refused(host, args),
      "turbopanel-build-b1.service only",
    );
    await forEachSequential([
      "/system.slice/turbopaneld.service",
      "/turbopanel.slice/turbopanel-alice.slice/turbopanel-alice-build.slice/turbopanel-build-b2.service",
      "/turbopanel.slice/turbopanel-build-b1.service.d/x",
      // The right unit name anywhere else under turbopanel.slice is not it,
      // e.g. under a delegated container scope.
      "/turbopanel.slice/turbopanel-containers.slice/docker-1.scope/turbopanel-build-b1.service",
      "/turbopanel.slice/turbopanel-alice.slice/x/turbopanel-alice-build.slice/turbopanel-build-b1.service",
      "/turbopanel.slice/turbopanel-tpbuild.slice/turbopanel-build-b1.service",
    ], async (other) => {
      await Deno.writeTextFile(host.path("run/self-cgroup"), `${other}\n`);
      assertStringIncludes(await refused(host, args), "only");
    });
    await makeRuntimeDir(host);
    await Deno.remove(host.path("run/turbopanel-build-b1"));
    assertStringIncludes(await refused(host, args), "no runtime directory");
    await makeRuntimeDir(host);
    // A runtime directory owned by anything but a DynamicUser= uid does not
    // name the build's user: nothing is handed over.
    const notDynamic = await host.run(args, "", {
      TP_TEST_DYN_MIN: String((Deno.uid() ?? 0) + 1),
      TP_TEST_DYN_MAX: String((Deno.uid() ?? 0) + 10),
    });
    assertEquals(notDynamic.code, 1);
    assertStringIncludes(notDynamic.stderr, "not a throwaway build user");
    assertEquals(execLines(notDynamic.stdout), []);

    const result = await host.run(args, "the spec must not be read\n", inRange);
    assertEquals(result.code, 0, result.stderr);
    const chown = execLine([
      "chown",
      "-R",
      "-h",
      "-P",
      "--",
      `${self}:${Deno.gid()}`,
      ".",
    ]);
    // The work tree is taken from the daemon first (root's, 0700), then the
    // cache and the work tree go to the build's user (each pinned, so `.` is
    // that tree).
    assertEquals(execLines(result.stdout), [
      execLine(["chown", "-h", "--", `${self}:${self}`, "."]),
      execLine(["chmod", "0700", "."]),
      chown,
      chown,
    ]);
  });
});

test("build-handover changes nothing when the cache or work tree is a symlink", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await makeRuntimeDir(host);
    const self = String(Deno.uid());
    const env = { TP_TEST_DYN_MIN: self, TP_TEST_DYN_MAX: self };
    const args = ["build-handover", "b1", "p1", "alice"];
    const owner = host.path("var/lib/turbopanel-build/caches/alice");
    await Deno.mkdir(owner, { recursive: true });
    await Deno.symlink(host.path("var/lib/turbopanel"), join(owner, "p1"));
    let out = await host.run(args, "", env);
    assertEquals(out.code, 1);
    assertStringIncludes(out.stderr, "symlink");
    assertEquals(execLines(out.stdout), []);
    await Deno.remove(join(owner, "p1"));
    await Deno.mkdir(join(owner, "p1"));
    const work = host.path("var/lib/turbopanel-build/work");
    await Deno.remove(join(work, "b1"), { recursive: true });
    await Deno.symlink(host.path("var/lib/turbopanel"), join(work, "b1"));
    out = await host.run(args, "", env);
    assertEquals(out.code, 1);
    assertStringIncludes(out.stderr, "symlink");
    assertEquals(execLines(out.stdout), []);
    await Deno.remove(join(work, "b1"));
    await Deno.mkdir(join(work, "b1"));
    await Deno.remove(host.path("run/turbopanel-build-b1"));
    await Deno.symlink(
      host.path("var/lib/turbopanel"),
      host.path("run/turbopanel-build-b1"),
    );
    out = await host.run(args, "", env);
    assertEquals(out.code, 1);
    assertEquals(execLines(out.stdout), []);
  });
});

test("build-return gives the tree back only once the build unit is gone", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await Deno.mkdir(host.path("run/unit-state"));
    const state = host.path("run/unit-state/turbopanel-build-b1.service");
    for (const live of ["active", "activating", "deactivating", "reloading"]) {
      await Deno.writeTextFile(state, `${live}\n`);
      assertStringIncludes(
        await refused(host, ["build-return", "b1"]),
        `still ${live}`,
      );
    }
    for (const done of ["inactive", "failed"]) {
      await Deno.writeTextFile(state, `${done}\n`);
      const result = await host.run(["build-return", "b1"]);
      assertEquals(result.code, 0, result.stderr);
      const self = `${Deno.uid()}:${Deno.gid()}`;
      assertEquals(execLines(result.stdout), [
        execLine(["chown", "-R", "-h", "-P", "--", self, "."]),
        execLine(["chmod", "-R", "u+rwX", "--", "."]),
      ]);
    }
    await Deno.symlink(
      host.path("var/lib/turbopanel"),
      host.path("var/lib/turbopanel-build/work/b2"),
    );
    await refused(host, ["build-return", "b2"]);
  });
});

test("tp cannot install a unit under the build sandbox's transient unit names", async () => {
  await withHost(async (host) => {
    await Deno.writeTextFile(
      host.path("tmp/unit"),
      [
        "[Service]",
        "User=alice",
        "Group=alice",
        "Slice=turbopanel-alice.slice",
        "NoNewPrivileges=yes",
        "ExecStart=/bin/true",
        "",
      ].join("\n"),
    );
    for (
      const name of [
        "turbopanel-build-b1.service",
        "turbopanel-buildwatch-b1.service",
        "tpbuild.slice",
      ]
    ) {
      await refused(host, [
        "install",
        "-m",
        "0644",
        host.path("tmp/unit"),
        host.path(`etc/systemd/system/${name}`),
      ]);
    }
    // The build slices are systemd's implicit ones, never a unit file of
    // tp's, even one shaped like the site owner's own slice (which it may
    // install).
    await Deno.writeTextFile(
      host.path("tmp/slice"),
      "[Unit]\nDescription=x\n\n[Slice]\n",
    );
    const install = (name: string) => [
      "install",
      "-m",
      "0644",
      host.path("tmp/slice"),
      host.path(`etc/systemd/system/${name}`),
    ];
    const own = await host.run(install("turbopanel-alice.slice"));
    assertEquals(own.code, 0, own.stderr);
    await forEachSequential(
      ["turbopanel-alice-build.slice", "turbopanel-tpbuild.slice"],
      (name) => refused(host, install(name)),
    );
  });
});

test("build-run empties caches nobody has built with for a month, and one over its cap", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    const cache = host.path("var/lib/turbopanel-build/caches");
    await Promise.all(
      ["bob/old-one", "alice/fresh-one", "alice/p1"].map(async (name) => {
        await Deno.mkdir(join(cache, name, "deep"), { recursive: true });
        await Deno.writeTextFile(
          join(cache, name, "deep", "f"),
          "x".repeat(4096),
        );
      }),
    );
    const old = new Date(Date.now() - 40 * 86_400_000);
    await Deno.utime(join(cache, "bob/old-one"), old, old);
    // Over the cap (1 KiB here): this owner's project cache is emptied.
    const result = await host.run(
      ["build-run", "b1", "p1", "alice"],
      "spec\n",
      { TP_TEST_CACHE_MAX_KB: "1" },
    );
    assertEquals(result.code, 0, result.stderr);
    const lines = execLines(result.stdout);
    assertEquals(
      lines.filter((line) => line.startsWith("EXEC [find]")),
      [
        execLine(["find", "./bob/old-one", "-mindepth", "1", "-delete"]),
        execLine(["find", "./alice/p1", "-mindepth", "1", "-delete"]),
      ],
    );
    assert(lines.includes(execLine(["rmdir", "--", "./bob/old-one"])));
    assertEquals(lines.some((line) => line.includes("fresh-one")), false);
  });
});

test("build-run refuses a symlinked or loosened cache tree", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    const caches = host.path("var/lib/turbopanel-build/caches");
    await Deno.chmod(caches, 0o777);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "world-writable",
    );
    await Deno.remove(caches);
    await Deno.symlink(host.path("var/lib/turbopanel"), caches);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "symlink",
    );
    await Deno.remove(caches);
    await Deno.mkdir(join(caches, "alice"), { recursive: true });
    await Deno.chmod(caches, 0o700);
    await Deno.symlink(
      host.path("var/lib/turbopanel"),
      join(caches, "alice", "p1"),
    );
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1", "alice"]),
      "symlink",
    );
  });
});

test("build-watch stops a build whose work tree is over the cap, and not a finished one", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await Deno.mkdir(host.path("run/unit-state"));
    const unit = host.path("run/unit-state/turbopanel-build-b1.service");
    await Deno.writeTextFile(
      host.path("var/lib/turbopanel-build/work/b1/app/big"),
      "x".repeat(64 * 1024),
    );
    const env = { TP_TEST_WATCH_SEC: "0", TP_TEST_WORK_MAX_KB: "8" };
    // The unit never ran (or is already gone): nothing to stop.
    const idle = await host.run(
      ["build-watch", "b1", "p1", "alice"],
      undefined,
      env,
    );
    assertEquals(idle.code, 0, idle.stderr);
    assertEquals(execLines(idle.stdout), []);
    await Deno.writeTextFile(unit, "active\n");
    const over = await host.run(
      ["build-watch", "b1", "p1", "alice"],
      undefined,
      env,
    );
    assertEquals(over.code, 0, over.stderr);
    assertEquals(execLines(over.stdout), [
      execLine(["systemctl", "stop", "--", "turbopanel-build-b1.service"]),
    ]);
    assertStringIncludes(over.stderr, "over the disk limit");
    await refused(host, ["build-watch", "b1", "p1"]);
    await refused(host, ["build-watch", "../b1", "p1", "alice"]);
    await refused(host, ["build-watch", "b1", "p1", "root"]);
  });
});

test("build-watch measures the owner's own project cache and the unit's private tmp", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await Deno.mkdir(host.path("run/unit-state"));
    await Deno.writeTextFile(
      host.path("run/unit-state/turbopanel-build-b1.service"),
      "active\n",
    );
    const cache = await makeBuildCache(host);
    await Deno.writeTextFile(join(cache, "big"), "x".repeat(64 * 1024));
    // Another owner's big cache is not this build's.
    const other = await makeBuildCache(host, "bob", "p1");
    await Deno.writeTextFile(join(other, "big"), "x".repeat(64 * 1024));
    const env = { TP_TEST_WATCH_SEC: "0", TP_TEST_CACHE_MAX_KB: "8" };
    const over = await host.run(
      ["build-watch", "b1", "p1", "alice"],
      undefined,
      env,
    );
    assertEquals(over.code, 0, over.stderr);
    assertEquals(execLines(over.stdout), [
      execLine(["systemctl", "stop", "--", "turbopanel-build-b1.service"]),
    ]);
    await Deno.remove(join(cache, "big"));
    // systemd 255 keeps the unit's private /tmp under the host's /tmp: it is
    // measured too, and another unit's is not.
    const tmpEnv = { ...env, TP_TEST_TMP_MAX_KB: "8" };
    await Promise.all(
      ["turbopanel-build-b2.service", "other.service"].map(async (unit) => {
        const dir = host.path(`tmp/systemd-private-0f-${unit}-Ab/tmp`);
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(join(dir, "big"), "x".repeat(64 * 1024));
      }),
    );
    const quiet = await host.run(
      ["build-watch", "b1", "p1", "alice"],
      undefined,
      { ...tmpEnv, TP_TEST_WATCH_ONCE: "1" },
    );
    assertEquals(quiet.code, 0, quiet.stderr);
    assertEquals(execLines(quiet.stdout), []);
    const own = host.path(
      "var/tmp/systemd-private-0f-turbopanel-build-b1.service-Cd/tmp",
    );
    await Deno.mkdir(own, { recursive: true });
    await Deno.writeTextFile(join(own, "big"), "x".repeat(64 * 1024));
    const tmpOver = await host.run(
      ["build-watch", "b1", "p1", "alice"],
      undefined,
      tmpEnv,
    );
    assertEquals(tmpOver.code, 0, tmpOver.stderr);
    assertEquals(execLines(tmpOver.stdout), [
      execLine(["systemctl", "stop", "--", "turbopanel-build-b1.service"]),
    ]);
    await Deno.writeTextFile(
      host.path("run/unit-state/turbopanel-build-b1.service"),
      "inactive\n",
    );
    const done = await host.run(
      ["build-watch", "b1", "p1", "alice"],
      undefined,
      env,
    );
    assertEquals(done.code, 0, done.stderr);
    assertEquals(execLines(done.stdout), []);
  });
});

test("build-handover refuses a work tree holding a hard link, and removes only the link", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    await makeRuntimeDir(host);
    await makeBuildCache(host);
    const self = String(Deno.uid());
    // The daemon could link a file it may write but does not own (outside
    // the tree, on the same file system) into the tree before the handover.
    await Deno.link(
      host.path("outside/secret"),
      host.path("var/lib/turbopanel-build/work/b1/app/innocent"),
    );
    const out = await host.run(["build-handover", "b1", "p1", "alice"], "", {
      TP_TEST_DYN_MIN: self,
      TP_TEST_DYN_MAX: self,
    });
    assertEquals(out.code, 1);
    assertStringIncludes(out.stderr, "hard link");
    const lines = execLines(out.stdout);
    assert(
      lines.includes(
        execLine([
          "find",
          ".",
          "-xdev",
          "-type",
          "f",
          "-links",
          "+1",
          "-delete",
        ]),
      ),
    );
    // Nothing was handed to the build's user.
    assertEquals(lines.some((line) => line.includes("[-R]")), false);
  });
});

test("a dashed site owner gets a slice of its own, never inside another owner's or the platform's", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host, {
      accounts: ["web-x:x:15020:15020::/srv/users/web-x:/bin/bash"],
      groups: ["web-x:x:15020:"],
    });
    const run = execLines(
      (await host.run(["build-run", "b1", "p1", "web-x"])).stdout,
    ).at(-1) ?? "";
    // `-` is a slice level to systemd: it becomes `.` in the owner's slices.
    assertStringIncludes(run, "[Slice=turbopanel-web.x-build.slice]");
    assertStringIncludes(run, "tp-build-loopback sync b1 web-x]");
    const unit = (slice: string) =>
      [
        "[Service]",
        "User=web-x",
        "Group=web-x",
        `Slice=${slice}`,
        "NoNewPrivileges=yes",
        "ExecStart=/bin/true",
        "",
      ].join("\n");
    const install = async (slice: string) => {
      await Deno.writeTextFile(host.path("tmp/unit"), unit(slice));
      return await host.run([
        "install",
        "-m",
        "0644",
        host.path("tmp/unit"),
        host.path("etc/systemd/system/turbopanel-app-x.service"),
      ]);
    };
    const own = await install("turbopanel-web.x.slice");
    assertEquals(own.code, 0, own.stderr);
    // The plain dashed name would sit inside owner `web`'s slice.
    assertEquals((await install("turbopanel-web-x.slice")).code, 1);
  });
});

test("no new site owner may take a platform slice's name or an id above the band", async () => {
  await withHost(async (host) => {
    await Deno.writeTextFile(
      host.path("etc/group"),
      "containers:x:15020:\ncarol2:x:15021:\n",
      { append: true },
    );
    const useradd = (name: string, ids: string[]) => [
      "useradd",
      ...ids,
      "-g",
      `${name}`,
      "-d",
      host.path(`srv/users/${name}/home`),
      "-M",
      "-s",
      "/bin/bash",
      name,
    ];
    const band = ["-K", "UID_MIN=15001", "-K", "UID_MAX=60000"];
    await refused(host, useradd("containers", band));
    // systemd hands out 61184-65519 to throwaway build users.
    await refused(host, useradd("carol2", ["-u", "61500"]));
    await refused(host, useradd("carol2", ["-u", "60001"]));
    await refused(host, ["groupadd", "-g", "61500", "dave"]);
    const ok = await host.run(useradd("carol2", ["-u", "60000"]));
    assertEquals(ok.code, 0, ok.stderr);
  });
});

test("removing a site owner removes their build caches, and nobody else's", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    const mine = await makeBuildCache(host, "alice", "p1");
    const other = await makeBuildCache(host, "bob", "p1");
    await Deno.writeTextFile(join(mine, "npm-cache"), "x");
    const out = await host.run(["principal-remove", "alice"]);
    assertEquals(out.code, 0, out.stderr);
    assertEquals(
      await exists(host.path("var/lib/turbopanel-build/caches/alice")),
      false,
    );
    assertEquals(await exists(other), true);
  });
});
