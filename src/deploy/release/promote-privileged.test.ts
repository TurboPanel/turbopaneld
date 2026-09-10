/**
 * Privileged (EACCES → sudo -n) fallbacks for promote. Host-free: Deno APIs
 * throw PermissionDenied and the injected RunFn records the sudo argv.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  RELEASE_METADATA_DIRNAME,
  resolveReleasePaths,
} from "./release-layout.ts";
import {
  expectedPathsProbe,
  linkReleaseSharedDir,
  promoteExistingRelease,
  promoteRelease,
  readCurrentReleaseId,
  RELEASE_SHARED_LINK_TARGET,
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

test("stageRelease copies via sudo when the unprivileged copy is denied", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "built");

    const argv: string[][] = [];
    const originalMkdir = Deno.mkdir;
    Deno.mkdir = ((...args: Parameters<typeof Deno.mkdir>) => {
      if (String(args[0]) === paths.releaseDir) {
        return Promise.reject(denied("mkdir"));
      }
      return originalMkdir.apply(Deno, args);
    }) as typeof Deno.mkdir;
    try {
      await stageRelease({
        paths,
        workingDir,
        runFn: (_command, args) => {
          argv.push([...args]);
          return Promise.resolve({ success: true, stdout: "", stderr: "" });
        },
      });
    } finally {
      Deno.mkdir = originalMkdir;
    }

    assertEquals(argv.some((args) => args.includes("mkdir")), true);
    assertEquals(argv.some((args) => args.includes("cp")), true);
  });
});

test("stageRelease privileged copy throws when sudo mkdir fails", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    const originalMkdir = Deno.mkdir;
    Deno.mkdir = () => Promise.reject(denied("mkdir"));
    try {
      await assertRejects(
        () =>
          stageRelease({
            paths,
            workingDir,
            runFn: () =>
              Promise.resolve({
                success: false,
                stdout: "",
                stderr: "mkdir denied",
              }),
          }),
        Error,
        "mkdir denied",
      );
    } finally {
      Deno.mkdir = originalMkdir;
    }
  });
});

test("stageRelease privileged copy throws when sudo cp fails", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    const originalMkdir = Deno.mkdir;
    Deno.mkdir = () => Promise.reject(denied("mkdir"));
    try {
      await assertRejects(
        () =>
          stageRelease({
            paths,
            workingDir,
            runFn: (_command, args) => {
              if (args.includes("cp")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "cp denied",
                });
              }
              return Promise.resolve({ success: true, stdout: "", stderr: "" });
            },
          }),
        Error,
        "cp denied",
      );
    } finally {
      Deno.mkdir = originalMkdir;
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
        () => stageRelease({ paths, workingDir }),
        TypeError,
        "io",
      );
    } finally {
      Deno.mkdir = originalMkdir;
    }
  });
});

test("stageRelease rethrows a non-NotFound source stat error", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const originalStat = Deno.stat;
    Deno.stat = () => Promise.reject(new TypeError("stat io"));
    try {
      await assertRejects(
        () =>
          stageRelease({
            paths,
            workingDir: join(root, "checkout"),
          }),
        TypeError,
        "stat io",
      );
    } finally {
      Deno.stat = originalStat;
    }
  });
});

test("linkReleaseSharedDir falls back to sudo when symlink is denied", async () => {
  await withTempRelease(async (root) => {
    const releaseDir = join(root, "releases", "rel-1");
    await Deno.mkdir(releaseDir, { recursive: true });
    const argv: string[][] = [];
    const originalSymlink = Deno.symlink;
    Deno.symlink = () => Promise.reject(denied("symlink"));
    try {
      await linkReleaseSharedDir(releaseDir, (_command, args) => {
        argv.push([...args]);
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
    } finally {
      Deno.symlink = originalSymlink;
    }
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
    await Deno.mkdir(releaseDir, { recursive: true });
    const originalSymlink = Deno.symlink;
    Deno.symlink = () => Promise.reject(denied("symlink"));
    try {
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
    } finally {
      Deno.symlink = originalSymlink;
    }
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
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const originalSymlink = Deno.symlink;
    Deno.symlink = () => Promise.reject(denied("symlink"));
    try {
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
    } finally {
      Deno.symlink = originalSymlink;
    }
  });
});

test("swapCurrentSymlink privileged path throws when mv fails", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const originalSymlink = Deno.symlink;
    Deno.symlink = () => Promise.reject(denied("symlink"));
    try {
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
    } finally {
      Deno.symlink = originalSymlink;
    }
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

test("promoteRelease writes the manifest via sudo when the unprivileged write is denied", async () => {
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

    const argv: string[][] = [];
    const originalWrite = Deno.writeTextFile;
    Deno.writeTextFile = ((path, data, options) => {
      if (String(path).includes(RELEASE_METADATA_DIRNAME)) {
        return Promise.reject(denied("manifest"));
      }
      return originalWrite.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;
    try {
      await promoteRelease({
        paths,
        workingDir,
        username: "appuser",
        manifest: MANIFEST,
        healthProbe: () => Promise.resolve(),
        runFn: (_command, args) => {
          argv.push([...args]);
          return Promise.resolve({ success: true, stdout: "", stderr: "" });
        },
      });
    } finally {
      Deno.writeTextFile = originalWrite;
    }
    assertEquals(argv.some((args) => args.includes("install")), true);
  });
});

test("promoteRelease privileged manifest write throws when install fails", async () => {
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
        return Promise.reject(denied("manifest"));
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
            runFn: (_command, args) => {
              if (args.includes("install")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "install denied",
                });
              }
              return Promise.resolve({ success: true, stdout: "", stderr: "" });
            },
          }),
        Error,
        "install denied",
      );
    } finally {
      Deno.writeTextFile = originalWrite;
    }
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

test("stageRelease privileged copy uses default errors when sudo is silent", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    const originalMkdir = Deno.mkdir;
    Deno.mkdir = () => Promise.reject(denied("mkdir"));
    try {
      await assertRejects(
        () =>
          stageRelease({
            paths,
            workingDir,
            runFn: () =>
              Promise.resolve({ success: false, stdout: "", stderr: "" }),
          }),
        Error,
        "Failed to mkdir",
      );
    } finally {
      Deno.mkdir = originalMkdir;
    }
  });
});

test("stageRelease privileged copy uses a default error when cp is silent", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    const originalMkdir = Deno.mkdir;
    Deno.mkdir = () => Promise.reject(denied("mkdir"));
    try {
      await assertRejects(
        () =>
          stageRelease({
            paths,
            workingDir,
            runFn: (_command, args) => {
              if (args.includes("cp")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "",
                });
              }
              return Promise.resolve({ success: true, stdout: "", stderr: "" });
            },
          }),
        Error,
        "Failed to copy",
      );
    } finally {
      Deno.mkdir = originalMkdir;
    }
  });
});

test("promoteRelease privileged manifest write throws when mkdir fails", async () => {
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
        return Promise.reject(denied("manifest"));
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
            runFn: (_command, args) => {
              if (args.includes("mkdir")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "",
                });
              }
              return Promise.resolve({ success: true, stdout: "", stderr: "" });
            },
          }),
        Error,
        "Failed to mkdir",
      );
    } finally {
      Deno.writeTextFile = originalWrite;
    }
  });
});

test("promoteRelease privileged manifest still succeeds when temp cleanup fails", async () => {
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
    const originalRemove = Deno.remove;
    Deno.writeTextFile = ((path, data, options) => {
      if (String(path).includes(RELEASE_METADATA_DIRNAME)) {
        return Promise.reject(denied("manifest"));
      }
      return originalWrite.call(Deno, path, data, options);
    }) as typeof Deno.writeTextFile;
    Deno.remove = ((path, options) => {
      if (String(path).includes("tp-rel-manifest-")) {
        return Promise.reject(denied("tmp"));
      }
      return originalRemove.call(Deno, path, options);
    }) as typeof Deno.remove;
    try {
      await promoteRelease({
        paths,
        workingDir,
        username: "appuser",
        manifest: MANIFEST,
        healthProbe: () => Promise.resolve(),
        runFn: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
      });
    } finally {
      Deno.writeTextFile = originalWrite;
      Deno.remove = originalRemove;
    }
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

test("swapCurrentSymlink privileged path succeeds after an unprivileged deny", async () => {
  await withTempRelease(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const argv: string[][] = [];
    const originalSymlink = Deno.symlink;
    Deno.symlink = () => Promise.reject(denied("symlink"));
    try {
      await swapCurrentSymlink(paths, (_command, args) => {
        argv.push([...args]);
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      });
    } finally {
      Deno.symlink = originalSymlink;
    }
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
