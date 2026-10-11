import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { CopyBackupSource } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  COPY_BACKUP_HELPER_IMAGE,
  copyArchiveArgv,
  copyBackupArtifactPath,
  type CopyBackupDeps,
  copyMountArg,
  createCopyBackupArtifact,
  ensureCopyBackupImage,
  resolveCopyMount,
} from "./copy-backup.ts";
import { mapSequential } from "../util/sequential.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const COPY = "0192f1de-7c3b-7e4a-9f10-0000000000c1";
const ORG = "0192f1de-7c3b-7e4a-9f10-0000000000a1";
const STORAGE = "0192f1de-7c3b-7e4a-9f10-0000000000b1";
const POLICY = "0192f1de-7c3b-7e4a-9f10-0000000000d1";

function layoutAt(root: string): LayoutPaths {
  return resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_LIB_DIR: `${root}/lib`,
      TURBOPANEL_LOG_DIR: `${root}/log`,
      TURBOPANEL_RUN_DIR: `${root}/run`,
      TURBOPANEL_BACKUP_DIR: `${root}/backup`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
}

const FIXED_LAYOUT = layoutAt("/var/lib/tp-copy-test");

async function withLayout(fn: (layout: LayoutPaths) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "tp-copy-backup-" });
  try {
    await fn(layoutAt(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function dockerResult(success: boolean, stderr = ""): DockerCliResult {
  return { success, code: success ? 0 : 1, stdout: "", stderr };
}

/** A `docker volume inspect` answer: an ordinary local volume carrying `labels`. */
function inspectResult(
  labels: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): DockerCliResult {
  return {
    success: true,
    code: 0,
    stdout: JSON.stringify({ Driver: "local", Labels: labels, ...extra }),
    stderr: "",
  };
}

function volumeSource(): CopyBackupSource {
  return {
    copyId: COPY,
    copyProvider: "docker",
    volumeName: STORAGE,
    storageId: STORAGE,
  };
}

const PATH_SOURCE: CopyBackupSource = {
  copyId: COPY,
  copyProvider: "path",
  hostPath: "/srv/users/shop/volumes/uploads",
  ownerUsername: "shop",
};

/** A tree with no links, whatever the path. */
const NO_LINKS = {
  lstat: () => Promise.resolve({ isSymlink: false }),
  realPath: (path: string) => Promise.resolve(path),
};

/** Records docker calls; the archive writes `bytes` unless `archiveError` is set. */
function fakeDeps(
  bytes: Uint8Array,
  calls: string[][],
  options: { volumeExists?: boolean; archiveError?: string } = {},
): CopyBackupDeps {
  return {
    runDocker: (args) => {
      calls.push(args);
      if (args[0] === "volume") {
        return Promise.resolve(
          options.volumeExists === false
            ? dockerResult(false)
            : inspectResult(),
        );
      }
      return Promise.resolve(dockerResult(true));
    },
    guard: NO_LINKS,
    runArchive: async (argv, destination) => {
      calls.push(argv);
      const writer = destination.getWriter();
      await writer.write(bytes);
      await writer.close();
      if (options.archiveError) {
        return { success: false, stderr: options.archiveError };
      }
      return { success: true, stderr: "" };
    },
  };
}

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.toSorted((a, b) => a.localeCompare(b));
}

test("resolveCopyMount mounts a docker copy by volume name", () => {
  assertEquals(resolveCopyMount(FIXED_LAYOUT, volumeSource()), {
    type: "volume",
    name: STORAGE,
  });
  assertThrows(
    () =>
      resolveCopyMount(FIXED_LAYOUT, { copyId: COPY, copyProvider: "docker" }),
    Error,
    "volume name",
  );
});

test("resolveCopyMount accepts a tenant directory and the default storage path", () => {
  assertEquals(
    resolveCopyMount(FIXED_LAYOUT, {
      copyId: COPY,
      copyProvider: "path",
      hostPath: "/srv/users/shop/volumes/uploads",
      ownerUsername: "shop",
    }),
    { type: "bind", path: "/srv/users/shop/volumes/uploads" },
  );
  assertEquals(
    resolveCopyMount(FIXED_LAYOUT, {
      copyId: COPY,
      copyProvider: "path",
      organizationId: ORG,
      storageId: STORAGE,
    }),
    {
      type: "bind",
      path: join(FIXED_LAYOUT.stateDir, "storage", ORG, STORAGE, COPY, "data"),
    },
  );
});

test("resolveCopyMount refuses host paths outside the allowed roots", () => {
  for (
    const hostPath of [
      "/var/lib/docker/volumes/shop_uploads/_data",
      "/etc",
      "/srv/users/../../etc",
      "relative/path",
    ]
  ) {
    assertThrows(() =>
      resolveCopyMount(FIXED_LAYOUT, {
        copyId: COPY,
        copyProvider: "path",
        hostPath,
        ownerUsername: "shop",
      })
    );
  }
  assertThrows(
    () =>
      resolveCopyMount(FIXED_LAYOUT, { copyId: COPY, copyProvider: "path" }),
    Error,
    "no usable host directory",
  );
});

test("the archive runs offline, read-only and from the pinned image", () => {
  const argv = copyArchiveArgv({
    type: "bind",
    path: "/srv/users/a/volumes/b",
  });
  assertEquals(argv[0], "run");
  assert(argv.includes("--rm"));
  assert(argv.includes("--read-only"));
  assertEquals(argv[argv.indexOf("--network") + 1], "none");
  assertEquals(argv[argv.indexOf("--pull") + 1], "never");
  assertEquals(argv[argv.indexOf("--security-opt") + 1], "no-new-privileges");
  assertEquals(
    argv[argv.indexOf("--mount") + 1],
    "type=bind,src=/srv/users/a/volumes/b,dst=/src,readonly",
  );
  assert(COPY_BACKUP_HELPER_IMAGE.includes("@sha256:"));
  assertEquals(argv.slice(argv.indexOf(COPY_BACKUP_HELPER_IMAGE)), [
    COPY_BACKUP_HELPER_IMAGE,
    "tar",
    "-C",
    "/src",
    "--exclude",
    "./.tp-restore-stage",
    "--exclude",
    "./.tp-restore-old",
    "--exclude",
    "./.tp-restore-done",
    "-czf",
    "-",
    ".",
  ]);
  assertEquals(
    copyMountArg({ type: "volume", name: "v" }, "/dst", false),
    "type=volume,src=v,dst=/dst",
  );
});

test("artifact paths refuse unsafe ids", () => {
  assertThrows(() => copyBackupArtifactPath(FIXED_LAYOUT, "../x", "bk"));
  assertThrows(() => copyBackupArtifactPath(FIXED_LAYOUT, COPY, "bk/.."));
  assertThrows(() => copyBackupArtifactPath(FIXED_LAYOUT, COPY, "bk", "p/q"));
  assertEquals(
    copyBackupArtifactPath(FIXED_LAYOUT, COPY, "bk", POLICY),
    join(
      FIXED_LAYOUT.backupDir,
      "copies",
      COPY,
      `policy-${POLICY}`,
      "bk.tar.gz",
    ),
  );
});

test("createCopyBackupArtifact writes a 0600 checksummed archive and prunes its directory", async () => {
  await withLayout(async (layout) => {
    const bytes = new Uint8Array(2048).fill(7);
    const calls: string[][] = [];
    // Sequential on purpose: each run prunes what the previous ones wrote.
    const artifacts = await mapSequential(
      ["bk_1", "bk_2", "bk_3"],
      (backupId) =>
        createCopyBackupArtifact(
          layout,
          {
            source: volumeSource(),
            backupId,
            retentionKeep: 2,
            policyId: POLICY,
          },
          fakeDeps(bytes, calls),
        ),
    );
    const last = artifacts.at(-1);
    assert(last);
    const dir = join(layout.backupDir, "copies", COPY, `policy-${POLICY}`);
    assertEquals(last.path, join(dir, "bk_3.tar.gz"));
    assertEquals(last.sizeBytes, bytes.length);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    assertEquals(
      last.checksum,
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
    assertEquals(last.pruned, ["bk_1"]);
    assertEquals(await listNames(dir), ["bk_2.tar.gz", "bk_3.tar.gz"]);
    assertEquals((await Deno.stat(last.path)).mode! & 0o777, 0o600);
  });
});

test("a missing volume is refused before the helper runs (docker would create it empty)", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          { source: volumeSource(), backupId: "bk_1" },
          fakeDeps(new Uint8Array(), calls, { volumeExists: false }),
        ),
      Error,
      "not found on this host",
    );
    assertEquals(calls.at(-1)?.slice(0, 2), ["volume", "inspect"]);
    assertEquals(calls.some((args) => args[0] === "run"), false);
  });
});

test("a failed archive leaves no artifact and no .part file behind", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          { source: volumeSource(), backupId: "bk_1" },
          fakeDeps(new TextEncoder().encode("partial"), calls, {
            archiveError: "tar: short read",
          }),
        ),
      Error,
      "copy archive failed: tar: short read",
    );
    assertEquals(await listNames(join(layout.backupDir, "copies", COPY)), []);
  });
});

test("ensureCopyBackupImage pulls only a missing image and reports a failed pull", async () => {
  const calls: string[][] = [];
  const answers = [true];
  const present = await ensureCopyBackupImage({
    runDocker: (args) => {
      calls.push(args);
      return Promise.resolve(dockerResult(answers.shift() ?? false));
    },
  });
  assertEquals(present, undefined);
  assertEquals(calls, [["image", "inspect", COPY_BACKUP_HELPER_IMAGE]]);

  calls.length = 0;
  const pulled = await ensureCopyBackupImage({
    runDocker: (args) => {
      calls.push(args);
      return Promise.resolve(dockerResult(args[0] === "pull"));
    },
  });
  assertEquals(pulled, undefined);
  assertEquals(calls.map((args) => args[0]), ["image", "pull"]);

  const failed = await ensureCopyBackupImage({
    runDocker: (args) =>
      Promise.resolve(
        dockerResult(false, args[0] === "pull" ? "registry unreachable" : ""),
      ),
  });
  assertEquals(
    failed,
    `could not pull the backup helper image ${COPY_BACKUP_HELPER_IMAGE}: registry unreachable`,
  );
});

test("ensureCopyBackupImage retries a failed pull once", async () => {
  const calls: string[][] = [];
  let pulls = 0;
  const result = await ensureCopyBackupImage({
    runDocker: (args) => {
      calls.push(args);
      if (args[0] === "pull") pulls += 1;
      return Promise.resolve(dockerResult(args[0] === "pull" && pulls > 1));
    },
  });
  assertEquals(result, undefined);
  assertEquals(calls.map((args) => args[0]), ["image", "pull", "pull"]);
});

test("a backup pulls the missing helper image before the archive runs", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    let present = false;
    const base = fakeDeps(new TextEncoder().encode("data"), calls);
    await createCopyBackupArtifact(
      layout,
      { source: volumeSource(), backupId: "bk_1" },
      {
        ...base,
        runDocker: (args) => {
          if (args[0] === "image") {
            return Promise.resolve(dockerResult(present));
          }
          if (args[0] === "pull") present = true;
          return base.runDocker!(args);
        },
      },
    );
    assertEquals(calls.map((args) => args[0]), ["pull", "volume", "run"]);
  });
});

test("a backup with the image present does not pull", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    await createCopyBackupArtifact(
      layout,
      { source: volumeSource(), backupId: "bk_1" },
      fakeDeps(new TextEncoder().encode("data"), calls),
    );
    assertEquals(calls.some((args) => args[0] === "pull"), false);
  });
});

test("a failed pull errors clearly and leaves no artifact or directory", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    const base = fakeDeps(new Uint8Array(), calls);
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          { source: volumeSource(), backupId: "bk_1" },
          {
            ...base,
            runDocker: (args) => {
              calls.push(args);
              return Promise.resolve(
                dockerResult(false, args[0] === "pull" ? "offline" : ""),
              );
            },
          },
        ),
      Error,
      "could not pull the backup helper image docker.io/library/alpine:3.22@sha256:",
    );
    assertEquals(calls.some((args) => args[0] === "run"), false);
    await assertRejects(() =>
      Deno.stat(join(layout.backupDir, "copies", COPY))
    );
  });
});

test("an explicit path must be inside the named site owner's volumes directory", () => {
  for (
    const [hostPath, ownerUsername] of [
      ["/srv/users/victim/volumes/uploads", "shop"],
      ["/srv/users/shop/volumes", "shop"],
      ["/srv/users/shop/.ssh", "shop"],
      ["/srv/users/shopper/volumes/x", "shop"],
    ] as const
  ) {
    assertThrows(
      () =>
        resolveCopyMount(FIXED_LAYOUT, {
          copyId: COPY,
          copyProvider: "path",
          hostPath,
          ownerUsername,
        }),
      Error,
      "volumes directory",
    );
  }
  // No owner named: refused as well.
  assertThrows(() =>
    resolveCopyMount(FIXED_LAYOUT, {
      copyId: COPY,
      copyProvider: "path",
      hostPath: "/srv/users/shop/volumes/uploads",
    })
  );
});

test("a backup refuses a symlinked directory, a symlinked parent and a foreign volume", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    const links = new Set(["/srv/users/shop/volumes/uploads"]);
    const symlinkLeaf: CopyBackupDeps = {
      ...fakeDeps(new Uint8Array(2048), calls),
      guard: {
        lstat: (p) => Promise.resolve({ isSymlink: links.has(p) }),
        realPath: (p) => Promise.resolve(p),
      },
    };
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          { source: PATH_SOURCE, backupId: "bk_1" },
          symlinkLeaf,
        ),
      Error,
      "symbolic link",
    );
    links.clear();
    links.add("/srv/users/shop/volumes");
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          { source: PATH_SOURCE, backupId: "bk_1" },
          symlinkLeaf,
        ),
      Error,
      "symbolic link",
    );
    // Another owner's directory under a valid-looking source.
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          {
            source: { ...PATH_SOURCE, ownerUsername: "intruder" },
            backupId: "bk_1",
          },
          symlinkLeaf,
        ),
      Error,
      "volumes directory",
    );
    // A volume that is neither this storage's nor the project's.
    const foreign: CopyBackupDeps = {
      ...fakeDeps(new Uint8Array(2048), calls),
      runDocker: () => Promise.resolve(inspectResult()),
    };
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          {
            source: { ...volumeSource(), volumeName: "someone_elses_data" },
            backupId: "bk_1",
          },
          foreign,
        ),
      Error,
      "does not belong",
    );
    assertEquals(calls.some((args) => args[0] === "run"), false);
  });
});

test("a volume backed by a host path, or by another driver, is refused", async () => {
  await withLayout(async (layout) => {
    for (
      const answer of [
        inspectResult({}, {
          Options: { type: "none", o: "bind", device: "/etc" },
        }),
        inspectResult({}, { Driver: "nfs-plugin" }),
      ]
    ) {
      await assertRejects(
        () =>
          createCopyBackupArtifact(
            layout,
            { source: volumeSource(), backupId: "bk_1" },
            {
              ...fakeDeps(new Uint8Array(2048), []),
              runDocker: () => Promise.resolve(answer),
            },
          ),
        Error,
      );
    }
  });
});

test("an externally named volume is accepted only with the project's compose label", async () => {
  await withLayout(async (layout) => {
    const source: CopyBackupSource = {
      ...volumeSource(),
      volumeName: "legacy_data",
      composeProject: "tp-proj",
    };
    const withLabels = (labels: Record<string, string>): CopyBackupDeps => ({
      ...fakeDeps(new Uint8Array(2048), []),
      runDocker: (args) =>
        Promise.resolve(
          args[0] === "volume" ? inspectResult(labels) : dockerResult(true),
        ),
    });
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          { source, backupId: "bk_1" },
          withLabels({}),
        ),
      Error,
      "does not belong",
    );
    await assertRejects(
      () =>
        createCopyBackupArtifact(
          layout,
          { source, backupId: "bk_1" },
          withLabels({ "com.docker.compose.project": "other" }),
        ),
      Error,
      "does not belong",
    );
    const done = await createCopyBackupArtifact(
      layout,
      { source, backupId: "bk_1" },
      withLabels({ "com.docker.compose.project": "tp-proj" }),
    );
    assertEquals(done.sizeBytes, 2048);
  });
});

test("an empty archive is kept but never counts as a good copy or prunes the good ones", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    const run = (backupId: string, size: number) =>
      createCopyBackupArtifact(
        layout,
        { source: volumeSource(), backupId, retentionKeep: 1 },
        fakeDeps(new Uint8Array(size).fill(1), calls),
      );
    await run("bk_1", 4096);
    const empty = await run("bk_2", 45);
    assertEquals(empty.pruned, []);
    const dir = join(layout.backupDir, "copies", COPY);
    assertEquals(await listNames(dir), ["bk_1.tar.gz", "bk_2.tar.gz"]);
    // A second empty run still leaves the good one alone.
    assertEquals((await run("bk_3", 45)).pruned, []);
    // A good run now prunes only down to the newest good one.
    const good = await run("bk_4", 4096);
    assert(good.pruned.includes("bk_1"));
    assert(!good.pruned.includes("bk_4"));
  });
});
