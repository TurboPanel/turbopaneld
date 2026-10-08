/**
 * `tp-host principal-remove NAME`: retiring a principal once the panel says
 * nothing on the host uses it any more. Runs in tp-host's test mode (see
 * tp-host-fixture.ts): file mechanics are real under the prefix, the account
 * and service commands are printed as `EXEC [argv]…`.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function execLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("EXEC"));
}

type Account = {
  name: string;
  uid: number;
  gid?: number;
  groupGid?: number;
  home?: string;
};

/**
 * A principal on the root-owned layout: <root>/<name> with home/, data/,
 * tmp/ and sites/, its key file, its slice (installed and staged), and
 * membership in tpsftp and tpshell.
 */
async function addPrincipal(host: Host, account: Account): Promise<string> {
  const root = host.path(`srv/users/${account.name}`);
  const gid = account.gid ?? account.uid;
  const home = account.home ?? `${root}/home`;
  await Deno.writeTextFile(
    host.path("etc/passwd"),
    `${account.name}:x:${account.uid}:${gid}::${home}:/bin/bash\n`,
    { append: true },
  );
  const group = await Deno.readTextFile(host.path("etc/group"));
  await Deno.writeTextFile(
    host.path("etc/group"),
    group
      .replace("tpsftp:x:9986:", `tpsftp:x:9986:${account.name}`)
      .replace("tpshell:x:9985:", `tpshell:x:9985:alice,${account.name}`) +
      `${account.name}:x:${account.groupGid ?? gid}:tpnginx\n`,
  );
  for (const dir of ["home", "data", "tmp", "sites"]) {
    await Deno.mkdir(`${root}/${dir}`, { recursive: true });
  }
  await Deno.writeTextFile(`${root}/home/notes.txt`, "tenant data\n");
  await Deno.mkdir(host.path("etc/turbopanel/node-apps"), { recursive: true });
  for (
    const file of [
      `etc/systemd/system/turbopanel-${account.name}.slice`,
      `etc/turbopanel/node-apps/slice-${account.name}.slice`,
      `etc/ssh/turbopanel/authorized_keys/${account.name}`,
    ]
  ) {
    await Deno.writeTextFile(host.path(file), "x\n");
  }
  return root;
}

test("principal-remove retires a principal on the root-owned layout", async () => {
  await withHost(async (host) => {
    const root = await addPrincipal(host, { name: "dave", uid: 15004 });
    // A tenant link out of its home: removal must unlink it, never follow it.
    await Deno.symlink(host.path("outside/secret"), `${root}/home/escape`);
    await Deno.symlink(host.path("outside"), `${root}/data/out`);

    const result = await host.run(["principal-remove", "dave"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(execLines(result.stdout), [
      "EXEC [systemctl] [--no-pager] [stop] [turbopanel-dave.slice]",
      "EXEC [pkill] [-KILL] [-u] [15004]",
      "EXEC [systemctl] [daemon-reload]",
      "EXEC [gpasswd] [-d] [dave] [tpshell]",
      "EXEC [gpasswd] [-d] [dave] [tpsftp]",
      "EXEC [userdel] [dave]",
      "EXEC [groupdel] [dave]",
    ]);
    assertEquals(await exists(root), false);
    for (
      const gone of [
        "etc/systemd/system/turbopanel-dave.slice",
        "etc/turbopanel/node-apps/slice-dave.slice",
        "etc/ssh/turbopanel/authorized_keys/dave",
      ]
    ) {
      assertEquals(await exists(host.path(gone)), false, gone);
    }
    // What the links pointed at, and every other principal, is untouched.
    assertEquals(
      await Deno.readTextFile(host.path("outside/secret")),
      "root-only secret\n",
    );
    assert(await exists(host.path("srv/users/alice/sites")));
  });
});

test("principal-remove retires a principal on the tenant-owned layout before it", async () => {
  await withHost(async (host) => {
    // The fixture's alice: passwd home is <root>/alice itself.
    const result = await host.run(["principal-remove", "alice"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      execLines(result.stdout).filter((l) => !l.includes("systemctl")),
      [
        "EXEC [pkill] [-KILL] [-u] [15001]",
        "EXEC [userdel] [alice]",
        "EXEC [groupdel] [alice]",
      ],
    );
    assertEquals(await exists(host.path("srv/users/alice")), false);
  });
});

test("principal-remove never touches an account outside the principal band", async () => {
  const cases: Array<[label: string, account: Account]> = [
    ["uid above the band", { name: "hi", uid: 60001, gid: 15010 }],
    ["uid below the band", { name: "lo", uid: 1000, gid: 15011 }],
    ["nobody", { name: "nob", uid: 65534, gid: 15012 }],
    ["group above the band", { name: "gh", uid: 15013, groupGid: 60001 }],
    ["primary group not <name>", {
      name: "pg",
      uid: 15014,
      gid: 15999,
      groupGid: 15014,
    }],
  ];
  for (const [label, account] of cases) {
    await withHost(async (host) => {
      const root = await addPrincipal(host, account);
      const stderr = await refused(host, ["principal-remove", account.name]);
      assertStringIncludes(stderr, "principal-remove", label);
      assert(await exists(`${root}/home/notes.txt`), label);
    });
  }
});

test("principal-remove refuses a home outside <root>/<name>, or not a real directory", async () => {
  await withHost(async (host) => {
    const root = await addPrincipal(host, {
      name: "ext",
      uid: 15020,
      home: host.path("outside"),
    });
    await refused(host, ["principal-remove", "ext"]);
    assert(await exists(`${root}/home/notes.txt`));
  });
  await withHost(async (host) => {
    // <root>/<name> swapped for a link to somewhere else.
    const root = await addPrincipal(host, { name: "lnk", uid: 15021 });
    await Deno.rename(root, host.path("outside/moved"));
    await Deno.symlink(host.path("outside/moved"), root);
    const stderr = await refused(host, ["principal-remove", "lnk"]);
    assertStringIncludes(stderr, "is a symlink");
    assert(await exists(host.path("outside/moved/home/notes.txt")));
  });
});

test("principal-remove refuses while the host still references the account", async () => {
  const references: Array<[label: string, file: string, body: string]> = [
    [
      "an app unit runs as it",
      "etc/systemd/system/turbopanel-app-svc1.service",
      "[Service]\nUser=dave\nGroup=dave\n",
    ],
    [
      "a cron unit runs in its slice",
      "etc/systemd/system/turbopanel-cron-job1.service",
      "[Service]\nSlice=turbopanel-dave.slice\n",
    ],
    [
      "a site tree is left in its home",
      "srv/users/dave/sites/svc1/releases/r1/index.html",
      "<p>live</p>\n",
    ],
  ];
  for (const [label, file, body] of references) {
    await withHost(async (host) => {
      const root = await addPrincipal(host, { name: "dave", uid: 15004 });
      const path = host.path(file);
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, body);
      const stderr = await refused(host, ["principal-remove", "dave"]);
      assertStringIncludes(stderr, "still", label);
      assert(await exists(`${root}/home/notes.txt`), label);
      assert(
        await exists(host.path("etc/systemd/system/turbopanel-dave.slice")),
        label,
      );
    });
  }
});

test("principal-remove accepts one plain principal name and nothing else", async () => {
  await withHost(async (host) => {
    for (
      const args of [
        ["principal-remove"],
        ["principal-remove", "alice", "bob"],
        ["principal-remove", "-r", "alice"],
        ["principal-remove", "root"],
        ["principal-remove", "tp"],
        ["principal-remove", "tpnginx"],
        ["principal-remove", "../alice"],
        ["principal-remove", "alice/home"],
        ["principal-remove", "a".repeat(29)],
      ]
    ) {
      await refused(host, args);
    }
    assert(await exists(host.path("srv/users/alice/sites")));
  });
});

test("principal-remove finishes what an earlier run left once the account is gone", async () => {
  await withHost(async (host) => {
    await Deno.writeTextFile(host.path("etc/group"), "erin:x:15030:\n", {
      append: true,
    });
    await Deno.writeTextFile(
      host.path("etc/systemd/system/turbopanel-erin.slice"),
      "x\n",
    );
    const result = await host.run(["principal-remove", "erin"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(execLines(result.stdout), [
      "EXEC [systemctl] [--no-pager] [stop] [turbopanel-erin.slice]",
      "EXEC [systemctl] [daemon-reload]",
      "EXEC [groupdel] [erin]",
    ]);
    assertEquals(
      await exists(host.path("etc/systemd/system/turbopanel-erin.slice")),
      false,
    );

    // Nothing left at all: a no-op, not an error.
    const again = await host.run(["principal-remove", "frank"]);
    assertEquals(again.code, 0, again.stderr);
    assertEquals(execLines(again.stdout), [
      "EXEC [systemctl] [--no-pager] [stop] [turbopanel-frank.slice]",
      "EXEC [systemctl] [daemon-reload]",
    ]);
  });
});
