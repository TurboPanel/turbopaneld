import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withTempGitRepo } from "../testing/temp-git-repo.ts";
import {
  createDevRoot,
  type DevRootFixture,
  fakeRun,
  type RecordedCall,
  unitsActiveSince,
} from "../testing/dev-host-fixture.ts";
import { devHostParts, type DevHostPartSpec } from "./config.ts";
import { readHead, readRef, REMOTE_TRUNK_REF } from "./git.ts";
import {
  anyFileNewer,
  DevHostStatusCollector,
  FETCH_INTERVAL_MS,
  installNeeded,
} from "./status.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const START_SEC = 1_700_000_000;

function spec(name: DevHostPartSpec["name"]): DevHostPartSpec {
  const found = devHostParts({}).find((p) => p.name === name);
  if (!found) throw new TypeError(name);
  return found;
}

const unitsAnswer = unitsActiveSince(START_SEC);

async function withRoot(
  folders: Record<string, Record<string, string>>,
  fn: (fx: DevRootFixture) => Promise<void>,
): Promise<void> {
  const fx = await createDevRoot(folders);
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

test("HEAD and refs are read from files, packed-refs included", async () => {
  await withTempGitRepo(async (repo) => {
    assertEquals(await readHead(repo.path), {
      branch: "main",
      commit: repo.head,
    });
    await repo.git("update-ref", REMOTE_TRUNK_REF, repo.head);
    await repo.git("pack-refs", "--all");
    assertEquals(await readRef(repo.path, REMOTE_TRUNK_REF), repo.head);
    assertEquals(await readHead(repo.path), {
      branch: "main",
      commit: repo.head,
    });
    await repo.git("checkout", "-q", "--detach");
    assertEquals(await readHead(repo.path), {
      branch: null,
      commit: repo.head,
    });
  });
});

test("a worktree checkout reads its own HEAD and the shared refs", async () => {
  await withTempGitRepo(async (repo) => {
    const wt = join(repo.path, "..", `${repo.path.split("/").at(-1)}-wt`);
    await repo.git("worktree", "add", "-q", "-b", "trunk", wt);
    try {
      assertEquals(await readHead(wt), { branch: "trunk", commit: repo.head });
    } finally {
      await repo.git("worktree", "remove", "--force", wt);
    }
  });
});

test("not a checkout reads as null", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readHead(dir), null);
    assertEquals(await readRef(dir, REMOTE_TRUNK_REF), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("behindBy counts new trunk commits; rev-list runs only when refs move", async () => {
  await withRoot({ ui: { "a.txt": "1\n" } }, async (fx) => {
    await fx.origins.ui.write("a.txt", "2\n");
    await fx.origins.ui.commit("two");
    await fx.origins.ui.write("a.txt", "3\n");
    await fx.origins.ui.commit("three");
    const calls: RecordedCall[] = [];
    let now = 1_000_000;
    const collector = new DevHostStatusCollector({
      paths: { devRoot: fx.root },
      parts: [spec("web-interface")],
      run: fakeRun(calls, { answer: unitsAnswer }),
      nowMs: () => now,
      daemonCommit: null,
      anyNewer: () => Promise.resolve(false),
    });
    const first = await collector.collect(null);
    const part = first.parts[0];
    assertEquals(part.behindBy, 2);
    assertEquals(part.onTrunk, true);
    assertEquals(part.branch, "trunk");
    assertEquals(part.active, true);
    assertEquals(part.blockedReason, undefined);
    assertEquals(first.lastFetchAt, new Date(now).toISOString());
    const gitArgs = () =>
      calls.filter((c) => c.program === "git").map((c) => c.args[2]);
    assertEquals(gitArgs(), ["fetch", "rev-list", "status"]);

    calls.length = 0;
    now += 60_000;
    const second = await collector.collect(null);
    assertEquals(second.parts[0].behindBy, 2);
    // No fetch inside 10 minutes and no rev-list for unchanged refs.
    assertEquals(gitArgs(), ["status"]);

    calls.length = 0;
    now += FETCH_INTERVAL_MS;
    await collector.collect(null);
    assertEquals(gitArgs(), ["fetch", "status"]);
  });
});

test("a checkout on another branch is reported, not pulled", async () => {
  await withRoot({ turbopanel: { "a.txt": "1\n" } }, async (fx) => {
    await fx.git("turbopanel", "checkout", "-q", "-b", "feat/x");
    const collector = new DevHostStatusCollector({
      paths: { devRoot: fx.root },
      parts: [spec("control-plane")],
      run: fakeRun([], { answer: unitsAnswer }),
      daemonCommit: null,
      anyNewer: () => Promise.resolve(false),
    });
    const [part] = (await collector.collect(null)).parts;
    assertEquals(part.onTrunk, false);
    assertEquals(part.branch, "feat/x");
    assertEquals(part.blockedReason, "on branch feat/x, not trunk; not pulled");
  });
});

test("local content changes are reported as blocking", async () => {
  await withRoot({ website: { "a.txt": "1\n" } }, async (fx) => {
    await Deno.writeTextFile(join(fx.root, "website", "a.txt"), "edited\n");
    const collector = new DevHostStatusCollector({
      paths: { devRoot: fx.root },
      parts: [spec("website")],
      run: fakeRun([], { answer: unitsAnswer }),
      daemonCommit: null,
    });
    const [part] = (await collector.collect(null)).parts;
    assertEquals(part.dirty.blocking, true);
    assertEquals(part.blockedReason, "has local changes; not pulled");
  });
});

test("a missing checkout is reported without running git", async () => {
  const root = await Deno.makeTempDir();
  try {
    const calls: RecordedCall[] = [];
    const collector = new DevHostStatusCollector({
      paths: { devRoot: root },
      parts: [spec("daemon")],
      run: fakeRun(calls, { answer: unitsAnswer }),
      daemonCommit: "a".repeat(40),
    });
    const [part] = (await collector.collect(null)).parts;
    assertEquals(part.blockedReason, "checkout missing");
    assertEquals(part.headCommit, "");
    assertEquals(part.branch, "");
    assertEquals(part.runningCommit, "a".repeat(40));
    assertEquals(calls.filter((c) => c.program === "git").length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("restartNeeded: a different running commit, a newer config file, newer source", async () => {
  await withRoot({
    turbopaneld: { "main.ts": "1\n", "src/a.ts": "1\n" },
    ui: { "package.json": "{}\n", "src/a.ts": "1\n" },
  }, async (fx) => {
    const daemonHead = (await readHead(join(fx.root, "turbopaneld")))!.commit!;
    const startMs = START_SEC * 1000;
    const mtimes = new Map<string, number>();
    const collector = new DevHostStatusCollector({
      paths: { devRoot: fx.root },
      parts: [spec("daemon"), spec("web-interface")],
      run: fakeRun([], { answer: unitsAnswer }),
      daemonCommit: daemonHead,
      mtimeMs: (path) => Promise.resolve(mtimes.get(path) ?? startMs - 1000),
      anyNewer: (dir) => Promise.resolve(dir.endsWith("turbopaneld/src")),
    });
    let status = await collector.collect(null);
    // The daemon's source tree is newer than its start; the web interface
    // only restarts for config files, so its source change does not count.
    assertEquals(status.parts.map((p) => p.restartNeeded), [true, false]);
    assertEquals(status.parts[0].runningCommit, daemonHead);

    mtimes.set(join(fx.root, "ui", "package.json"), startMs + 5000);
    status = await collector.collect(null);
    assertEquals(status.parts[1].restartNeeded, true);
  });

  await withRoot({ turbopaneld: { "main.ts": "1\n" } }, async (fx) => {
    const collector = new DevHostStatusCollector({
      paths: { devRoot: fx.root },
      parts: [spec("daemon")],
      run: fakeRun([], { answer: unitsAnswer }),
      daemonCommit: "b".repeat(40),
      mtimeMs: () => Promise.resolve(0),
      anyNewer: () => Promise.resolve(false),
    });
    assertEquals((await collector.collect(null)).parts[0].restartNeeded, true);
    assertEquals(await collector.restartNeeded(spec("daemon")), true);
  });
});

test("install is needed when the lockfile is newer than the installed packages", async () => {
  const repo = await Deno.makeTempDir();
  try {
    assertEquals(await installNeeded(repo), false);
    const times = new Map<string, number>([
      [join(repo, "pnpm-lock.yaml"), 2000],
    ]);
    const mtime = (p: string) => Promise.resolve(times.get(p) ?? null);
    assertEquals(await installNeeded(repo, mtime), true);
    times.set(join(repo, "node_modules", ".pnpm", "lock.yaml"), 3000);
    assertEquals(await installNeeded(repo, mtime), false);
    times.set(join(repo, "pnpm-lock.yaml"), 4000);
    assertEquals(await installNeeded(repo, mtime), true);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

test("anyFileNewer skips node_modules and dot folders", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await Deno.mkdir(join(dir, ".cache"), { recursive: true });
    await Deno.mkdir(join(dir, "lib"), { recursive: true });
    await Deno.writeTextFile(join(dir, "node_modules", "x", "i.js"), "1");
    await Deno.writeTextFile(join(dir, ".cache", "c"), "1");
    await Deno.writeTextFile(join(dir, "lib", "a.ts"), "1");
    const old = new Date(1_000_000);
    await Deno.utime(join(dir, "lib", "a.ts"), old, old);
    assertEquals(await anyFileNewer(dir, 2_000_000), false);
    await Deno.writeTextFile(join(dir, "lib", "b.ts"), "1");
    assertEquals(await anyFileNewer(dir, 2_000_000), true);
    assertEquals(await anyFileNewer(join(dir, "missing"), 0), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
