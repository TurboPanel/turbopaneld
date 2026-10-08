/**
 * A site owner's Linux user gets the standard Debian per-user group: the group
 * carries the user's own name. Without the old `-grp` suffix the name alone no
 * longer marks a group as TurboPanel's, so tp-host must (1) never create a
 * group under a privileged or existing name, (2) let engines join only a site
 * owner's own group, and (3) rename an old `<name>-grp` only in its one exact
 * shape. Runs in tp-host's test mode (see tp-host-fixture.ts).
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const BAND = ["-K", "GID_MIN=15001", "-K", "GID_MAX=60000"];

async function append(host: Host, file: string, lines: string[]) {
  await Deno.writeTextFile(host.path(file), `${lines.join("\n")}\n`, {
    append: true,
  });
}

function useradd(home: string, name: string, group = name): string[] {
  return [
    "useradd",
    "-K",
    "UID_MIN=15001",
    "-K",
    "UID_MAX=60000",
    "-g",
    group,
    "-d",
    home,
    "-M",
    "-s",
    "/bin/bash",
    name,
  ];
}

test("groupadd creates a site owner's group under the owner's own name", async () => {
  await withHost(async (host) => {
    const band = await host.run(["groupadd", ...BAND, "bob"]);
    assertEquals(band.code, 0, band.stderr);
    assertStringIncludes(band.stdout, "EXEC [groupadd]");
    assertStringIncludes(band.stdout, "[bob]");
    const fixed = await host.run(["groupadd", "-g", "15002", "bob"]);
    assertEquals(fixed.code, 0, fixed.stderr);
  });
});

test("groupadd refuses privileged, reserved and existing names", async () => {
  await withHost(async (host) => {
    // An operator's own administrators' group, named only in sudoers.
    await Deno.mkdir(host.path("etc/sudoers.d"), { recursive: true });
    await Deno.writeTextFile(
      host.path("etc/sudoers.d/ops"),
      "%opsadmins ALL=(ALL:ALL) ALL\n",
    );
    for (
      const name of [
        // Groups sudoers, PAM or polkit grant power to, existing or not.
        "admin",
        "Admin",
        "wheel",
        "sudo",
        "adm",
        "staff",
        "lxd",
        "docker",
        "shadow",
        "disk",
        "systemd-journal",
        "opsadmins",
        // Platform names.
        "root",
        "tp",
        "tpnginx",
        "tpfoo",
        "containers",
        // An existing account and an existing group.
        "alice",
        "tpsftp",
        // Shapes.
        "-g",
        "a.b",
        "x".repeat(33),
      ]
    ) {
      await refused(host, ["groupadd", ...BAND, name]);
    }
    // Ids outside the band, whatever the name.
    await refused(host, ["groupadd", "-g", "27", "bob"]);
    await refused(host, ["groupadd", "-g", "60001", "bob"]);
  });
});

test("useradd refuses a reserved name even when a group of that name was made", async () => {
  await withHost(async (host) => {
    await append(host, "etc/group", ["admin:x:15020:", "wheel:x:15021:"]);
    for (const name of ["admin", "wheel"]) {
      await refused(
        host,
        useradd(host.path(`srv/users/${name}/home`), name),
      );
    }
    // The primary group must be the account's own, in the band.
    await append(host, "etc/group", ["erin:x:15022:", "low:x:1500:"]);
    await refused(
      host,
      useradd(host.path("srv/users/erin/home"), "erin", "carol"),
    );
    await refused(
      host,
      useradd(host.path("srv/users/low/home"), "low"),
    );
    const ok = await host.run(
      useradd(host.path("srv/users/erin/home"), "erin"),
    );
    assertEquals(ok.code, 0, ok.stderr);
  });
});

test("an engine joins only a site owner's own group", async () => {
  await withHost(async (host) => {
    // carol: in the band, but no account of that name owns it.
    // frank: an account whose primary group is not the group frank.
    await append(host, "etc/passwd", [
      `frank:x:15030:15001::${host.path("srv/users/frank/home")}:/bin/bash`,
    ]);
    await append(host, "etc/group", ["frank:x:15031:"]);
    for (const group of ["carol", "frank", "sudo", "tp", "tpsftp"]) {
      await refused(host, ["usermod", "-aG", group, "tpnginx"]);
    }
    const ok = await host.run(["usermod", "-aG", "alice", "tpnginx"]);
    assertEquals(ok.code, 0, ok.stderr);
  });
});

test("groupmod renames an old <name>-grp to <name> in its one exact shape", async () => {
  await withHost(async (host) => {
    await append(host, "etc/passwd", [
      `dave:x:15004:15004::${host.path("srv/users/dave/home")}:/bin/bash`,
      `gina:x:15005:15006::${host.path("srv/users/gina/home")}:/bin/bash`,
      `hal:x:15007:1007::${host.path("srv/users/hal/home")}:/bin/bash`,
      `admin:x:15008:15008::${host.path("srv/users/admin/home")}:/bin/bash`,
      `ivy:x:15009:15009::${host.path("srv/users/ivy/home")}:/bin/bash`,
    ]);
    await append(host, "etc/group", [
      "dave-grp:x:15004:tpnginx",
      // gina's primary group is not gina-grp.
      "gina-grp:x:15005:",
      "gina:x:15006:",
      // hal's old group sits outside the band.
      "hal-grp:x:1007:",
      "admin-grp:x:15008:",
      // ivy already has both names.
      "ivy-grp:x:15009:",
      "ivy:x:15010:",
      // No account kim.
      "kim-grp:x:15011:",
    ]);
    const ok = await host.run(["groupmod", "-n", "dave", "dave-grp"]);
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(ok.stdout, "EXEC [groupmod] [-n] [dave] [dave-grp]");
    for (
      const args of [
        ["groupmod", "-n", "gina", "gina-grp"],
        ["groupmod", "-n", "hal", "hal-grp"],
        ["groupmod", "-n", "admin", "admin-grp"],
        ["groupmod", "-n", "ivy", "ivy-grp"],
        ["groupmod", "-n", "kim", "kim-grp"],
        // Only <name>-grp to <name>, nothing else.
        ["groupmod", "-n", "dave", "alice"],
        ["groupmod", "-n", "sudo", "dave-grp"],
        ["groupmod", "-g", "15004", "dave-grp"],
        ["groupmod", "-n", "dave", "dave-grp", "extra"],
        ["groupmod", "-n", "root", "root-grp"],
      ]
    ) {
      await refused(host, args);
    }
  });
});

test("principal-remove retires an owner whose group still has the old name", async () => {
  await withHost(async (host) => {
    await append(host, "etc/passwd", [
      `dave:x:15004:15004::${host.path("srv/users/dave/home")}:/bin/bash`,
    ]);
    await append(host, "etc/group", ["dave-grp:x:15004:tpnginx"]);
    await Deno.mkdir(host.path("srv/users/dave/home"), { recursive: true });
    const result = await host.run(["principal-remove", "dave"]);
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stdout, "EXEC [userdel] [dave]");
    assertStringIncludes(result.stdout, "EXEC [groupdel] [dave-grp]");
  });
});

test("principal-remove with no account removes only the owner's leftover groups in the band", async () => {
  await withHost(async (host) => {
    await append(host, "etc/group", [
      "zed:x:15040:tpnginx",
      "zed-grp:x:15041:",
    ]);
    const gone = await host.run(["principal-remove", "zed"]);
    assertEquals(gone.code, 0, gone.stderr);
    assertStringIncludes(gone.stdout, "EXEC [groupdel] [zed]");
    assertStringIncludes(gone.stdout, "EXEC [groupdel] [zed-grp]");

    // Out of the band, or still somebody's primary group: left alone.
    await append(host, "etc/passwd", [
      `yan:x:15050:15042::${host.path("srv/users/yan/home")}:/bin/bash`,
    ]);
    await append(host, "etc/group", ["ops:x:1042:", "xyz:x:15042:"]);
    for (const name of ["ops", "xyz"]) {
      const kept = await host.run(["principal-remove", name]);
      assertEquals(kept.code, 0, kept.stderr);
      assertEquals(kept.stdout.includes("[groupdel]"), false, kept.stdout);
    }
  });
});

test("useradd never hands a new account another owner's group", async () => {
  await withHost(async (host) => {
    // An older owner whose group is still bob-grp, and a group with members.
    await append(host, "etc/passwd", [
      `bob:x:15060:15060::${host.path("srv/users/bob/home")}:/bin/bash`,
    ]);
    await append(host, "etc/group", [
      "bob-grp:x:15060:tpnginx",
      "kay:x:15061:tpnginx",
      "lee:x:15062:",
    ]);
    await refused(
      host,
      useradd(host.path("srv/users/bob-grp/home"), "bob-grp"),
    );
    await refused(host, useradd(host.path("srv/users/kay/home"), "kay"));
    // The same group as somebody's primary group.
    await append(host, "etc/passwd", [
      `mo:x:15063:15062::${host.path("srv/users/mo/home")}:/bin/bash`,
    ]);
    await refused(host, useradd(host.path("srv/users/lee/home"), "lee"));
    // All-digit names read as ids.
    await refused(host, ["groupadd", ...BAND, "15999"]);
  });
});

test("groupadd refuses names sudoers pulls in, escapes or quotes, and package system names", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path("etc/sudoers.local"), { recursive: true });
    await Deno.mkdir(host.path("usr/lib/sysusers.d"), { recursive: true });
    await Deno.writeTextFile(
      host.path("etc/sudoers"),
      [
        '%"quoted" ALL=(ALL) ALL',
        "%esc\\aped ALL=(ALL) ALL",
        "@includedir /etc/sudoers.local",
        "#include /etc/sudoers.extra",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      host.path("etc/sudoers.local/x"),
      "%inc ALL=(ALL) ALL\n",
    );
    await Deno.writeTextFile(
      host.path("etc/sudoers.extra"),
      "%extra ALL=(ALL) ALL\n",
    );
    await Deno.writeTextFile(
      host.path("usr/lib/sysusers.d/pkg.conf"),
      'g pkggrp - -\nu pkgusr - "pkg"\n',
    );
    for (
      const name of [
        "quoted",
        "escaped",
        "inc",
        "extra",
        "pkggrp",
        "pkgusr",
        "wireshark",
        "tss",
      ]
    ) {
      await refused(host, ["groupadd", ...BAND, name]);
    }
    const ok = await host.run(["groupadd", ...BAND, "plainname"]);
    assertEquals(ok.code, 0, ok.stderr);
  });
});
