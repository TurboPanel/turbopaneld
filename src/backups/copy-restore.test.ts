import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import type { StorageRestorePayload } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { digestFileSha256 } from "../managed/backup.ts";
import { copyTargetLockPath } from "../managed/target-lock.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  COPY_BACKUP_HELPER_IMAGE,
  copyBackupArtifactPath,
} from "./copy-backup.ts";
import {
  handleStorageRestore,
  mountUsesCopy,
  recoverInterruptedRestores,
  RESTORE_SCRIPT,
  restoreArgv,
  restoreIntentDir,
  type StorageRestoreHandlerDeps,
} from "./copy-restore.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const COPY = "0192f1de-7c3b-7e4a-9f10-0000000000c1";
const VOLUME = "0192f1de-7c3b-7e4a-9f10-0000000000b1";
const POLICY = "0192f1de-7c3b-7e4a-9f10-0000000000d1";
const NOW = new Date("2026-09-30T04:00:00.000Z");
const WEB = "a".repeat(64);
const WORKER = "b".repeat(64);
const OTHER = "c".repeat(64);

function ok(stdout = ""): DockerCliResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(code: number, stderr = ""): DockerCliResult {
  return { success: false, code, stdout: "", stderr };
}

/** `docker inspect` output: WEB and WORKER mount the copy's volume, OTHER does not. */
const INSPECT = JSON.stringify([
  {
    Id: WEB,
    Mounts: [{ Type: "volume", Name: VOLUME, Destination: "/data" }],
  },
  {
    Id: OTHER,
    Mounts: [{ Type: "volume", Name: "shop_cache", Destination: "/cache" }],
  },
  {
    Id: WORKER,
    Mounts: [
      { Type: "bind", Source: "/etc/localtime" },
      { Type: "volume", Name: VOLUME, Destination: "/srv" },
    ],
  },
]);

type FakeDocker = {
  calls: string[];
  /** Per-call overrides keyed by the call's first two words (e.g. `stop <id>`). */
  answers: Map<string, DockerCliResult | Error>;
  run: (args: string[]) => Promise<DockerCliResult>;
};

/** Records each call as a short label: the helper run is `run helper`. */
function fakeDocker(): FakeDocker {
  const fake: FakeDocker = {
    calls: [],
    answers: new Map(),
    run: (args) => {
      const label = args[0] === "run"
        ? "run helper"
        : args.slice(0, 2).join(" ");
      fake.calls.push(label);
      const answer = fake.answers.get(label);
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer) return Promise.resolve(answer);
      if (args[0] === "volume") {
        return Promise.resolve(
          ok(JSON.stringify({ Driver: "local", Labels: {} })),
        );
      }
      if (args[0] === "ps") {
        return Promise.resolve(ok(`${WEB}\n${OTHER}\n${WORKER}\n`));
      }
      if (args[0] === "inspect") {
        const asked = new Set(args.slice(1));
        const listed = (JSON.parse(INSPECT) as { Id: string }[]).filter((c) =>
          asked.has(c.Id)
        );
        return Promise.resolve(ok(JSON.stringify(listed)));
      }
      return Promise.resolve(ok());
    },
  };
  return fake;
}

async function withLayout(fn: (layout: LayoutPaths) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "tp-copy-restore-" });
  try {
    await fn(
      resolveLayout({
        TURBOPANEL_STATE_DIR: join(root, "state"),
        TURBOPANEL_BACKUP_DIR: join(root, "backup"),
        TURBOPANEL_RUN_DIR: join(root, "run"),
      }, { skipDiscovery: true, forceMode: "production" }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** Writes an artifact for `backupId` and returns a payload carrying its real checksum. */
async function artifact(
  layout: LayoutPaths,
  overrides: Partial<StorageRestorePayload> = {},
): Promise<StorageRestorePayload> {
  const payload: StorageRestorePayload = {
    copyId: COPY,
    copyProvider: "docker",
    volumeName: VOLUME,
    storageId: VOLUME,
    backupId: "bk_one",
    checksum: "",
    ...overrides,
  };
  const path = copyBackupArtifactPath(
    layout,
    payload.copyId,
    payload.backupId,
    payload.policyId,
  );
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, "archive bytes");
  return { ...payload, checksum: await digestFileSha256(path), ...overrides };
}

function deps(
  layout: LayoutPaths,
  docker: FakeDocker,
): StorageRestoreHandlerDeps {
  return {
    layout,
    now: () => NOW,
    runDocker: docker.run,
    guard: {
      lstat: () => Promise.resolve({ isSymlink: false }),
      realPath: (path) => Promise.resolve(path),
    },
  };
}

const PREFLIGHT = ["image inspect", "volume inspect"];

test("restore stops exactly the containers mounting the copy, extracts, then starts them", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    const result = await handleStorageRestore(
      await artifact(layout),
      NOW.toISOString(),
      deps(layout, docker),
    );
    assertEquals(docker.calls, [
      ...PREFLIGHT,
      // The source is looked at again under the lock.
      "volume inspect",
      "ps -q",
      `inspect ${WEB}`,
      `stop ${WEB}`,
      `stop ${WORKER}`,
      "run helper",
      `start ${WEB}`,
      `start ${WORKER}`,
    ]);
    // The intent that would restart them after a crash is gone again.
    await assertRejects(
      () => Deno.stat(join(restoreIntentDir(layout), `${COPY}.json`)),
      Deno.errors.NotFound,
    );
    assertEquals(result.stopped, [WEB, WORKER]);
    assertEquals(result.restarted, [WEB, WORKER]);
    assertEquals(result.notRestarted, []);
    assertEquals(result.restoredAt, NOW.toISOString());
  });
});

test("a scheduled artifact is found under its policy directory", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    const result = await handleStorageRestore(
      await artifact(layout, { policyId: POLICY }),
      "",
      deps(layout, docker),
    );
    assertEquals(result.stopped, [WEB, WORKER]);
  });
});

test("a failed extract still starts every stopped container", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    docker.answers.set("run helper", fail(3, "tar: invalid magic"));
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      "could not be extracted; the copy was not changed",
    );
    assertEquals(docker.calls.slice(-3), [
      "run helper",
      `start ${WEB}`,
      `start ${WORKER}`,
    ]);
  });
});

test("a helper that cannot even be spawned still starts every stopped container", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    docker.answers.set("run helper", new Error("spawn docker ENOENT"));
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      "spawn docker ENOENT",
    );
    assertEquals(docker.calls.slice(-2), [`start ${WEB}`, `start ${WORKER}`]);
  });
});

test("a container that will not start again is reported, after a restore that worked", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    docker.answers.set(`start ${WORKER}`, fail(1, "port is already allocated"));
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      `restored backup bk_one, but could not restart ${WORKER}`,
    );
  });
});

test("a container that will not stop aborts the restore and the others start again", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    docker.answers.set(`stop ${WORKER}`, fail(1, "permission denied"));
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      "nothing was restored",
    );
    assertEquals(docker.calls.slice(-3), [
      `stop ${WEB}`,
      `stop ${WORKER}`,
      `start ${WEB}`,
    ]);
    assert(!docker.calls.includes("run helper"));
  });
});

test("a checksum mismatch or a missing artifact stops nothing", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    const payload = await artifact(layout);
    await assertRejects(
      () =>
        handleStorageRestore(
          { ...payload, checksum: "0".repeat(64) },
          "",
          deps(layout, docker),
        ),
      Error,
      "does not match its recorded checksum; nothing was stopped",
    );
    await assertRejects(
      () =>
        handleStorageRestore(
          { ...payload, backupId: "bk_gone" },
          "",
          deps(layout, docker),
        ),
      Error,
      "not on this host",
    );
    assertEquals(docker.calls, []);
  });
});

test("a missing volume or directory, or an unpullable image, stops nothing", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    docker.answers.set("volume inspect", fail(1, "no such volume"));
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      `docker volume ${VOLUME} not found`,
    );

    const pathPayload = await artifact(layout, {
      copyProvider: "path",
      volumeName: undefined,
      storageId: undefined,
      hostPath: "/srv/users/shop/volumes/uploads",
      ownerUsername: "shop",
    });
    await assertRejects(
      () =>
        handleStorageRestore(pathPayload, "", {
          ...deps(layout, docker),
          guard: {
            lstat: () => Promise.reject(new Deno.errors.NotFound("gone")),
          },
        }),
      Error,
      "directory /srv/users/shop/volumes/uploads not found",
    );

    docker.answers.set("image inspect", fail(1));
    docker.answers.set(
      "pull docker.io/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8",
      fail(1, "offline"),
    );
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      "could not pull the backup helper image",
    );
    assert(!docker.calls.some((call) => call.startsWith("stop")));
    assert(!docker.calls.includes("ps -q"));
  });
});

test("a directory outside the allowed roots is refused before any docker call", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    for (const hostPath of ["/var/lib/docker/volumes/x/_data", "/etc"]) {
      await assertRejects(
        async () =>
          await handleStorageRestore(
            await artifact(layout, {
              copyProvider: "path",
              volumeName: undefined,
              storageId: undefined,
              hostPath,
              ownerUsername: "shop",
            }),
            "",
            deps(layout, docker),
          ),
        Error,
      );
    }
    assertEquals(docker.calls, []);
  });
});

test("a restore waits for nobody: a held copy lock fails it before anything stops", async () => {
  await withLayout(async (layout) => {
    const payload = await artifact(layout);
    await Deno.mkdir(join(layout.runDir, "copy-locks"), { recursive: true });
    const holder = await Deno.open(copyTargetLockPath(layout, COPY), {
      create: true,
      write: true,
    });
    try {
      await holder.lock(true);
      const docker = fakeDocker();
      await assertRejects(
        () => handleStorageRestore(payload, "", deps(layout, docker)),
        Error,
        "busy",
      );
      assertEquals(docker.calls, PREFLIGHT);
    } finally {
      holder.close();
    }
  });
});

test("a stopped container is not started by a restore that did not stop it", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    docker.answers.set("ps -q", ok(`${OTHER}\n`));
    const result = await handleStorageRestore(
      await artifact(layout),
      "",
      deps(layout, docker),
    );
    assertEquals(result.stopped, []);
    assert(!docker.calls.some((call) => call.startsWith("start")));
  });
});

test("only the copy's own volume, or binds at or under its directory, count as using it", () => {
  const volume = { type: "volume" as const, name: VOLUME };
  assert(mountUsesCopy({ Type: "volume", Name: VOLUME }, volume));
  assert(!mountUsesCopy({ Type: "volume", Name: "shop_uploads2" }, volume));
  assert(!mountUsesCopy({ Type: "bind", Source: VOLUME }, volume));

  const dir = { type: "bind" as const, path: "/srv/users/shop/volumes/up" };
  assert(
    mountUsesCopy({ Type: "bind", Source: "/srv/users/shop/volumes/up" }, dir),
  );
  assert(
    mountUsesCopy(
      { Type: "bind", Source: "/srv/users/shop/volumes/up/img" },
      dir,
    ),
  );
  assert(
    !mountUsesCopy(
      { Type: "bind", Source: "/srv/users/shop/volumes/upload" },
      dir,
    ),
  );
  assert(!mountUsesCopy({ Type: "bind", Source: "/srv/users/shop" }, dir));
  assert(!mountUsesCopy({ Type: "volume", Name: "up" }, dir));
});

test("the helper mounts the copy read-write and the archive read-only, offline", () => {
  const argv = restoreArgv(
    { type: "volume", name: VOLUME },
    "/var/lib/turbopanel/backups/copies/c/bk_one.tar.gz",
  );
  const mounts = argv.flatMap((arg, i) =>
    argv[i - 1] === "--mount" ? [arg] : []
  );
  assertEquals(mounts, [
    `type=volume,src=${VOLUME},dst=/dst`,
    "type=bind,src=/var/lib/turbopanel/backups/copies/c/bk_one.tar.gz,dst=/archive.tar.gz,readonly",
  ]);
  assertEquals(argv[argv.indexOf("--network") + 1], "none");
  assertEquals(argv[argv.indexOf("--pull") + 1], "never");
  assert(argv.includes("--read-only"));
  assertEquals(argv.slice(-4), [
    COPY_BACKUP_HELPER_IMAGE,
    "sh",
    "-c",
    RESTORE_SCRIPT,
  ]);
});

// The swap script itself, run by the host's sh and tar against temp
// directories standing in for the helper's /dst and /archive.tar.gz.

async function runScript(dst: string, archive: string): Promise<number> {
  const script = RESTORE_SCRIPT.replaceAll("/archive.tar.gz", archive)
    .replaceAll("/dst", dst);
  const { code } = await new Deno.Command("sh", {
    args: ["-c", script],
    stdout: "null",
    stderr: "null",
  }).output();
  return code;
}

async function tree(dir: string, prefix = ""): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      names.push(`${rel}/`, ...(await tree(join(dir, entry.name), `${rel}/`)));
    } else {names.push(
        `${rel}=${await Deno.readTextFile(join(dir, entry.name))}`,
      );}
  }
  return names.toSorted((a, b) => a.localeCompare(b));
}

async function withScriptDirs(
  fn: (dirs: { dst: string; archive: string; source: string }) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "tp-restore-script-" });
  try {
    const dirs = {
      dst: join(root, "dst"),
      source: join(root, "source"),
      archive: join(root, "archive.tar.gz"),
    };
    await Deno.mkdir(join(dirs.dst, "old dir"), { recursive: true });
    await Deno.writeTextFile(join(dirs.dst, "old dir", "x.txt"), "old");
    await Deno.writeTextFile(join(dirs.dst, ".hidden"), "old hidden");
    await Deno.writeTextFile(join(dirs.dst, "kept name"), "old value");
    await Deno.mkdir(join(dirs.source, "img"), { recursive: true });
    await Deno.writeTextFile(join(dirs.source, "img", "a b.png"), "new image");
    await Deno.writeTextFile(join(dirs.source, ".env"), "new hidden");
    await Deno.writeTextFile(join(dirs.source, "kept name"), "new value");
    await fn(dirs);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("the swap script replaces the copy's contents exactly, names with spaces and dotfiles included", async () => {
  await withScriptDirs(async ({ dst, archive, source }) => {
    const tar = await new Deno.Command("tar", {
      args: ["-C", source, "-czf", archive, "."],
    }).output();
    assert(tar.success);
    assertEquals(await runScript(dst, archive), 0);
    assertEquals(await tree(dst), await tree(source));
  });
});

test("the swap script leaves the copy untouched when the archive is unreadable", async () => {
  await withScriptDirs(async ({ dst, archive }) => {
    await Deno.writeTextFile(archive, "not a gzip stream");
    const before = await tree(dst);
    assertEquals(await runScript(dst, archive), 3);
    assertEquals(await tree(dst), before);
  });
});

async function tarOf(source: string, archive: string) {
  const tar = await new Deno.Command("tar", {
    args: ["-C", source, "-czf", archive, "."],
  }).output();
  assert(tar.success);
}

test("an earlier restore that did not finish keeps its old data: the script refuses and touches nothing", async () => {
  await withScriptDirs(async ({ dst, archive, source }) => {
    await tarOf(source, archive);
    const old = join(dst, ".tp-restore-old");
    await Deno.mkdir(old);
    await Deno.writeTextFile(join(old, "precious"), "only copy");
    const before = await tree(dst);
    assertEquals(await runScript(dst, archive), 6);
    assertEquals(await tree(dst), before);
  });
});

test("an earlier restore that finished but did not clean up is cleaned, then the restore runs", async () => {
  await withScriptDirs(async ({ dst, archive, source }) => {
    await tarOf(source, archive);
    const old = join(dst, ".tp-restore-old");
    await Deno.mkdir(old);
    await Deno.writeTextFile(join(old, "stale"), "from a finished restore");
    await Deno.writeTextFile(join(dst, ".tp-restore-done"), "");
    assertEquals(await runScript(dst, archive), 0);
    assertEquals(await tree(dst), await tree(source));
  });
});

test("a restore failing with exit 6 reports why and starts the containers again", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    docker.answers.set("run helper", fail(6));
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      "an earlier restore did not finish",
    );
    assert(docker.calls.includes(`start ${WEB}`));
  });
});

test("the intent is written before anything stops, and kept for the ones that would not start", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    const seen: string[] = [];
    const run = docker.run;
    docker.run = async (args) => {
      if (args[0] === "stop") {
        seen.push(
          await Deno.readTextFile(
            join(restoreIntentDir(layout), `${COPY}.json`),
          ),
        );
      }
      return run(args);
    };
    docker.answers.set(`start ${WORKER}`, fail(1));
    await assertRejects(
      async () =>
        await handleStorageRestore(
          await artifact(layout),
          "",
          deps(layout, docker),
        ),
      Error,
      "could not restart",
    );
    const first = JSON.parse(seen[0]);
    assertEquals(first.containers, [WEB, WORKER]);
    assertEquals(first.helper, `tp-restore-${COPY}`);
    const kept = JSON.parse(
      await Deno.readTextFile(join(restoreIntentDir(layout), `${COPY}.json`)),
    );
    assertEquals(kept.containers, [WORKER]);
  });
});

test("daemon start restarts what a killed restore stopped, unless its helper still runs", async () => {
  await withLayout(async (layout) => {
    const dir = restoreIntentDir(layout);
    await Deno.mkdir(dir, { recursive: true });
    const write = (copyId: string, helper: string) =>
      Deno.writeTextFile(
        join(dir, `${copyId}.json`),
        JSON.stringify({ copyId, helper, containers: [WEB, WORKER] }),
      );
    await write(COPY, "tp-restore-dead");
    const docker = fakeDocker();
    docker.answers.set("ps -q", ok(""));
    assertEquals(await recoverInterruptedRestores(layout, docker.run), 1);
    assertEquals(docker.calls, ["ps -q", `start ${WEB}`, `start ${WORKER}`]);
    await assertRejects(
      () => Deno.stat(join(dir, `${COPY}.json`)),
      Deno.errors.NotFound,
    );

    await write(COPY, "tp-restore-alive");
    const alive = fakeDocker();
    alive.answers.set("ps -q", ok("abc\n"));
    assertEquals(await recoverInterruptedRestores(layout, alive.run), 0);
    assertEquals(alive.calls, ["ps -q"]);
    await Deno.stat(join(dir, `${COPY}.json`));
  });
});

test("a restore refuses a symlinked directory or another owner's directory before stopping anything", async () => {
  await withLayout(async (layout) => {
    const docker = fakeDocker();
    const pathPayload = await artifact(layout, {
      copyProvider: "path",
      volumeName: undefined,
      storageId: undefined,
      hostPath: "/srv/users/shop/volumes/uploads",
      ownerUsername: "shop",
    });
    await assertRejects(
      () =>
        handleStorageRestore(pathPayload, "", {
          ...deps(layout, docker),
          guard: {
            lstat: (p) =>
              Promise.resolve({ isSymlink: p.endsWith("/volumes/uploads") }),
            realPath: (p) => Promise.resolve(p),
          },
        }),
      Error,
      "symbolic link",
    );
    await assertRejects(
      () =>
        handleStorageRestore(
          { ...pathPayload, ownerUsername: "other" },
          "",
          deps(layout, docker),
        ),
      Error,
      "volumes directory",
    );
    await assertRejects(
      async () =>
        await handleStorageRestore(
          { ...(await artifact(layout)), volumeName: "someone_elses_data" },
          "",
          deps(layout, docker),
        ),
      Error,
      "does not belong",
    );
    assert(!docker.calls.some((c) => c.startsWith("stop")));
    assert(!docker.calls.includes("run helper"));
  });
});
