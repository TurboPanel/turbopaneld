/**
 * Privileged (EACCES → sudo -n) fallbacks for promote. Host-free: Deno APIs
 * throw PermissionDenied and the injected RunFn records the sudo argv.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  RELEASE_METADATA_DIRNAME,
  type ReleasePaths,
  resolveReleasePaths,
} from "./release-layout.ts";
import {
  expectedPathsProbe,
  linkReleaseSharedDir,
  promoteExistingRelease,
  promoteRelease,
  readCurrentReleaseId,
  RELEASE_SHARED_LINK_TARGET,
  type StagedRelease,
  stageRelease,
  swapCurrentSymlink,
} from "./promote.ts";
import type { ReleaseManifestV1 } from "./deployment-json.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANIFEST: ReleaseManifestV1 = {
  version: 1,
  serviceId: "svc-1",
  composeServiceName: "web",
  releaseId: "rel-1",
  sourceId: "src-1",
  commitSha: "abc",
  ref: "main",
  promotedAt: "2026-01-15T12:00:00.000Z",
};

function denied(message = "denied"): Deno.errors.PermissionDenied {
  return new Deno.errors.PermissionDenied(message);
}

async function withTempRelease(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-promote-priv-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

type SudoResult = { success: boolean; stdout: string; stderr: string };

/**
 * Stage into a release directory this process may not create (the managed-host
 * case), recording every sudo argv and answering with `respond`. A successful
 * `publish-open` makes the staging leaf, as tp-host would.
 */
async function stageWithDeniedReleaseDir(
  root: string,
  respond: (args: string[]) => SudoResult,
): Promise<{ argv: string[][]; paths: ReleasePaths; staged: StagedRelease }> {
  const paths = resolveReleasePaths(
    { principalHomeRoot: root, daemonStateDir: join(root, "state") },
    { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
  );
  const workingDir = join(root, "checkout");
  await Deno.mkdir(workingDir, { recursive: true });
  await Deno.writeTextFile(join(workingDir, "index.html"), "built");
  await Deno.symlink("/etc", join(workingDir, "etc"));
  const argv: string[][] = [];
  const originalMkdir = Deno.mkdir;
  Deno.mkdir = ((...args: Parameters<typeof Deno.mkdir>) => {
    if (String(args[0]) === paths.releaseDir) {
      return Promise.reject(denied("mkdir"));
    }
    return originalMkdir.apply(Deno, args);
  }) as typeof Deno.mkdir;
  try {
    const staged = await stageRelease({
      paths,
      username: "appuser",
      workingDir,
      runFn: async (_command, args) => {
        argv.push([...args]);
        const result = respond([...args]);
        if (result.success && args.includes("publish-open")) {
          await originalMkdir(paths.stagingDir, { recursive: true });
        }
        return result;
      },
    });
    return { argv, paths, staged };
  } finally {
    Deno.mkdir = originalMkdir;
  }
}

const SUDO_OK: SudoResult = { success: true, stdout: "", stderr: "" };

test("stageRelease copies into the daemon's own staging leaf, never into releases/", async () => {
  await withTempRelease(async (root) => {
    const { argv, paths, staged } = await stageWithDeniedReleaseDir(
      root,
      () => SUDO_OK,
    );
    assertEquals(argv, [["-n", "publish-open", "appuser", "svc-1", "rel-1"]]);
    assertEquals(staged, { dir: paths.stagingDir, viaPublish: true });
    assertEquals(
      paths.stagingDir,
      join(root, ".tp-staging", "appuser.svc-1.rel-1"),
    );
    // The escaping link never reached the staged tree.
    const names = [...Deno.readDirSync(paths.stagingDir)].map((e) => e.name);
    assertEquals(names, ["index.html"]);
    await assertRejects(
      () => Deno.lstat(paths.releaseDir),
      Deno.errors.NotFound,
    );
  });
});

test("stageRelease reports a refused publish-open", async () => {
  for (const [stderr, message] of [["no", "no"], ["", "publish-open failed"]]) {
    await withTempRelease(async (root) => {
      await assertRejects(
        () =>
          stageWithDeniedReleaseDir(
            root,
            () => ({ success: false, stdout: "", stderr }),
          ),
        Error,
        message,
      );
    });
  }
});

test("stageRelease rethrows a non-NotFound source lstat error", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalLstat = Deno.lstat;
    Deno.lstat = () => Promise.reject(new TypeError("lstat io"));
    try {
      await assertRejects(
        () =>
          stageRelease({
            paths,
            username: "appuser",
            workingDir: join(root, "checkout"),
          }),
        TypeError,
        "lstat io",
      );
    } finally {
      Deno.lstat = originalLstat;
    }
  });
});

test("stageRelease rethrows a non-PermissionDenied copy error", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    const originalMkdir = Deno.mkdir;
    Deno.mkdir = () => Promise.reject(new TypeError("io"));
    try {
      await assertRejects(
        () => stageRelease({ paths, username: "appuser", workingDir }),
        TypeError,
        "io",
      );
    } finally {
      Deno.mkdir = originalMkdir;
    }
  });
});

test("linkReleaseSharedDir falls back to sudo when the unprivileged link fails", async () => {
  await withTempRelease(async (root) => {
    const releaseDir = join(root, "releases", "rel-1");
    const argv: string[][] = [];
    await linkReleaseSharedDir(releaseDir, (_command, args) => {
      argv.push([...args]);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    });
    assertEquals(argv.some((args) => args.includes("ln")), true);
    assertEquals(
      argv.some((args) => args.includes(RELEASE_SHARED_LINK_TARGET)),
      true,
    );
  });
});

test("linkReleaseSharedDir throws when privileged ln fails", async () => {
  await withTempRelease(async (root) => {
    const releaseDir = join(root, "releases", "rel-1");
    await assertRejects(
      () =>
        linkReleaseSharedDir(releaseDir, () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "ln denied",
          })),
      Error,
      "ln denied",
    );
  });
});

test("linkReleaseSharedDir rethrows a non-NotFound remove error", async () => {
  await withTempRelease(async (root) => {
    const releaseDir = join(root, "releases", "rel-1");
    await Deno.mkdir(releaseDir, { recursive: true });
    const originalRemove = Deno.remove;
    Deno.remove = () => Promise.reject(new TypeError("busy"));
    try {
      await assertRejects(
        () => linkReleaseSharedDir(releaseDir),
        TypeError,
        "busy",
      );
    } finally {
      Deno.remove = originalRemove;
    }
  });
});

test("swapCurrentSymlink falls back to sudo and fails when ln is denied", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await assertRejects(
      () =>
        swapCurrentSymlink(paths, () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "ln failed",
          })),
      Error,
      "ln failed",
    );
  });
});

test("swapCurrentSymlink privileged path throws when mv fails", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await assertRejects(
      () =>
        swapCurrentSymlink(paths, (_command, args) => {
          if (args.includes("mv")) {
            return Promise.resolve({
              success: false,
              stdout: "",
              stderr: "mv failed",
            });
          }
          return Promise.resolve({ success: true, stdout: "", stderr: "" });
        }),
      Error,
      "mv failed",
    );
  });
});

test("swapCurrentSymlink rethrows a non-NotFound tmp-link remove error", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const originalRemove = Deno.remove;
    Deno.remove = () => Promise.reject(new TypeError("tmp busy"));
    try {
      await assertRejects(
        () => swapCurrentSymlink(paths),
        TypeError,
        "tmp busy",
      );
    } finally {
      Deno.remove = originalRemove;
    }
  });
});

test("readCurrentReleaseId falls back to sudo and returns the basename", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      const id = await readCurrentReleaseId(paths, (_command, args) => {
        if (args.includes("test") && args.includes("-e")) {
          return Promise.resolve({ success: true, stdout: "", stderr: "" });
        }
        if (args.includes("test") && args.includes("-L")) {
          return Promise.resolve({ success: true, stdout: "", stderr: "" });
        }
        if (args.includes("readlink")) {
          return Promise.resolve({
            success: true,
            stdout: "releases/rel-1\n",
            stderr: "",
          });
        }
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
      assertEquals(id, "rel-1");
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path returns null when the link is missing", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      const id = await readCurrentReleaseId(paths, (_command, args) => {
        if (args.includes("-e")) {
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "No such file or directory",
          });
        }
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
      assertEquals(id, null);
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path throws on a sudo invocation error", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      await assertRejects(
        () =>
          readCurrentReleaseId(paths, () =>
            Promise.resolve({
              success: false,
              stdout: "",
              stderr: "sudo: a terminal is required",
            })),
        Error,
        "terminal is required",
      );
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path returns null when current is not a symlink", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      const id = await readCurrentReleaseId(paths, (_command, args) => {
        if (args.includes("-L")) {
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "",
          });
        }
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
      assertEquals(id, null);
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path returns null on a missing readlink", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      const id = await readCurrentReleaseId(paths, (_command, args) => {
        if (args.includes("readlink")) {
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "not found",
          });
        }
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
      assertEquals(id, null);
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path throws on an unexpected readlink error", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      await assertRejects(
        () =>
          readCurrentReleaseId(paths, (_command, args) => {
            if (args.includes("readlink")) {
              return Promise.resolve({
                success: false,
                stdout: "something",
                stderr: "I/O error",
              });
            }
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          }),
        Error,
        "I/O error",
      );
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId returns null for an empty link basename", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.siteDir, { recursive: true });
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.resolve("");
    try {
      assertEquals(await readCurrentReleaseId(paths), null);
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId rethrows a non-PermissionDenied readlink error", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(new TypeError("bad fd"));
    try {
      await assertRejects(
        () => readCurrentReleaseId(paths),
        TypeError,
        "bad fd",
      );
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("expectedPathsProbe uses sudo test when Deno.stat is denied", async () => {
  await withTempRelease(async (root) => {
    const originalStat = Deno.stat;
    Deno.stat = () => Promise.reject(denied("stat"));
    try {
      await expectedPathsProbe(
        ["public"],
        () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
      )(root);
      await assertRejects(
        () =>
          expectedPathsProbe(["missing"], () =>
            Promise.resolve({
              success: false,
              stdout: "",
              stderr: "",
            }))(root),
        Error,
        "missing missing",
      );
    } finally {
      Deno.stat = originalStat;
    }
  });
});

test("expectedPathsProbe reports the first missing path, in order", async () => {
  await withTempRelease(async (root) => {
    await Deno.mkdir(join(root, "present"));
    await assertRejects(
      () => expectedPathsProbe(["present", "gone-a", "gone-b"])(root),
      Error,
      "missing gone-a",
    );
  });
});

test("expectedPathsProbe rethrows a non-NotFound stat error", async () => {
  await withTempRelease(async (root) => {
    const originalStat = Deno.stat;
    Deno.stat = () => Promise.reject(new TypeError("probe io"));
    try {
      await assertRejects(
        () => expectedPathsProbe(["public"])(root),
        TypeError,
        "probe io",
      );
    } finally {
      Deno.stat = originalStat;
    }
  });
});

test("promoteExistingRelease rejects a non-directory target", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    await Deno.writeTextFile(paths.releaseDir, "not-a-dir");
    await assertRejects(
      () => promoteExistingRelease({ paths, releaseId: "rel-1" }),
      Error,
      "not a directory",
    );
  });
});

/** A managed-host promote: releases/ is root's, publish verbs answer `respond`. */
async function promoteManaged(
  root: string,
  respond: (args: string[]) => SudoResult,
  build: (workingDir: string) => Promise<void> = () => Promise.resolve(),
): Promise<{ argv: string[][]; paths: ReleasePaths; seen: string[] }> {
  const paths = resolveReleasePaths(
    { principalHomeRoot: root, daemonStateDir: join(root, "state") },
    { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
  );
  await Deno.mkdir(paths.releasesDir, { recursive: true });
  const workingDir = join(root, "checkout");
  await Deno.mkdir(workingDir, { recursive: true });
  await Deno.writeTextFile(join(workingDir, "index.html"), "v1");
  await build(workingDir);
  const argv: string[][] = [];
  let seen: string[] = [];
  await Deno.chmod(paths.releasesDir, 0o500);
  try {
    await promoteRelease({
      paths,
      workingDir,
      username: "appuser",
      manifest: MANIFEST,
      runFn: async (_command, args) => {
        argv.push([...args]);
        const result = respond([...args]);
        if (!result.success) return result;
        if (args.includes("publish-open")) {
          await Deno.mkdir(paths.stagingDir, { recursive: true });
        }
        if (args.includes("publish")) {
          seen = [...Deno.readDirSync(paths.stagingDir)].map((e) => e.name)
            .sort();
        }
        return result;
      },
    });
  } finally {
    await Deno.chmod(paths.releasesDir, 0o700);
  }
  return { argv, paths, seen };
}

test("promoteRelease publishes a managed-host release through tp-host only", async () => {
  await withTempRelease(async (root) => {
    const { argv, seen } = await promoteManaged(
      root,
      () => SUDO_OK,
      async (workingDir) => {
        // A build's own `shared` is dropped: the layout links it after the checks.
        await Deno.mkdir(join(workingDir, "shared"));
      },
    );
    assertEquals(argv, [
      ["-n", "publish-open", "appuser", "svc-1", "rel-1"],
      ["-n", "publish", "appuser", "svc-1", "rel-1"],
    ]);
    // The manifest and the payload were staged before publish ran.
    assertEquals(seen, [RELEASE_METADATA_DIRNAME, "index.html"]);
  });
});

test("promoteRelease removes its staging leaf when publish is refused", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await assertRejects(
      () =>
        promoteManaged(
          root,
          (args) =>
            args.includes("publish")
              ? { success: false, stdout: "", stderr: "refusing x" }
              : SUDO_OK,
        ),
      Error,
      "refusing x",
    );
    await assertRejects(
      () => Deno.lstat(paths.stagingDir),
      Deno.errors.NotFound,
    );
  });
});

test("promoteRelease privileged cleanup runs when unprivileged remove fails", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-fail" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "v1");

    const argv: string[][] = [];
    const originalRemove = Deno.remove;
    Deno.remove = ((path, options) => {
      if (String(path) === paths.releaseDir) {
        return Promise.reject(new TypeError("sealed"));
      }
      return originalRemove.call(Deno, path, options);
    }) as typeof Deno.remove;
    try {
      await assertRejects(
        () =>
          promoteRelease({
            paths,
            workingDir,
            username: "appuser",
            healthProbe: () => Promise.reject(new Error("probe failed")),
            runFn: (_command, args) => {
              argv.push([...args]);
              return Promise.resolve({ success: true, stdout: "", stderr: "" });
            },
          }),
        Error,
        "probe failed",
      );
    } finally {
      Deno.remove = originalRemove;
    }
    assertEquals(
      argv.some((args) =>
        args.includes("rm") && args.some((part) => part.includes("rel-fail"))
      ),
      true,
    );
  });
});

test("promoteRelease rethrows a non-PermissionDenied manifest write", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "v1");

    const originalWrite = Deno.writeTextFile;
    Deno.writeTextFile = ((path, data, options) => {
      if (String(path).includes(RELEASE_METADATA_DIRNAME)) {
        return Promise.reject(new TypeError("disk full"));
      }
      return originalWrite.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;
    try {
      await assertRejects(
        () =>
          promoteRelease({
            paths,
            workingDir,
            username: "appuser",
            manifest: MANIFEST,
            healthProbe: () => Promise.resolve(),
            runFn: () =>
              Promise.resolve({ success: true, stdout: "", stderr: "" }),
          }),
        TypeError,
        "disk full",
      );
    } finally {
      Deno.writeTextFile = originalWrite;
    }
  });
});

test("promoteRelease swallows a failed privileged cleanup", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-fail" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "v1");

    const originalRemove = Deno.remove;
    Deno.remove = ((path, options) => {
      if (String(path) === paths.releaseDir) {
        return Promise.reject(new TypeError("sealed"));
      }
      return originalRemove.call(Deno, path, options);
    }) as typeof Deno.remove;
    try {
      await assertRejects(
        () =>
          promoteRelease({
            paths,
            workingDir,
            username: "appuser",
            healthProbe: () => Promise.reject(new Error("probe failed")),
            runFn: () => Promise.reject(new TypeError("sudo rm failed")),
          }),
        Error,
        "probe failed",
      );
    } finally {
      Deno.remove = originalRemove;
    }
  });
});

test("swapCurrentSymlink privileged path succeeds after an unprivileged failure", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const argv: string[][] = [];
    await swapCurrentSymlink(paths, (_command, args) => {
      argv.push([...args]);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    });
    assertEquals(argv.some((args) => args.includes("ln")), true);
    assertEquals(argv.some((args) => args.includes("mv")), true);
  });
});

test("swapCurrentSymlink swallows a failed tmp-link cleanup after rename is denied", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const originalRename = Deno.rename;
    const originalRemove = Deno.remove;
    Deno.rename = () => Promise.reject(denied("rename"));
    let tmpRemoves = 0;
    Deno.remove = ((path: string | URL, options?: Deno.RemoveOptions) => {
      if (String(path).includes(".tmp.")) {
        tmpRemoves += 1;
        if (tmpRemoves > 1) return Promise.reject(new TypeError("tmp busy"));
      }
      return originalRemove.call(Deno, path, options);
    }) as typeof Deno.remove;
    const argv: string[][] = [];
    try {
      await swapCurrentSymlink(paths, (_command, args) => {
        argv.push([...args]);
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
    } finally {
      Deno.rename = originalRename;
      Deno.remove = originalRemove;
    }
    assertEquals(argv.some((args) => args.includes("ln")), true);
  });
});

test("swapCurrentSymlink falls back to sudo when rename is denied", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const originalRename = Deno.rename;
    Deno.rename = () => Promise.reject(denied("rename"));
    const argv: string[][] = [];
    try {
      await swapCurrentSymlink(paths, (_command, args) => {
        argv.push([...args]);
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
    } finally {
      Deno.rename = originalRename;
    }
    assertEquals(argv.some((args) => args.includes("ln")), true);
  });
});

test("expectedPathsProbe rethrows PermissionDenied when no runner is provided", async () => {
  await withTempRelease(async (root) => {
    const originalStat = Deno.stat;
    Deno.stat = () => Promise.reject(denied("stat"));
    try {
      await assertRejects(
        () => expectedPathsProbe(["public"])(root),
        Deno.errors.PermissionDenied,
      );
    } finally {
      Deno.stat = originalStat;
    }
  });
});

test("promoteExistingRelease treats a missing mode as sealed", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const originalStat = Deno.stat;
    Deno.stat = (async (path: string | URL) => {
      const stat = await originalStat.call(Deno, path);
      return { ...stat, mode: null };
    }) as typeof Deno.stat;
    try {
      await promoteExistingRelease({
        paths,
        releaseId: "rel-1",
        healthProbe: () => Promise.resolve(),
      });
      assertEquals(
        await Deno.readLink(paths.currentLink),
        join("releases", "rel-1"),
      );
    } finally {
      Deno.stat = originalStat;
    }
  });
});

test("readCurrentReleaseId privileged path returns null for an empty basename", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      const id = await readCurrentReleaseId(paths, (_command, args) => {
        if (args.includes("readlink")) {
          return Promise.resolve({ success: true, stdout: "\n", stderr: "" });
        }
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
      assertEquals(id, null);
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path returns null when stderr is empty", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      const id = await readCurrentReleaseId(paths, (_command, args) => {
        if (args.includes("readlink")) {
          return Promise.resolve({
            success: false,
            stdout: "something",
            stderr: "",
          });
        }
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
      assertEquals(id, null);
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path treats a missing path on stdout as absent", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      const id = await readCurrentReleaseId(paths, (_command, args) => {
        if (args.includes("readlink")) {
          return Promise.resolve({
            success: false,
            stdout: "No such file or directory",
            stderr: "I/O error",
          });
        }
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
      assertEquals(id, null);
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

test("readCurrentReleaseId privileged path throws when sudo is not allowed", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalReadLink = Deno.readLink;
    Deno.readLink = () => Promise.reject(denied("readlink"));
    try {
      await assertRejects(
        () =>
          readCurrentReleaseId(paths, () =>
            Promise.resolve({
              success: false,
              stdout: "",
              stderr: "user is not allowed to execute",
            })),
        Error,
        "not allowed",
      );
    } finally {
      Deno.readLink = originalReadLink;
    }
  });
});

/** Run `fn` with `Deno.stat` denied for exactly `path`. */
async function withStatDenied(
  path: string,
  fn: () => Promise<void>,
): Promise<void> {
  const originalStat = Deno.stat;
  Deno.stat = (target, ...rest) =>
    String(target) === path
      ? Promise.reject(denied("stat"))
      : originalStat(target, ...rest);
  try {
    await fn();
  } finally {
    Deno.stat = originalStat;
  }
}

function testRun(exists: boolean, calls: string[][]) {
  return (_command: string, args: string[]) => {
    calls.push(args);
    const probe = args.includes("test");
    return Promise.resolve({
      success: probe ? exists : true,
      stdout: "",
      stderr: "",
    });
  };
}

test("promoteExistingRelease checks a denied release only for presence", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    const calls: string[][] = [];
    await withStatDenied(paths.releaseDir, async () => {
      const dir = await promoteExistingRelease({
        paths,
        releaseId: "rel-1",
        runFn: testRun(true, calls),
      });
      assertEquals(dir, paths.releaseDir);
    });
    // tp-host's existing `test -e` is the only privileged look at the tree:
    // nothing in it is read, opened, or stat'd for metadata.
    assertEquals(calls[0], ["-n", "test", "-e", paths.releaseDir]);
    assertEquals(
      calls.some((args) =>
        args.includes("cat") || args.includes("stat") ||
        args.includes("find") || args.includes("ls")
      ),
      false,
    );
    assertEquals(await Deno.readLink(paths.currentLink), "releases/rel-1");
  });
});

test("promoteExistingRelease refuses a denied release that is absent", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const calls: string[][] = [];
    await withStatDenied(paths.releaseDir, async () => {
      await assertRejects(
        () =>
          promoteExistingRelease({
            paths,
            releaseId: "rel-1",
            runFn: testRun(false, calls),
          }),
        Error,
        "is not present on this host",
      );
    });
    assertEquals(calls, [["-n", "test", "-e", paths.releaseDir]]);
  });
});

test("promoteExistingRelease surfaces a stat failure other than denial", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const calls: string[][] = [];
    const originalStat = Deno.stat;
    Deno.stat = (target, ...rest) =>
      String(target) === paths.releaseDir
        ? Promise.reject(new Deno.errors.Interrupted("io"))
        : originalStat(target, ...rest);
    try {
      await assertRejects(
        () =>
          promoteExistingRelease({
            paths,
            releaseId: "rel-1",
            runFn: testRun(true, calls),
          }),
        Deno.errors.Interrupted,
      );
    } finally {
      Deno.stat = originalStat;
    }
    assertEquals(calls, []);
  });
});
