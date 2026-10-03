/**
 * `tp-host build-run` / `build-return`: the root half of the build sandbox.
 * The verb takes ids only, fixes every unit property itself, and hands a work
 * tree to the build account and back without following a symlink. The
 * systemd-run argv is pinned here in full: a property that changes must
 * change this test too.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";

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
const BUILD_UID = 9994;
const BUILD_ACCOUNT =
  `tpbuild:x:${BUILD_UID}:${BUILD_UID}::/nonexistent:/usr/sbin/nologin`;

type BuildHostOptions = {
  /** Extra `/etc/group` lines (e.g. tpbuild in a group it must not hold). */
  groups?: string[];
  /** Replaces the tpbuild passwd line; `null` leaves the account out. */
  account?: string | null;
  resolvConf?: string;
  systemdVersion?: string;
};

/** A host with the build-user role's layout, a checked-out work tree `b1`. */
async function setUpBuildHost(
  host: Host,
  options: BuildHostOptions = {},
): Promise<void> {
  const account = options.account === undefined
    ? BUILD_ACCOUNT
    : options.account;
  if (account !== null) {
    await Deno.writeTextFile(host.path("etc/passwd"), `${account}\n`, {
      append: true,
    });
  }
  const groups = [
    `tpbuild:x:${BUILD_UID}:`,
    "tpnodeapp:x:9910:tpbuild",
    "tpnode24:x:9911:alice,tpbuild",
    ...(options.groups ?? []),
  ];
  await Deno.writeTextFile(host.path("etc/group"), `${groups.join("\n")}\n`, {
    append: true,
  });
  await Deno.mkdir(host.path("var/lib/turbopanel-build/work/b1/app"), {
    recursive: true,
  });
  await Deno.mkdir(host.path("var/lib/turbopanel-build/cache"));
  await Deno.chmod(host.path("var/lib/turbopanel-build"), 0o711);
  await Deno.chmod(host.path("var/lib/turbopanel-build/work"), 0o1770);
  await Deno.chmod(host.path("var/lib/turbopanel-build/cache"), 0o700);
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

function execLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("EXEC "));
}

function execLine(argv: string[]): string {
  return `EXEC ${argv.map((arg) => `[${arg}]`).join(" ")}`;
}

/** The full systemd-run argv for build `b1` of project `p1`, systemd 257. */
function expectedSystemdRun(
  prefix: string,
  tier: { floor?: boolean; privatePids?: boolean; hostDeny?: string } = {},
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
      "User=tpbuild",
      "Group=tpbuild",
      `WorkingDirectory=${work}`,
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "AmbientCapabilities=",
      "RestrictSUIDSGID=yes",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateTmp=yes",
      "PrivateDevices=yes",
      `TemporaryFileSystem=${build}:ro`,
      `LoadCredential=tp-build-runner:${prefix}/opt/turbopanel/lib/tp-build-runner`,
      `BindPaths=${work}`,
      `BindPaths=${build}/cache/p1`,
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
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      // No loopback here: lib/tp-build-loopback filters it by port instead.
      "IPAddressDeny=0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 " +
      "169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 " +
      "198.18.0.0/15 224.0.0.0/3 ::/128 64:ff9b::/96 2002::/16 " +
      "fc00::/7 fe80::/10 ff00::/8" + (tier.hostDeny ?? ""),
      `ExecStartPre=+${prefix}/opt/turbopanel/lib/tp-build-loopback sync`,
      "Slice=tpbuild.slice",
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

test("build-run hands the work tree to tpbuild and starts the runner in the fixed sandbox", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    const result = await host.run(["build-run", "b1", "p1"], "spec\n");
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stderr, "");
    assertEquals(execLines(result.stdout), [
      execLine(["chown", "-h", "--", `${BUILD_UID}:${BUILD_UID}`, "."]),
      execLine([
        "chown",
        "-R",
        "-h",
        "-P",
        "--",
        `${BUILD_UID}:${BUILD_UID}`,
        ".",
      ]),
      execLine([`${host.prefix}/opt/turbopanel/lib/tp-build-loopback`, "sync"]),
      execLine(expectedSystemdRun(host.prefix)),
    ]);
    const cache = await Deno.stat(
      host.path("var/lib/turbopanel-build/cache/p1"),
    );
    assertEquals(cache.isDirectory, true);
    assertEquals((cache.mode ?? 0) & 0o777, 0o700);
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
    const result = await host.run(["build-run", "b1", "p1"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stderr, "");
    const run = execLines(result.stdout)[3] ?? "";
    assertEquals(run, execLine(expectedSystemdRun(host.prefix)));
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
    const result = await host.run(["build-run", "b1", "p1"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      execLines(result.stdout)[2],
      execLine(
        expectedSystemdRun(host.prefix, {
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
    const result = await host.run(["build-run", "b1", "p1"]);
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
    const result = await host.run(["build-run", "b1", "p1"]);
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stderr, "no public nameserver");
    assertEquals(
      execLines(result.stdout)[3],
      execLine(expectedSystemdRun(host.prefix)),
    );
    assertEquals(
      await buildResolvConf(host),
      "nameserver 1.1.1.1\nnameserver 8.8.8.8\n",
    );
    await Deno.remove(host.path("etc/resolv.conf"));
    const none = await host.run(["build-run", "b1", "p1"]);
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
    const ubuntu = await host.run(["build-run", "b1", "p1"]);
    assertEquals(ubuntu.code, 0, ubuntu.stderr);
    assertEquals(ubuntu.stderr, "");
    assertEquals(
      execLines(ubuntu.stdout)[3],
      execLine(expectedSystemdRun(host.prefix, { privatePids: false })),
    );

    await Deno.writeTextFile(host.path("run/systemd-version"), "252\n");
    const old = await host.run(["build-run", "b1", "p1"]);
    assertEquals(old.code, 0, old.stderr);
    assertStringIncludes(old.stderr, "below the supported floor");
    assertStringIncludes(old.stderr, "Debian 13 / Ubuntu 24.04");
    assertEquals(
      execLines(old.stdout)[3],
      execLine(
        expectedSystemdRun(host.prefix, { floor: false, privatePids: false }),
      ),
    );

    await Deno.writeTextFile(host.path("run/systemd-version"), "246\n");
    const stderr = await refused(host, ["build-run", "b1", "p1"]);
    assertStringIncludes(stderr, "cannot sandbox a build");
  });
});

test("build-run takes two well-formed ids and nothing else", async () => {
  await withHost(async (host) => {
    await setUpBuildHost(host);
    for (
      const args of [
        ["build-run"],
        ["build-run", "b1"],
        ["build-run", "b1", "p1", "extra"],
        ["build-run", "B1", "p1"],
        ["build-run", "b1", "P1"],
        ["build-run", "", "p1"],
        ["build-run", "-b1", "p1"],
        ["build-run", "..", "p1"],
        ["build-run", "b1/../../x", "p1"],
        ["build-run", "b1", "../p1"],
        ["build-run", "b_1", "p1"],
        ["build-run", "a".repeat(65), "p1"],
        ["build-run", "--uid=0", "p1"],
        ["build-return"],
        ["build-return", "b1", "extra"],
        ["build-return", "../b1"],
      ]
    ) {
      await refused(host, args);
    }
    await Deno.mkdir(
      host.path(`var/lib/turbopanel-build/work/${"a".repeat(64)}`),
    );
    const longest = await host.run([
      "build-run",
      "a".repeat(64),
      "p".repeat(64),
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
      await refused(host, ["build-run", "b2", "p1"]),
      "symlink",
    );
    await refused(host, ["build-run", "b3", "p1"]);
    await Deno.symlink(
      host.path("var/lib/turbopanel"),
      host.path("var/lib/turbopanel-build/cache/p2"),
    );
    await refused(host, ["build-run", "b1", "p2"]);

    await Deno.chmod(work, 0o770);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1"]),
      "sticky",
    );
    await Deno.chmod(work, 0o1777);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1"]),
      "world-writable",
    );
    await Deno.chmod(work, 0o1770);

    const runner = host.path("opt/turbopanel/lib/tp-build-runner");
    await Deno.chmod(runner, 0o770);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1"]),
      "writable by others",
    );
    await Deno.remove(runner);
    await Deno.symlink(host.path("outside/secret"), runner);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1"]),
      "no build runner",
    );
  });
});

test("build-run refuses a build account that holds any group but its runtimes", async () => {
  for (
    const options of [
      { groups: ["docker2:x:997:tpbuild"] },
      { groups: ["sudo2:x:28:alice,tpbuild"] },
      { groups: ["tp2:x:9998:tpbuild"] },
      { account: null },
      { account: "tpbuild:x:0:0::/nonexistent:/usr/sbin/nologin" },
      { account: "tpbuild:x:15009:15009::/nonexistent:/usr/sbin/nologin" },
      { account: "tpbuild:x:9994:9999::/nonexistent:/usr/sbin/nologin" },
    ]
  ) {
    await withHost(async (host) => {
      await setUpBuildHost(host, options);
      await refused(host, ["build-run", "b1", "p1"]);
    });
  }
  await withHost(async (host) => {
    await Deno.writeTextFile(
      host.path("etc/group"),
      (await Deno.readTextFile(host.path("etc/group"))).replace(
        "docker:x:998:tp",
        "docker:x:998:tp,tpbuild",
      ),
    );
    await setUpBuildHost(host);
    assertStringIncludes(
      await refused(host, ["build-run", "b1", "p1"]),
      "docker",
    );
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
        "Group=alice-grp",
        "Slice=turbopanel-alice.slice",
        "NoNewPrivileges=yes",
        "ExecStart=/bin/true",
        "",
      ].join("\n"),
    );
    for (const name of ["turbopanel-build-b1.service", "tpbuild.slice"]) {
      await refused(host, [
        "install",
        "-m",
        "0644",
        host.path("tmp/unit"),
        host.path(`etc/systemd/system/${name}`),
      ]);
    }
  });
});
