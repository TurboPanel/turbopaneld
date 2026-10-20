/**
 * tp-host and the scope tree: `<home>/<scope>/{services,volumes}/<name>`.
 * Names come from the shared rules (asset-path runs the shared vectors), the
 * ownership rules key on position under the owner's home, `publish-open` and
 * `publish` take six words, and the SFTP check walks the whole tree. In test
 * mode the file mechanics run for real and the chowns are printed.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { RESERVED_PRINCIPAL_USERNAMES } from "../deploy/reserved-principal-names.ts";
import {
  type Host,
  refused,
  TP_HOST_SCRIPT,
  withHost,
} from "../testing/tp-host-fixture.ts";

/** Jest/Mocha-shaped alias for {@link Deno.test}; Sonar only recognises `test()`. */
const test = Deno.test.bind(Deno);

type Vectors = {
  owner: Array<{ value: string; valid: boolean }>;
  environment: Array<{ value: string; valid: boolean }>;
  scope: Array<{ value: string; valid: boolean }>;
  folderName: Array<{ value: string; valid: boolean }>;
  pathId: Array<{ value: string; valid: boolean }>;
  folderRefs: Array<{
    ref: { owner: string; scope: string; kind: string; slug: string };
    host: string;
  }>;
  badFolderRefs: Array<{
    why: string;
    ref: { owner: string; scope: string; kind: string; slug: string };
  }>;
};

const vectors = JSON.parse(
  Deno.readTextFileSync(
    new URL("../contracts/layout-vectors.json", import.meta.url),
  ),
) as Vectors;

test("the root helper refuses every host account name the daemon does", async () => {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  const listed = (script.match(/TP_RESERVED_NAMES="([^"]*)"/)?.[1] ?? "") +
    " " + (script.match(/TP_RESERVED_NEW_NAMES="([^"]*)"/)?.[1] ?? "");
  const names = new Set(listed.split(/\s+/).filter(Boolean));
  const missing = [...RESERVED_PRINCIPAL_USERNAMES].filter((name) =>
    !name.startsWith("tp") && !names.has(name)
  );
  assertEquals(missing, []);
});

const SERVICE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70";
const RELEASE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71";
const PUBLISH_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72";
const HOME = "srv/users/alice";
const SERVICE = `${HOME}/production/services/example.com`;

async function assetPath(
  host: Host,
  owner: string,
  scope: string,
  kind: string,
  slug: string,
): Promise<boolean> {
  const result = await host.run(["asset-path", owner, scope, kind, slug]);
  return result.code === 0;
}

test("asset-path agrees with every shared name vector", async () => {
  await withHost(async (host) => {
    for (const row of vectors.owner) {
      assertEquals(
        await assetPath(host, row.value, "production", "service", "x"),
        row.valid,
        `owner ${JSON.stringify(row.value)}`,
      );
    }
    for (const row of vectors.scope) {
      assertEquals(
        await assetPath(host, "alice", row.value, "service", "x"),
        row.valid,
        `scope ${JSON.stringify(row.value)}`,
      );
    }
    for (const row of vectors.folderName) {
      assertEquals(
        await assetPath(host, "alice", "production", "volume", row.value),
        row.valid,
        `folder name ${JSON.stringify(row.value)}`,
      );
    }
  });
});

test("asset-path prints the shared host path and refuses the bad references", async () => {
  await withHost(async (host) => {
    for (const row of vectors.folderRefs) {
      const { owner, scope, kind, slug } = row.ref;
      const result = await host.run(["asset-path", owner, scope, kind, slug]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(
        result.stdout.trim(),
        row.host.replace("/srv/users", host.path("srv/users")),
      );
    }
    for (const row of vectors.badFolderRefs) {
      // Only references that are four strings reach the shell; the wire
      // shape (extra fields, not an object) is the contract parser's.
      const keys = Object.keys(row.ref ?? {}).sort().join(",");
      if (keys !== "kind,owner,scope,slug") continue;
      const { owner, scope, kind, slug } = row.ref;
      if ([owner, scope, kind, slug].some((v) => typeof v !== "string")) {
        continue;
      }
      assertEquals(
        await assetPath(host, owner, scope, kind, slug),
        false,
        row.why,
      );
    }
    await refused(host, ["asset-path", "alice", "production", "service"]);
    await refused(host, ["asset-path", "alice", "production", "other", "x"]);
  });
});

function installDir(
  host: Host,
  rel: string,
  mode: string,
  owner: string,
  group: string,
) {
  return host.run([
    "install",
    "-d",
    "-m",
    mode,
    "-o",
    owner,
    "-g",
    group,
    host.path(rel),
  ]);
}

/** Create the root-owned chain down to a service folder. */
async function buildService(host: Host): Promise<void> {
  await Deno.mkdir(host.path(`${HOME}/home`), { recursive: true });
  await Deno.chmod(host.path(HOME), 0o750);
  for (
    const rel of [
      `${HOME}/production`,
      `${HOME}/production/services`,
      `${HOME}/production/volumes`,
      SERVICE,
      `${SERVICE}/releases`,
    ]
  ) {
    const made = await installDir(host, rel, "0750", "root", "alice");
    assertEquals(made.code, 0, `${rel}: ${made.stderr}`);
  }
  for (const leaf of ["shared", "logs"]) {
    const made = await installDir(
      host,
      `${SERVICE}/${leaf}`,
      "0750",
      "alice",
      "alice",
    );
    assertEquals(made.code, 0, `${leaf}: ${made.stderr}`);
  }
}

test("the scope tree is built root-owned down to the writable leaves", async () => {
  await withHost(async (host) => {
    await buildService(host);
    const volume = await installDir(
      host,
      `${HOME}/production/volumes/uploads`,
      "0750",
      "alice",
      "alice",
    );
    assertEquals(volume.code, 0, volume.stderr);
    const common = await installDir(
      host,
      `${HOME}/common`,
      "0750",
      "root",
      "alice",
    );
    assertEquals(common.code, 0, common.stderr);
    const chowns = (await installDir(
      host,
      `${SERVICE}/shared`,
      "0750",
      "alice",
      "alice",
    )).stdout;
    assertStringIncludes(chowns, "EXEC [chown] [-h] [--] [alice:alice]");
  });
});

test("the scope tree refuses what the position rules forbid", async () => {
  await withHost(async (host) => {
    await buildService(host);
    const cases: Array<[string, string, string, string, string]> = [
      // An owner-owned scope, services or service folder could be renamed away.
      [`${HOME}/staging`, "0750", "alice", "alice", "owner-owned scope folder"],
      [
        `${HOME}/production/services`,
        "0750",
        "alice",
        "alice",
        "owner-owned services folder",
      ],
      [`${SERVICE}`, "0750", "alice", "alice", "owner-owned service folder"],
      [`${SERVICE}/releases`, "0750", "alice", "alice", "owner-owned releases"],
      // Structural folders close to group writes and to everyone else.
      [`${HOME}/staging`, "0770", "root", "alice", "group-writable scope"],
      [`${HOME}/staging`, "0755", "root", "alice", "world-readable scope"],
      // Names: reserved, uppercase, outside the rules, in the wrong place.
      [`${HOME}/services`, "0750", "root", "alice", "reserved scope"],
      [`${HOME}/backup`, "0750", "root", "alice", "reserved scope"],
      [`${HOME}/base`, "0750", "root", "alice", "reserved scope"],
      [`${HOME}/Staging`, "0750", "root", "alice", "uppercase scope"],
      [
        `${HOME}/production/other`,
        "0750",
        "root",
        "alice",
        "not services or volumes",
      ],
      [
        `${HOME}/production/services/Bad_Name`,
        "0750",
        "root",
        "alice",
        "uppercase service",
      ],
      [
        `${HOME}/production/services/a..b`,
        "0750",
        "root",
        "alice",
        "dots in a row",
      ],
      [
        `${HOME}/production/services/-a`,
        "0750",
        "root",
        "alice",
        "leading dash",
      ],
      [
        `${SERVICE}/extra`,
        "0750",
        "alice",
        "alice",
        "unknown entry in a service",
      ],
      [
        `${SERVICE}/releases/${RELEASE_ID}`,
        "0750",
        "root",
        "alice",
        "release outside publish",
      ],
    ];
    for (const [rel, mode, owner, group, why] of cases) {
      const result = await installDir(host, rel, mode, owner, group);
      assertEquals(result.code === 0, false, why);
      assertEquals(result.stdout.includes("EXEC"), false, why);
    }
  });
});

test("rm leaves the scaffolding alone and removes a service or volume folder", async () => {
  await withHost(async (host) => {
    await buildService(host);
    for (
      const rel of [
        `${HOME}/production`,
        `${HOME}/production/services`,
        `${HOME}/production/volumes`,
      ]
    ) {
      const stderr = await refused(host, ["rm", "-rf", host.path(rel)]);
      assertStringIncludes(stderr, "refusing");
    }
    const removed = await host.run(["rm", "-rf", host.path(SERVICE)]);
    assertEquals(removed.code, 0, removed.stderr);
    await Deno.stat(host.path(SERVICE)).then(
      () => {
        throw new Error("service folder survived rm");
      },
      () => {},
    );
  });
});

test("principal-remove refuses an owner that still has service folders", async () => {
  await withHost(async (host) => {
    await buildService(host);
    const stderr = await refused(host, ["principal-remove", "alice"]);
    assertStringIncludes(stderr, "still has service folders");
  });
});

// --- publish into the scope tree ---------------------------------------------------

const STAGING = `srv/users/.tp-staging/${PUBLISH_ID}`;
const SIX = [
  "alice",
  "production",
  "example.com",
  SERVICE_ID,
  RELEASE_ID,
  PUBLISH_ID,
];

/** publish must fail; the chowns it printed before failing do not count. */
async function publishFails(host: Host, args: string[] = SIX): Promise<string> {
  const result = await host.run(["publish", ...args]);
  assertEquals(result.code === 0, false, `published ${args.join(" ")}`);
  return result.stderr;
}

async function openFolderRelease(host: Host): Promise<string> {
  await buildService(host);
  const opened = await host.run(["publish-open", ...SIX]);
  assertEquals(opened.code, 0, opened.stderr);
  const leaf = opened.stdout.trim().split("\n").at(-1) ?? "";
  assertEquals(leaf, host.path(STAGING));
  await Deno.writeTextFile(join(leaf, "index.html"), "built\n");
  return leaf;
}

test("six-word publish seals the release into the service and swaps current", async () => {
  await withHost(async (host) => {
    await openFolderRelease(host);
    const published = await host.run(["publish", ...SIX]);
    assertEquals(published.code, 0, published.stderr);
    const release = host.path(`${SERVICE}/releases/${RELEASE_ID}`);
    assertEquals(
      await Deno.readTextFile(join(release, "index.html")),
      "built\n",
    );
    assertEquals(
      await Deno.readLink(join(release, "shared")),
      "../../shared",
    );
    assertEquals(
      await Deno.readLink(host.path(`${SERVICE}/current`)),
      `releases/${RELEASE_ID}`,
    );
    assertEquals(((await Deno.stat(release)).mode ?? 0) & 0o7777, 0o550);
    // The staging leaf is gone.
    await Deno.stat(host.path(STAGING)).then(
      () => {
        throw new Error("staging leaf survived publish");
      },
      () => {},
    );
  });
});

test("six-word publish refuses ids and names outside the shared rules", async () => {
  await withHost(async (host) => {
    await buildService(host);
    const bad: Array<[number, string]> = [
      [0, "Alice"],
      [0, "nobody"],
      [1, "home"],
      [1, "Production"],
      [2, "a..b"],
      [2, "../x"],
      [3, "svc1"],
      [3, SERVICE_ID.toUpperCase()],
      [4, "20260927-120000"],
      [5, "alice.web.r1"],
    ];
    for (const [at, value] of bad) {
      const args = [...SIX];
      args[at] = value;
      await refused(host, ["publish-open", ...args]);
      await publishFails(host, args);
    }
    // Neither the old three words nor the new six: nothing in between.
    await refused(host, ["publish-open", "alice", "production", "example.com"]);
  });
});

test("six-word publish refuses a chain someone could rename", async () => {
  await withHost(async (host) => {
    await openFolderRelease(host);
    await Deno.chmod(host.path(`${HOME}/production/services`), 0o770);
    const stderr = await publishFails(host);
    assertStringIncludes(stderr, "not sealed");
  });
});

test("six-word publish refuses a planted release", async () => {
  await withHost(async (host) => {
    await openFolderRelease(host);
    await Deno.mkdir(host.path(`${SERVICE}/releases/${RELEASE_ID}`));
    const stderr = await publishFails(host);
    assertStringIncludes(stderr, "already exists");
  });
});

test("publish-open sweeps abandoned UUID leaves by age and keeps fresh ones", async () => {
  await withHost(async (host) => {
    await buildService(host);
    const stale = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e80";
    const fresh = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e81";
    await Deno.mkdir(host.path(`srv/users/.tp-staging/${stale}`), {
      recursive: true,
    });
    await Deno.mkdir(host.path(`srv/users/.tp-staging/${fresh}`));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await Deno.utime(host.path(`srv/users/.tp-staging/${stale}`), old, old);
    const opened = await host.run(["publish-open", ...SIX]);
    assertEquals(opened.code, 0, opened.stderr);
    await Deno.stat(host.path(`srv/users/.tp-staging/${stale}`)).then(
      () => {
        throw new Error("stale leaf survived");
      },
      () => {},
    );
    await Deno.stat(host.path(`srv/users/.tp-staging/${fresh}`));
  });
});

test("the staging area stays closed to the generic verbs under the new names", async () => {
  await withHost(async (host) => {
    await openFolderRelease(host);
    await refused(host, ["rm", "-rf", host.path(STAGING)]);
    await refused(host, [
      "install",
      "-d",
      "-m",
      "0700",
      host.path(`${STAGING}/sub`),
    ]);
  });
});

// --- the SFTP jail check ------------------------------------------------------------

async function jailedAlice(host: Host): Promise<void> {
  await buildService(host);
  await Deno.mkdir(host.path(`${HOME}/production/volumes/uploads`));
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
    group.replace("tpsftp:x:9986:", "tpsftp:x:9986:alice"),
  );
  for (const leaf of ["public", "shared", "logs"]) {
    await Deno.mkdir(host.path(`${SERVICE}/${leaf}`), { recursive: true });
  }
  await Deno.symlink(
    `releases/${RELEASE_ID}`,
    host.path(`${SERVICE}/current`),
  );
  await Deno.mkdir(host.path(`${SERVICE}/.turbopanel-hosting`));
}

test("the SFTP check passes on a well-formed scope tree", async () => {
  await withHost(async (host) => {
    await jailedAlice(host);
    const check = await host.run(["sftp-chroot", "check"]);
    assertEquals(check.code, 0, check.stdout + check.stderr);
    assertEquals((await host.run(["sftp-chroot", "on"])).code, 0);
  });
});

test("the SFTP check names each owner-writable structural folder and on refuses", async () => {
  await withHost(async (host) => {
    await jailedAlice(host);
    for (
      const rel of [
        `${HOME}/production`,
        `${HOME}/production/services`,
        `${HOME}/production/volumes`,
        SERVICE,
        `${SERVICE}/releases`,
        `${SERVICE}/.turbopanel-hosting`,
      ]
    ) {
      await Deno.chmod(host.path(rel), 0o770);
      const check = await host.run(["sftp-chroot", "check"]);
      assertEquals(check.code === 0, false, rel);
      assertStringIncludes(
        check.stdout,
        `alice: ${host.path(rel)} is not a root-owned directory`,
      );
      const stderr = await refused(host, ["sftp-chroot", "on"]);
      assertStringIncludes(stderr, "refusing to switch on");
      await Deno.chmod(host.path(rel), 0o750);
    }
    const check = await host.run(["sftp-chroot", "check"]);
    assertEquals(check.code, 0, check.stdout);
  });
});

test("the SFTP check refuses links, strays and bad names in the tree", async () => {
  await withHost(async (host) => {
    await jailedAlice(host);
    // A leaf that is a link out of the jail.
    await Deno.remove(host.path(`${SERVICE}/shared`), { recursive: true });
    await Deno.symlink("/etc", host.path(`${SERVICE}/shared`));
    let check = await host.run(["sftp-chroot", "check"]);
    assertStringIncludes(check.stdout, `${SERVICE}/shared is not a directory`);
    await Deno.remove(host.path(`${SERVICE}/shared`));
    await Deno.mkdir(host.path(`${SERVICE}/shared`));

    // `current` must be a link, not a directory.
    await Deno.remove(host.path(`${SERVICE}/current`));
    await Deno.mkdir(host.path(`${SERVICE}/current`));
    check = await host.run(["sftp-chroot", "check"]);
    assertStringIncludes(
      check.stdout,
      `${SERVICE}/current is not a root-owned link`,
    );
    await Deno.remove(host.path(`${SERVICE}/current`));
    await Deno.symlink(
      `releases/${RELEASE_ID}`,
      host.path(`${SERVICE}/current`),
    );

    // A stray entry in a service, a stray scope-level entry, a bad scope name.
    await Deno.writeTextFile(host.path(`${SERVICE}/notes.txt`), "x");
    await Deno.writeTextFile(host.path(`${HOME}/production/notes.txt`), "x");
    await Deno.mkdir(host.path(`${HOME}/Staging`));
    check = await host.run(["sftp-chroot", "check"]);
    assertStringIncludes(
      check.stdout,
      "notes.txt is not part of a service folder",
    );
    assertStringIncludes(
      check.stdout,
      "production/notes.txt is not part of a scope folder",
    );
    assertStringIncludes(check.stdout, "Staging is not a scope folder");
  });
});

test("the SFTP check leaves the owner's home, data and tmp alone and seals the older sites and volumes", async () => {
  await withHost(async (host) => {
    await jailedAlice(host);
    for (const name of ["data", "tmp", "sites", "volumes"]) {
      await Deno.mkdir(host.path(`${HOME}/${name}`), { recursive: true });
    }
    const check = await host.run(["sftp-chroot", "check"]);
    assertEquals(check.code, 0, check.stdout + check.stderr);
    await Deno.chmod(host.path(`${HOME}/sites`), 0o770);
    const open = await host.run(["sftp-chroot", "check"]);
    assertEquals(open.code === 0, false);
    assertStringIncludes(open.stdout, `${HOME}/sites is not a root-owned`);
  });
});

test("new owner names follow the tightened rule", async () => {
  await withHost(async (host) => {
    const adds: Array<[string, boolean]> = [
      ["dana", true],
      ["Dana", false],
      ["a".repeat(28), true],
      ["a".repeat(29), false],
      ["dana-", false],
      ["da--na", false],
      ["1dana", false],
      ["tpdana", false],
      ["systemd-dana", false],
      ["dana-grp", false],
    ];
    for (const [name, ok] of adds) {
      const result = await host.run([
        "groupadd",
        "-g",
        "15500",
        name,
      ]);
      assertEquals(result.code === 0, ok, name);
    }
  });
});

test("principal-remove ignores an owner's own folders named services", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path(`${HOME}/home/services/x`), { recursive: true });
    await Deno.mkdir(host.path(`${HOME}/tmp/services/x`), { recursive: true });
    const result = await host.run(["principal-remove", "alice"]);
    assertEquals(result.stderr.includes("service folders"), false);
  });
});

test("mv leaves the scope, services and volumes folders in place", async () => {
  await withHost(async (host) => {
    await buildService(host);
    for (
      const [from, to] of [
        [`${HOME}/production`, `${HOME}/staging`],
        [`${HOME}/production/services`, `${HOME}/production/services2`],
        [`${HOME}/production/volumes`, `${HOME}/production/volumes2`],
      ]
    ) {
      await refused(host, ["mv", "-T", host.path(from), host.path(to)]);
    }
  });
});

test("the SFTP check accepts a current link left mid-swap and flags a hidden entry", async () => {
  await withHost(async (host) => {
    await jailedAlice(host);
    await Deno.symlink(
      `releases/${RELEASE_ID}`,
      host.path(`${SERVICE}/current.tmp.${PUBLISH_ID}`),
    );
    const ok = await host.run(["sftp-chroot", "check"]);
    assertEquals(ok.code, 0, ok.stdout);
    await Deno.writeTextFile(host.path(`${SERVICE}/.hidden`), "x");
    const bad = await host.run(["sftp-chroot", "check"]);
    assertStringIncludes(bad.stdout, ".hidden is not part of a service folder");
  });
});

test("an existing account with a name only new owners are barred from keeps working", async () => {
  await withHost(async (host) => {
    const passwd = await Deno.readTextFile(host.path("etc/passwd"));
    await Deno.writeTextFile(
      host.path("etc/passwd"),
      passwd + `git:x:15009:15009::${host.prefix}/srv/users/git:/bin/bash\n`,
    );
    const group = await Deno.readTextFile(host.path("etc/group"));
    await Deno.writeTextFile(host.path("etc/group"), group + "git:x:15009:\n");
    await Deno.mkdir(host.path("srv/users/git/svc/releases"), {
      recursive: true,
    });
    const opened = await host.run([
      "publish-open",
      "git",
      "svc",
      "r1",
    ]);
    assertEquals(opened.code, 0, opened.stderr);
    // A new account of that name is still refused.
    await refused(host, ["groupadd", "-g", "15500", "git"]);
  });
});

async function buildVolume(host: Host, slug: string): Promise<string> {
  const rel = `${HOME}/production/volumes/${slug}`;
  const made = await installDir(host, rel, "0750", "alice", "alice");
  assertEquals(made.code, 0, made.stderr);
  return host.path(rel);
}

test("folder-list prints the well-formed asset folders and ends with complete", async () => {
  await withHost(async (host) => {
    await buildService(host);
    await buildVolume(host, "uploads");
    // None of these is a folder the rules would have made.
    await Deno.mkdir(host.path(`${HOME}/production/volumes/Bad_Name`));
    await Deno.mkdir(host.path(`${HOME}/home/volumes/x`), { recursive: true });
    await Deno.symlink(
      host.path("outside"),
      host.path(`${HOME}/production/volumes/escape`),
    );
    await Deno.writeTextFile(host.path(`${HOME}/production/volumes/file`), "x");
    // A second scope of the same owner, and a second owner, keep their own names.
    await Deno.mkdir(host.path(`${HOME}/staging/volumes/second`), {
      recursive: true,
    });
    await Deno.mkdir(host.path("srv/users/bob/common/services/site"), {
      recursive: true,
    });
    const result = await host.run(["folder-list"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout.trim().split("\n"), [
      "alice production service example.com",
      "alice production volume uploads",
      "alice staging volume second",
      "bob common service site",
      "complete",
    ]);
  });
});

test("folder-list on a host with no owners says complete and nothing else", async () => {
  await withHost(async (host) => {
    const result = await host.run(["folder-list"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout.trim(), "complete");
  });
});

test("folder-list takes no arguments", async () => {
  await withHost(async (host) => {
    await refused(host, ["folder-list", "/etc"]);
  });
});

test("setfacl gives one uid access to a volume folder and nothing else", async () => {
  await withHost(async (host) => {
    await buildService(host);
    const volume = await buildVolume(host, "uploads");
    const spec = "u:1000:rwx,d:u:1000:rwx";
    const ok = await host.run(["setfacl", "-m", spec, "--", volume]);
    assertEquals(ok.code, 0, ok.stderr);
    assertStringIncludes(
      ok.stdout,
      `EXEC [setfacl] [-P] [-m] [${spec}] [--] [uploads]`,
    );
    const refusals: Array<[string[], string]> = [
      [["-m", "u:0:rwx,d:u:0:rwx", "--", volume], "root"],
      [["-m", "u:01000:rwx,d:u:01000:rwx", "--", volume], "leading zero"],
      [["-m", "u:1000:rwx,d:u:1001:rwx", "--", volume], "two uids"],
      [["-m", "u:1000:rw,d:u:1000:rw", "--", volume], "no execute"],
      [["-m", "u:1000:rwx", "--", volume], "no default entry"],
      [["-m", "g:1000:rwx,d:g:1000:rwx", "--", volume], "a group"],
      [["-m", "u:4294967295:rwx,d:u:4294967295:rwx", "--", volume], "too big"],
      [["-m", "u:app:rwx,d:u:app:rwx", "--", volume], "a name"],
      [["-m", `${spec},o::rwx`, "--", volume], "extra entry"],
      [["-m", spec, "--", host.path(SERVICE)], "a service folder"],
      [
        ["-m", spec, "--", host.path(`${HOME}/production/volumes`)],
        "the kind folder",
      ],
      [["-m", spec, "--", host.path(`${HOME}/production`)], "the scope folder"],
      [["-m", spec, "--", `${volume}/inner`], "inside a volume"],
      [["-m", spec, "--", host.path("etc")], "outside the owner tree"],
      [["-R", "-m", spec, "--", volume], "recursive"],
      [["-m", spec, volume], "no separator"],
    ];
    for (const [args, why] of refusals) {
      const stderr = await refused(host, ["setfacl", ...args]);
      assertEquals(stderr.length > 0, true, why);
    }
  });
});

test("setfacl refuses a volume folder that is a link", async () => {
  await withHost(async (host) => {
    await buildService(host);
    const link = host.path(`${HOME}/production/volumes/escape`);
    await Deno.symlink(host.path("outside"), link);
    await refused(host, [
      "setfacl",
      "-m",
      "u:1000:rwx,d:u:1000:rwx",
      "--",
      link,
    ]);
  });
});

test("folder-list does not say complete when an owner's home cannot be walked", async () => {
  await withHost(async (host) => {
    await buildService(host);
    // An owner home the helper cannot enter (a root helper can enter anything,
    // so there is nothing to check when running as root).
    const bad = host.path("srv/users/bob");
    await Deno.mkdir(bad, { recursive: true });
    await Deno.chmod(bad, 0o000);
    try {
      if (Deno.uid() === 0) return;
      const result = await host.run(["folder-list"]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(result.stdout.includes("complete"), false);
      assertStringIncludes(
        result.stdout,
        "alice production service example.com",
      );
    } finally {
      await Deno.chmod(bad, 0o700);
    }
  });
});
