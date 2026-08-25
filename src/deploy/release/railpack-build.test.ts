import { dirname, join } from "@std/path";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import { withTempLayout } from "../../testing/temp-layout.ts";
import {
  BUILDKIT_VERSION,
  ensureBuildkitRailpack,
  type EnsureBuildkitRailpackDeps,
  RAILPACK_FRONTEND_IMAGE,
  RAILPACK_FRONTEND_VERSION,
  RAILPACK_VERSION,
  railpackCacheDir,
  railpackFrontendDigestPath,
  railpackFrontendLayoutDir,
  railpackImageTag,
} from "./railpack-build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const VALID_DIGEST = `sha256:${"ab".repeat(32)}`;

async function writeFile(
  path: string,
  contents = "",
  mode = 0o750,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, contents, { mode });
}

async function linkCurrent(toolDir: string, versionDir: string): Promise<void> {
  const currentLink = join(toolDir, "current");
  try {
    await Deno.remove(currentLink);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.symlink(versionDir, currentLink);
}

async function plantVendorTools(
  runtimesDir: string,
  opts: {
    digest?: string;
    skipRailpack?: boolean;
    skipBuildctl?: boolean;
    skipBuildkitd?: boolean;
    skipIndex?: boolean;
    skipDigest?: boolean;
    railpackIsDir?: boolean;
    digestContents?: string;
  } = {},
): Promise<void> {
  if (!opts.skipRailpack) {
    const versionDir = join(runtimesDir, "railpack", RAILPACK_VERSION);
    if (opts.railpackIsDir) {
      await Deno.mkdir(join(versionDir, "railpack"), { recursive: true });
    } else {
      await writeFile(join(versionDir, "railpack"));
    }
    await linkCurrent(join(runtimesDir, "railpack"), versionDir);
  }
  const buildkitVersionDir = join(runtimesDir, "buildkit", BUILDKIT_VERSION);
  if (!opts.skipBuildctl) {
    await writeFile(join(buildkitVersionDir, "buildctl"));
  }
  if (!opts.skipBuildkitd) {
    await writeFile(join(buildkitVersionDir, "buildkitd"));
  }
  if (!opts.skipBuildctl || !opts.skipBuildkitd) {
    await linkCurrent(join(runtimesDir, "buildkit"), buildkitVersionDir);
  }

  const frontendVersionDir = join(
    runtimesDir,
    "railpack-frontend",
    RAILPACK_FRONTEND_VERSION,
  );
  const imageDir = join(frontendVersionDir, "image");
  if (!opts.skipIndex) {
    await writeFile(
      join(imageDir, "index.json"),
      JSON.stringify({ manifests: [{ digest: VALID_DIGEST }] }),
      0o640,
    );
  } else {
    await Deno.mkdir(imageDir, { recursive: true });
  }
  if (!opts.skipDigest) {
    await writeFile(
      join(frontendVersionDir, "digest"),
      opts.digestContents ?? `${opts.digest ?? VALID_DIGEST}\n`,
      0o640,
    );
  }
  await linkCurrent(join(runtimesDir, "railpack-frontend"), frontendVersionDir);
}

function layoutOf(env: Record<string, string>) {
  return resolveLayout(env, { skipDiscovery: true, forceMode: "production" });
}

function mockDownloadCommands(opts: {
  fail?:
    | "buildkit-curl"
    | "buildkit-tar"
    | "railpack-curl"
    | "railpack-tar"
    | "docker-pull"
    | "docker-save"
    | "frontend-tar";
  emptyStderr?: boolean;
  frontendIndex?: string;
  wipeRailpackAfterFrontend?: boolean;
  runtimesDir?: string;
  record?: string[];
} = {}): NonNullable<EnsureBuildkitRailpackDeps["runCommand"]> {
  const stderrFor = (fallback: string) =>
    opts.emptyStderr === true ? "" : fallback;
  return async (command, args) => {
    opts.record?.push([command, ...args].join(" "));
    if (command === "/usr/bin/curl") {
      const url = args.at(-1);
      if (typeof url !== "string") {
        throw new TypeError("curl mock expected a URL argument");
      }
      const isBuildkit = url.includes("buildkit");
      const fail = isBuildkit
        ? opts.fail === "buildkit-curl"
        : opts.fail === "railpack-curl";
      if (fail) {
        return {
          success: false,
          stderr: stderrFor("connection refused"),
        };
      }
      const outIdx = args.indexOf("-o");
      const tarball = outIdx >= 0 ? args[outIdx + 1] : undefined;
      if (typeof tarball !== "string") {
        throw new TypeError("curl mock expected -o <path>");
      }
      await Deno.writeTextFile(tarball, "fake-tarball");
      return { success: true, stderr: "" };
    }
    if (command === "/usr/bin/tar") {
      const cIdx = args.indexOf("-C");
      const dest = cIdx >= 0 ? args[cIdx + 1] : undefined;
      if (typeof dest !== "string") {
        throw new TypeError("tar mock expected -C <dir>");
      }
      if (args.includes("-xzf")) {
        const isBuildkit = dest.endsWith("/buildkit") ||
          dest.endsWith("buildkit");
        const fail = isBuildkit
          ? opts.fail === "buildkit-tar"
          : opts.fail === "railpack-tar";
        if (fail) {
          return { success: false, stderr: stderrFor("not a gzip") };
        }
        if (isBuildkit) {
          await Deno.mkdir(join(dest, "bin"), { recursive: true });
          await Deno.writeTextFile(join(dest, "bin", "buildctl"), "");
          await Deno.writeTextFile(join(dest, "bin", "buildkitd"), "");
        } else {
          await Deno.writeTextFile(join(dest, "railpack"), "");
        }
        return { success: true, stderr: "" };
      }
      if (opts.fail === "frontend-tar") {
        return { success: false, stderr: stderrFor("extract error") };
      }
      await Deno.writeTextFile(
        join(dest, "index.json"),
        opts.frontendIndex ??
          JSON.stringify({ manifests: [{ digest: VALID_DIGEST }] }),
      );
      if (opts.wipeRailpackAfterFrontend === true && opts.runtimesDir) {
        await Deno.remove(join(opts.runtimesDir, "railpack"), {
          recursive: true,
        }).catch(() => {});
      }
      return { success: true, stderr: "" };
    }
    if (command === "docker") {
      if (args[0] === "pull") {
        if (opts.fail === "docker-pull") {
          return { success: false, stderr: stderrFor("pull denied") };
        }
        return { success: true, stderr: "" };
      }
      if (args[0] === "save") {
        if (opts.fail === "docker-save") {
          return { success: false, stderr: stderrFor("save denied") };
        }
        const outIdx = args.indexOf("-o");
        const tarball = outIdx >= 0 ? args[outIdx + 1] : undefined;
        if (typeof tarball === "string") {
          await Deno.writeTextFile(tarball, "fake-frontend-tar");
        }
        return { success: true, stderr: "" };
      }
    }
    throw new TypeError(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("railpackImageTag namespaces the service and tags the release", () => {
  assertEquals(
    railpackImageTag("11111111-2222-3333-4444-555555555555", "rel-42"),
    "turbopanel-app/11111111-2222-3333-4444-555555555555:rel-42",
  );
});

test("railpackImageTag folds a compose service name into a docker repository", () => {
  // The release engine's service segment may be a compose service name, which
  // docker repository names cannot carry verbatim: they are lowercase-only, and
  // `_` `.` `-` are the only separators allowed between alphanumerics.
  assertEquals(
    railpackImageTag("Web_API", "rel-1"),
    "turbopanel-app/web_api:rel-1",
  );
  assertEquals(
    railpackImageTag("web:api+v2", "rel-1"),
    "turbopanel-app/web-api-v2:rel-1",
  );
});

test("railpackImageTag refuses a serviceId with no usable repository", () => {
  assertThrows(() => railpackImageTag("___", "rel-1"));
});

test("railpackCacheDir isolates one project's layers from another's", () => {
  const layout = { daemonStateDir: "/var/lib/turbopanel" };
  const a = railpackCacheDir(layout, "project-a");
  const b = railpackCacheDir(layout, "project-b");
  assertEquals(
    a,
    "/var/lib/turbopanel/release-build/buildkit-cache/project-a",
  );
  assertEquals(a === b, false);
});

test("railpackCacheDir refuses a traversal in the project segment", () => {
  assertThrows(() =>
    railpackCacheDir({ daemonStateDir: "/var/lib/turbopanel" }, "../../etc")
  );
});

test("railpackCacheDir refuses an empty or hyphen-led segment", () => {
  assertThrows(() =>
    railpackCacheDir({ daemonStateDir: "/var/lib/turbopanel" }, "")
  );
  assertThrows(() =>
    railpackCacheDir({ daemonStateDir: "/var/lib/turbopanel" }, "-project")
  );
});

test("the gateway frontend resolves inside the vendored runtime tree", () => {
  // The build lane may never name a registry: `--opt source=` addresses this
  // directory by the digest recorded next to it, so a repointed upstream tag
  // cannot change what a host builds.
  assertEquals(
    railpackFrontendLayoutDir("/opt/turbopanel/vendor"),
    "/opt/turbopanel/vendor/railpack-frontend/current/image",
  );
  assertEquals(
    railpackFrontendDigestPath("/opt/turbopanel/vendor"),
    "/opt/turbopanel/vendor/railpack-frontend/current/digest",
  );
});

test({
  name: "ensureBuildkitRailpack returns already-present tools without setup",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir);
      let setupCalls = 0;
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => {
          setupCalls += 1;
          return Promise.resolve();
        },
        runCommand: () => {
          throw new TypeError("download must not run when tools exist");
        },
      });
      assertEquals(setupCalls, 0);
      assertEquals(tools.frontendDigest, VALID_DIGEST);
      assertEquals(
        tools.frontendLayoutDir,
        railpackFrontendLayoutDir(layout.runtimesDir),
      );
      assertEquals(
        tools.railpack,
        join(layout.runtimesDir, "railpack", "current", "railpack"),
      );
    });
  },
});

test({
  name: "ensureBuildkitRailpack accepts a trimmed frontend digest",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, {
        digestContents: `  ${VALID_DIGEST}  \n`,
      });
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => {
          throw new TypeError("setup must not run");
        },
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitRailpack treats a missing digest as not installed",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, { skipDigest: true });
      let setupCalls = 0;
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: async () => {
          setupCalls += 1;
          await writeFile(
            railpackFrontendDigestPath(layout.runtimesDir),
            `${VALID_DIGEST}\n`,
            0o640,
          );
        },
        runCommand: () => {
          throw new TypeError("download must not run after setup installs");
        },
      });
      assertEquals(setupCalls, 1);
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitRailpack rejects a digest that is not sha256 + 64 hex",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, {
        digestContents: "sha256:not-a-real-digest\n",
      });
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        resolveArch: () => "amd64",
        runCommand: mockDownloadCommands(),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitRailpack ignores an uppercase SHA256 digest",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, {
        digestContents: `sha256:${"AB".repeat(32)}\n`,
      });
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        resolveArch: () => "amd64",
        runCommand: mockDownloadCommands(),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitRailpack requires index.json beside the digest",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, { skipIndex: true });
      let setupCalls = 0;
      await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: async () => {
          setupCalls += 1;
          await writeFile(
            join(railpackFrontendLayoutDir(layout.runtimesDir), "index.json"),
            "{}",
            0o640,
          );
        },
        runCommand: () => {
          throw new TypeError("download must not run after setup");
        },
      });
      assertEquals(setupCalls, 1);
    });
  },
});

test({
  name: "ensureBuildkitRailpack requires all three binaries as files",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, { railpackIsDir: true });
      let setupCalls = 0;
      await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: async () => {
          setupCalls += 1;
          await Deno.remove(
            join(layout.runtimesDir, "railpack", "current", "railpack"),
          );
          await writeFile(
            join(layout.runtimesDir, "railpack", "current", "railpack"),
          );
        },
        runCommand: () => {
          throw new TypeError("download must not run after setup");
        },
      });
      assertEquals(setupCalls, 1);
    });
  },
});

test({
  name: "ensureBuildkitRailpack returns after a successful playbook",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => plantVendorTools(layout.runtimesDir),
        runCommand: () => {
          throw new TypeError("download must not run after setup installs");
        },
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitRailpack downloads after the playbook fails",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const stale = join(layout.runtimesDir, "buildkit", "stale");
      await Deno.mkdir(stale, { recursive: true });
      await Deno.symlink(
        stale,
        join(layout.runtimesDir, "buildkit", "current"),
      );
      await Deno.mkdir(
        join(
          layout.runtimesDir,
          "railpack-frontend",
          RAILPACK_FRONTEND_VERSION,
          "image",
        ),
        { recursive: true },
      );
      const record: string[] = [];
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => Promise.reject(new Error("playbook missing")),
        resolveArch: () => "amd64",
        runCommand: mockDownloadCommands({ record }),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
      assertEquals(
        record.some((line) =>
          line.includes(
            `buildkit-v${BUILDKIT_VERSION}.linux-amd64.tar.gz`,
          )
        ),
        true,
      );
      assertEquals(
        record.some((line) =>
          line.includes(`railpack-v${RAILPACK_VERSION}-linux-amd64.tar.gz`)
        ),
        true,
      );
      assertEquals(
        record.some((line) =>
          line.includes(
            `docker pull ${RAILPACK_FRONTEND_IMAGE}:${RAILPACK_FRONTEND_VERSION}`,
          )
        ),
        true,
      );
    });
  },
});

test({
  name: "ensureBuildkitRailpack downloads after a non-Error playbook failure",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => Promise.reject("setup blew up"),
        resolveArch: () => "arm64",
        runCommand: mockDownloadCommands(),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name:
    "ensureBuildkitRailpack downloads when setup succeeds without installing",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const record: string[] = [];
      const tools = await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        resolveArch: () => "amd64",
        runCommand: mockDownloadCommands({ record }),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
      assertEquals(
        record.some((line) => line.startsWith("/usr/bin/curl")),
        true,
      );
    });
  },
});

test({
  name: "ensureBuildkitRailpack uses the host arch when resolveArch is omitted",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const expectedArch = Deno.build.arch === "aarch64" ? "arm64" : "amd64";
      const record: string[] = [];
      await ensureBuildkitRailpack(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        runCommand: mockDownloadCommands({ record }),
      });
      assertEquals(
        record.some((line) => line.includes(`linux-${expectedArch}`)),
        true,
      );
    });
  },
});

test({
  name:
    "ensureBuildkitRailpack throws when download still leaves tools missing",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await assertRejects(
        () =>
          ensureBuildkitRailpack(layout, {
            runBuildkitSetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({
              wipeRailpackAfterFrontend: true,
              runtimesDir: layout.runtimesDir,
            }),
          }),
        Error,
        "Railpack build runtime is missing",
      );
    });
  },
});

test({
  name: "ensureBuildkitRailpack surfaces a thrown resolveArch",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await assertRejects(
        () =>
          ensureBuildkitRailpack(layout, {
            runBuildkitSetup: () => Promise.resolve(),
            resolveArch: () => {
              throw new Error(
                "Unsupported CPU architecture for Railpack builds: riscv64",
              );
            },
            runCommand: () => {
              throw new TypeError("runCommand must not be called");
            },
          }),
        Error,
        "Unsupported CPU architecture for Railpack builds: riscv64",
      );
    });
  },
});

test({
  name: "downloadBuildkitRailpack surfaces curl / tar / docker failures",
  permissions: { read: true, write: true },
  fn: async () => {
    const cases: Array<{
      fail: NonNullable<Parameters<typeof mockDownloadCommands>[0]>["fail"];
      message: string;
      empty?: boolean;
    }> = [
      { fail: "buildkit-curl", message: "curl failed: connection refused" },
      {
        fail: "buildkit-curl",
        message: "curl failed: download error",
        empty: true,
      },
      { fail: "buildkit-tar", message: "tar failed: not a gzip" },
      {
        fail: "buildkit-tar",
        message: "tar failed: extract error",
        empty: true,
      },
      { fail: "railpack-curl", message: "curl failed: connection refused" },
      { fail: "railpack-tar", message: "tar failed: not a gzip" },
      { fail: "docker-pull", message: "docker pull failed: pull denied" },
      {
        fail: "docker-pull",
        message: "docker pull failed: pull error",
        empty: true,
      },
      { fail: "docker-save", message: "docker save failed: save denied" },
      {
        fail: "docker-save",
        message: "docker save failed: save error",
        empty: true,
      },
      { fail: "frontend-tar", message: "tar failed: extract error" },
    ];
    for (const c of cases) {
      await withTempLayout(async (fixture) => {
        const layout = layoutOf(fixture.env);
        await assertRejects(
          () =>
            ensureBuildkitRailpack(layout, {
              runBuildkitSetup: () => Promise.resolve(),
              resolveArch: () => "amd64",
              runCommand: mockDownloadCommands({
                fail: c.fail,
                emptyStderr: c.empty === true,
              }),
            }),
          Error,
          c.message,
        );
      });
    }
  },
});

test({
  name: "installRailpackFrontend rejects a layout that is not a single digest",
  permissions: { read: true, write: true },
  fn: async () => {
    const indexes = [
      "null",
      "[]",
      '{"manifests":[]}',
      '{"manifests":[{},{}]}',
      '{"manifests":[{}]}',
      '{"manifests":[{"digest":1}]}',
      '{"manifests":[{"digest":"sha256:short"}]}',
      '"nope"',
    ];
    for (const frontendIndex of indexes) {
      await withTempLayout(async (fixture) => {
        const layout = layoutOf(fixture.env);
        await assertRejects(
          () =>
            ensureBuildkitRailpack(layout, {
              runBuildkitSetup: () => Promise.resolve(),
              resolveArch: () => "amd64",
              runCommand: mockDownloadCommands({ frontendIndex }),
            }),
          Error,
        );
      });
    }
  },
});

test({
  name: "ensureBuildkitRailpack runDefault path via mocked Deno.Command",
  permissions: { read: true, write: true, run: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const OriginalCommand = Deno.Command;
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = class MockCommand {
        #command: string;
        #args: string[];
        constructor(command: string, options?: { args?: string[] }) {
          this.#command = command;
          this.#args = options?.args ?? [];
        }
        output(): Promise<Deno.CommandOutput> {
          const run = mockDownloadCommands();
          return run(this.#command, this.#args).then((result) => ({
            success: result.success,
            code: result.success ? 0 : 1,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode(result.stderr),
          }));
        }
      };
      try {
        const tools = await ensureBuildkitRailpack(layout, {
          runBuildkitSetup: () => Promise.resolve(),
        });
        assertEquals(tools.frontendDigest, VALID_DIGEST);
      } finally {
        // deno-lint-ignore no-explicit-any
        (Deno as any).Command = OriginalCommand;
      }
    });
  },
});
