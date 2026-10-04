/**
 * `tp-host publish-open` / `publish`: the only way a release reaches
 * `<home>/sites/<svc>/releases/<id>`. The daemon fills its own staging leaf;
 * publish seals it recursively as root, refuses hard links, special files and
 * symlinks that resolve outside it, renames it into place through a chain root
 * owns, and swaps `current`. In test mode the file mechanics run for real and
 * only the chowns are printed.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SITE = "srv/users/alice/sites/web";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** The site's root-owned skeleton, then an open staging leaf for `id`. */
async function openRelease(host: Host, id = "r1"): Promise<string> {
  await Deno.mkdir(host.path(`${SITE}/releases`), { recursive: true });
  await Deno.mkdir(host.path(`${SITE}/shared`), { recursive: true });
  const opened = await host.run(["publish-open", "alice", "web", id]);
  assertEquals(opened.code, 0, opened.stderr);
  // Test mode prints the chowns first; the leaf is the last line.
  const leaf = opened.stdout.trim().split("\n").at(-1) ?? "";
  assertEquals(leaf, host.path(`srv/users/.tp-staging/alice.web.${id}`));
  await Deno.writeTextFile(join(leaf, "index.html"), "built\n");
  return leaf;
}

/** publish must fail and leave neither the release nor the leaf behind. */
async function publishRefused(host: Host, id = "r1"): Promise<string> {
  const result = await host.run(["publish", "alice", "web", id]);
  assertEquals(result.code === 0, false, `published ${id}`);
  assertEquals(
    await exists(host.path(`srv/users/.tp-staging/alice.web.${id}`)),
    false,
    "the staging leaf survived a refused publish",
  );
  return result.stderr;
}

function mode(info: Deno.FileInfo): number {
  return (info.mode ?? 0) & 0o7777;
}

/** Every non-link entry under `dir` whose mode grants g/o write or set-id. */
async function unsealedEntries(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(join(dir, rel))) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    const info = await Deno.lstat(join(dir, path));
    if (info.isSymlink) continue;
    if ((mode(info) & 0o7022) !== 0) found.push(path);
    if (info.isDirectory) found.push(...await unsealedEntries(dir, path));
  }
  return found;
}

test("publish-open makes a fresh caller-owned leaf in a 0710 staging area", async () => {
  await withHost(async (host) => {
    const leaf = await openRelease(host);
    assertEquals(mode(await Deno.stat(join(leaf, ".."))), 0o710);
    assertEquals(mode(await Deno.stat(leaf)), 0o700);

    // A leaf a dead publish left behind is emptied, not reused.
    await Deno.writeTextFile(join(leaf, "stale"), "x");
    const again = await host.run(["publish-open", "alice", "web", "r1"]);
    assertEquals(again.code, 0, again.stderr);
    assertStringIncludes(again.stdout, "EXEC [chown] [-h] [--] [");
    assertEquals(await exists(join(leaf, "stale")), false);
  });
});

test("publish seals every entry, not only the top, and swaps current", async () => {
  await withHost(async (host) => {
    const leaf = await openRelease(host);
    await Deno.mkdir(join(leaf, "cache"), { mode: 0o777 });
    await Deno.chmod(join(leaf, "cache"), 0o777);
    await Deno.writeTextFile(join(leaf, "cache/data"), "x");
    await Deno.chmod(join(leaf, "cache/data"), 0o666);
    await Deno.writeTextFile(join(leaf, "tool"), "#!/bin/sh\n");
    await Deno.chmod(join(leaf, "tool"), 0o4755);
    await Deno.mkdir(join(leaf, "drop"));
    await Deno.chmod(join(leaf, "drop"), 0o1777);
    // In-tree links stay.
    await Deno.symlink("index.html", join(leaf, "home.html"));

    const result = await host.run(["publish", "alice", "web", "r1"]);
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(
      result.stdout,
      "EXEC [chown] [-R] [-h] [-P] [--] [root:alice-grp] [.]",
    );

    const release = host.path(`${SITE}/releases/r1`);
    assertEquals(mode(await Deno.stat(release)), 0o550);
    assertEquals(await unsealedEntries(release), []);
    // The sticky bit goes too, not only set-id and g/o write.
    assertEquals(mode(await Deno.stat(join(release, "drop"))), 0o750);
    assertEquals(await Deno.readLink(join(release, "shared")), "../../shared");
    assertEquals(
      await Deno.readLink(host.path(`${SITE}/current`)),
      "releases/r1",
    );
    assertEquals(await exists(leaf), false);
    assertEquals(await exists(host.path(`${SITE}/current.tmp.r1`)), false);
  });
});

test("publish refuses a symlink that resolves outside the release", async () => {
  const hostile: Array<[string, Array<[string, string]>]> = [
    ["another home", [["../../../../bob/sites/app/current", "bob"]]],
    // shared/ does not exist yet; once linked it is the tenant's to repoint.
    ["into shared", [["shared/uploads", "uploads"]]],
    ["shared itself", [["../shared", "public/s"]]],
    // Both look inside lexically; the kernel resolves x to the parent.
    ["two-link chain", [["../..", "s1/s2/up"], ["../up/..", "s1/s2/s3/x"]]],
  ];
  for (const [label, links] of hostile) {
    await withHost(async (host) => {
      const leaf = await openRelease(host);
      for (const [target, path] of links) {
        await Deno.mkdir(join(leaf, path, ".."), { recursive: true });
        await Deno.symlink(target, join(leaf, path));
      }
      const stderr = await publishRefused(host);
      assertStringIncludes(stderr, "resolves outside the release", label);
      assertEquals(await exists(host.path(`${SITE}/releases/r1`)), false);
      assertEquals(await exists(host.path(`${SITE}/current`)), false);
    });
  }
});

test("publish refuses absolute symlinks, the staging path included", async () => {
  await withHost(async (host) => {
    // Inside the leaf at check time, dangling or another leaf once renamed.
    const leaf = await openRelease(host);
    await Deno.symlink(join(leaf, "index.html"), join(leaf, "self"));
    assertStringIncludes(await publishRefused(host), "absolute symlink");

    const leaf2 = await openRelease(host);
    await Deno.symlink("/etc/passwd", join(leaf2, "passwd"));
    assertStringIncludes(await publishRefused(host), "absolute symlink");
  });
});

test("publish refuses hard links, special files and a shipped shared entry", async () => {
  await withHost(async (host) => {
    const leaf = await openRelease(host);
    await Deno.link(host.path("outside/secret"), join(leaf, "secret"));
    assertStringIncludes(await publishRefused(host), "hard-linked file");

    const leaf2 = await openRelease(host);
    const fifo = await new Deno.Command("mkfifo", {
      args: [join(leaf2, "pipe")],
    }).output();
    assertEquals(fifo.success, true);
    assertStringIncludes(await publishRefused(host), "special file");

    const leaf3 = await openRelease(host);
    await Deno.symlink("index.html", join(leaf3, "shared"));
    assertStringIncludes(await publishRefused(host), "its own shared entry");
  });
});

test("publish refuses a planted release and a planted current", async () => {
  await withHost(async (host) => {
    // A directory already at releases/<id> is never merged into.
    await openRelease(host);
    await Deno.mkdir(host.path(`${SITE}/releases/r1`));
    assertStringIncludes(await publishRefused(host), "already exists");
    await Deno.remove(host.path(`${SITE}/releases/r1`));

    // A planted current.tmp.<id>/ would be linked into and renamed over
    // current, publishing whatever it holds.
    const planted = host.path(`${SITE}/current.tmp.r2`);
    await Deno.mkdir(planted);
    await Deno.writeTextFile(join(planted, "index.html"), "forged\n");
    await openRelease(host, "r2");
    const result = await host.run(["publish", "alice", "web", "r2"]);
    assertEquals(result.code === 0, false, "swapped through a planted dir");
    assertStringIncludes(result.stderr, "not a link");
    assertEquals(await exists(host.path(`${SITE}/current`)), false);

    // A real directory at current is refused, not renamed over.
    await Deno.remove(planted, { recursive: true });
    await Deno.mkdir(host.path(`${SITE}/current`));
    await openRelease(host, "r3");
    const swap = await host.run(["publish", "alice", "web", "r3"]);
    assertEquals(swap.code === 0, false, "renamed over a current directory");
    assertStringIncludes(swap.stderr, "a directory, not a link");
  });
});

test("the generic ln never links into a planted directory", async () => {
  await withHost(async (host) => {
    // The rollback swap's argv: a planted current.tmp/ must not receive the
    // link (mv -T would then rename the planted tree over current).
    const planted = host.path(`${SITE}/current.tmp.r1`);
    await Deno.mkdir(join(planted), { recursive: true });
    await refused(host, ["ln", "-s", "--", "releases/r1", planted]);
    assertEquals(await exists(join(planted, "r1")), false);
  });
});

test("publish refuses a releases chain someone else could rename", async () => {
  await withHost(async (host) => {
    await openRelease(host);
    await Deno.chmod(host.path(SITE), 0o777);
    assertStringIncludes(await publishRefused(host), "not sealed");
    await Deno.chmod(host.path(SITE), 0o750);

    // A releases/ swapped for a link is refused by the pin.
    await Deno.rename(
      host.path(`${SITE}/releases`),
      host.path(`${SITE}/releases.real`),
    );
    await Deno.symlink("releases.real", host.path(`${SITE}/releases`));
    await openRelease(host);
    await publishRefused(host);
    assertEquals(await exists(host.path(`${SITE}/releases.real/r1`)), false);
  });
});

test("publish takes ids only, for a principal, from an open leaf", async () => {
  await withHost(async (host) => {
    await openRelease(host);
    for (
      const args of [
        ["publish"],
        ["publish", "alice", "web"],
        ["publish", "alice", "web", "r1", "extra"],
        ["publish", "tp", "web", "r1"],
        ["publish", "root", "web", "r1"],
        ["publish", "alice", "../web", "r1"],
        ["publish", "alice", "web", "r.1"],
        ["publish", "alice", "web", "-r1"],
        ["publish-open", "alice", "web", "../r1"],
        ["publish-open", "nobody", "web", "r1"],
      ]
    ) {
      await refused(host, args);
    }
    // Nothing to publish without a leaf.
    const none = await host.run(["publish", "alice", "web", "r9"]);
    assertStringIncludes(none.stderr, "no staging directory");
    assertEquals(await exists(host.path(`${SITE}/releases/r9`)), false);
  });
});

test("the staging area and release directories are closed to generic verbs", async () => {
  await withHost(async (host) => {
    const leaf = await openRelease(host);
    const release = host.path(`${SITE}/releases/r1`);
    for (
      const args of [
        ["install", "-d", "-m", "0700", leaf],
        ["mkdir", "-p", "--", join(leaf, "x")],
        ["rm", "-rf", "--", leaf],
        ["chown", "-R", "root:alice-grp", leaf],
        ["chmod", "0755", leaf],
        ["ln", "-s", "--", "../../shared", join(leaf, "shared")],
        [
          "install",
          "-d",
          "-m",
          "0750",
          "-o",
          "root",
          "-g",
          "alice-grp",
          release,
        ],
        ["mkdir", "-p", "--", release],
        ["mkdir", "-p", "--", join(release, ".turbopanel")],
        ["cp", "-a", "--", `${leaf}/.`, release],
      ]
    ) {
      await refused(host, args);
    }
    assertEquals(await exists(release), false);
  });
});

test("publish-open and publish wait for another call on the same release", async () => {
  await withHost(async (host) => {
    await openRelease(host);
    const lock = host.path("run/tp-publish/alice.web.r1.lock");
    assertEquals(await exists(lock), true);
    const holder = new Deno.Command("flock", {
      args: [lock, "sleep", "1.5"],
    }).spawn();
    // Let the holder take the lock first.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const again = await host.run(["publish-open", "alice", "web", "r1"]);
    const waited = Date.now() - started;
    await holder.status;
    assertEquals(again.code, 0, again.stderr);
    assertEquals(waited >= 900, true, `did not wait (${waited} ms)`);
  });
});

test("publish-open sweeps abandoned leaves and keeps fresh ones", async () => {
  await withHost(async (host) => {
    const fresh = await openRelease(host, "r1");
    const stale = host.path("srv/users/.tp-staging/alice.web.old");
    await Deno.mkdir(stale);
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    await Deno.utime(stale, old, old);
    const opened = await host.run(["publish-open", "alice", "web", "r2"]);
    assertEquals(opened.code, 0, opened.stderr);
    assertEquals(await exists(stale), false);
    assertEquals(await exists(fresh), true);
  });
});

test("publish-open refuses a home root others can write", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path(`${SITE}/releases`), { recursive: true });
    await Deno.chmod(host.path("srv/users"), 0o777);
    try {
      const opened = await host.run(["publish-open", "alice", "web", "r1"]);
      assertEquals(opened.code === 0, false, "opened under a writable root");
      assertStringIncludes(opened.stderr, "not sealed");
      assertEquals(await exists(host.path("srv/users/.tp-staging")), false);
    } finally {
      await Deno.chmod(host.path("srv/users"), 0o755);
    }
  });
});

test("the home root is never handed to anyone but root", async () => {
  await withHost(async (host) => {
    const root = host.path("srv/users");
    for (const owner of [["tp"], ["tp", "tp"], ["root", "tp"], ["alice"]]) {
      const args = ["install", "-d", "-m", "0750", "-o", owner[0]];
      if (owner[1]) args.push("-g", owner[1]);
      await refused(host, [...args, root]);
    }
    const ok = await host.run([
      "install",
      "-d",
      "-m",
      "0750",
      "-o",
      "root",
      "-g",
      "root",
      root,
    ]);
    assertEquals(ok.code, 0, ok.stderr);
  });
});
