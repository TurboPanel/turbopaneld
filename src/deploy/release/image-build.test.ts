import { dirname, join } from "@std/path";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import { withTempLayout } from "../../testing/temp-layout.ts";
import {
  droppedImageBuildEnvNames,
  ensureBuildkitImageBuild,
  type EnsureBuildkitImageBuildDeps,
  IMAGE_BUILD_FRONTEND_IMAGE,
  IMAGE_BUILD_FRONTEND_TAG,
  IMAGE_BUILD_FRONTEND_VERSION,
  IMAGE_BUILD_SHA256,
  IMAGE_BUILD_VERSION,
  imageBuildAssetName,
  imageBuildBinaryPath,
  imageBuildFrontendDigestPath,
  imageBuildFrontendLayoutDir,
  imageBuildImageTag,
  imageBuildToolEnvironment,
} from "./image-build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** SHA-256 of the "fake-tarball" body the curl mock writes. */
const FAKE_TARBALL_SHA256 =
  "746e8948ec0a7b6e150cc34446bad2bd0d0e2e3f0bd8f03f0edef7467a38e3b6";
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
    skipImageBuild?: boolean;
    skipIndex?: boolean;
    skipDigest?: boolean;
    imageBuildIsDir?: boolean;
    digestContents?: string;
  } = {},
): Promise<void> {
  if (!opts.skipImageBuild) {
    const versionDir = join(runtimesDir, "railpack", IMAGE_BUILD_VERSION);
    if (opts.imageBuildIsDir) {
      await Deno.mkdir(join(versionDir, "railpack"), { recursive: true });
    } else {
      await writeFile(join(versionDir, "railpack"));
    }
    await linkCurrent(join(runtimesDir, "railpack"), versionDir);
  }
  const frontendVersionDir = join(
    runtimesDir,
    "railpack-frontend",
    IMAGE_BUILD_FRONTEND_VERSION,
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
    | "railpack-curl"
    | "railpack-tar"
    | "docker-pull"
    | "docker-save"
    | "frontend-tar";
  emptyStderr?: boolean;
  frontendIndex?: string;
  wipeImageBuildAfterFrontend?: boolean;
  runtimesDir?: string;
  record?: string[];
} = {}): NonNullable<EnsureBuildkitImageBuildDeps["runCommand"]> {
  const stderrFor = (fallback: string) =>
    opts.emptyStderr === true ? "" : fallback;
  return async (command, args) => {
    opts.record?.push([command, ...args].join(" "));
    if (command === "/usr/bin/curl") {
      const url = args.at(-1);
      if (typeof url !== "string") {
        throw new TypeError("curl mock expected a URL argument");
      }
      if (opts.fail === "railpack-curl") {
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
        if (opts.fail === "railpack-tar") {
          return { success: false, stderr: stderrFor("not a gzip") };
        }
        await Deno.writeTextFile(join(dest, "railpack"), "");
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
      if (opts.wipeImageBuildAfterFrontend === true && opts.runtimesDir) {
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

test("imageBuildImageTag namespaces the service and tags the release", () => {
  assertEquals(
    imageBuildImageTag("11111111-2222-3333-4444-555555555555", "rel-42"),
    "turbopanel-app/11111111-2222-3333-4444-555555555555:rel-42",
  );
});

test("imageBuildImageTag folds a compose service name into a docker repository", () => {
  // The release engine's service segment may be a compose service name, which
  // docker repository names cannot carry verbatim: they are lowercase-only, and
  // `_` `.` `-` are the only separators allowed between alphanumerics.
  assertEquals(
    imageBuildImageTag("Web_API", "rel-1"),
    "turbopanel-app/web_api:rel-1",
  );
  assertEquals(
    imageBuildImageTag("web:api+v2", "rel-1"),
    "turbopanel-app/web-api-v2:rel-1",
  );
});

test("imageBuildImageTag refuses a serviceId with no usable repository", () => {
  assertThrows(() => imageBuildImageTag("___", "rel-1"));
});

test("the gateway frontend resolves inside the vendored runtime tree", () => {
  // The build names the frontend by the digest recorded next to this layout,
  // so a repointed upstream tag cannot change what a host builds.
  assertEquals(
    imageBuildFrontendLayoutDir("/opt/turbopanel/vendor"),
    "/opt/turbopanel/vendor/railpack-frontend/current/image",
  );
  assertEquals(
    imageBuildFrontendDigestPath("/opt/turbopanel/vendor"),
    "/opt/turbopanel/vendor/railpack-frontend/current/digest",
  );
});

test({
  name: "ensureBuildkitImageBuild returns already-present tools without setup",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir);
      let setupCalls = 0;
      const tools = await ensureBuildkitImageBuild(layout, {
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
        imageBuildFrontendLayoutDir(layout.runtimesDir),
      );
      assertEquals(
        tools.planner,
        join(layout.runtimesDir, "railpack", "current", "railpack"),
      );
    });
  },
});

test({
  name: "ensureBuildkitImageBuild accepts a trimmed frontend digest",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, {
        digestContents: `  ${VALID_DIGEST}  \n`,
      });
      const tools = await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: () => {
          throw new TypeError("setup must not run");
        },
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitImageBuild treats a missing digest as not installed",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, { skipDigest: true });
      let setupCalls = 0;
      const tools = await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: async () => {
          setupCalls += 1;
          await writeFile(
            imageBuildFrontendDigestPath(layout.runtimesDir),
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
  name: "ensureBuildkitImageBuild rejects a digest that is not sha256 + 64 hex",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, {
        digestContents: "sha256:not-a-real-digest\n",
      });
      const tools = await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        resolveArch: () => "amd64",
        imageBuildSha256: FAKE_TARBALL_SHA256,
        runCommand: mockDownloadCommands(),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitImageBuild ignores an uppercase SHA256 digest",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, {
        digestContents: `sha256:${"AB".repeat(32)}\n`,
      });
      const tools = await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        resolveArch: () => "amd64",
        imageBuildSha256: FAKE_TARBALL_SHA256,
        runCommand: mockDownloadCommands(),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name: "ensureBuildkitImageBuild requires index.json beside the digest",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, { skipIndex: true });
      let setupCalls = 0;
      await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: async () => {
          setupCalls += 1;
          await writeFile(
            join(imageBuildFrontendLayoutDir(layout.runtimesDir), "index.json"),
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
  name: "ensureBuildkitImageBuild requires the railpack binary as a file",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir, { imageBuildIsDir: true });
      let setupCalls = 0;
      await ensureBuildkitImageBuild(layout, {
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
  name: "ensureBuildkitImageBuild returns after a successful playbook",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const tools = await ensureBuildkitImageBuild(layout, {
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
  name: "ensureBuildkitImageBuild downloads after the playbook fails",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const stale = join(layout.runtimesDir, "railpack", "stale");
      await Deno.mkdir(stale, { recursive: true });
      await Deno.symlink(
        stale,
        join(layout.runtimesDir, "railpack", "current"),
      );
      await Deno.mkdir(
        join(
          layout.runtimesDir,
          "railpack-frontend",
          IMAGE_BUILD_FRONTEND_VERSION,
          "image",
        ),
        { recursive: true },
      );
      const record: string[] = [];
      const tools = await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: () => Promise.reject(new Error("playbook missing")),
        resolveArch: () => "amd64",
        imageBuildSha256: FAKE_TARBALL_SHA256,
        runCommand: mockDownloadCommands({ record }),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
      // BuildKit itself is no longer vendored by the daemon: the Engine's own
      // builder runs the frontend.
      assertEquals(record.some((line) => line.includes("buildkit")), false);
      assertEquals(
        record.some((line) =>
          line.includes(
            `railpack-v${IMAGE_BUILD_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
          )
        ),
        true,
      );
      assertEquals(
        record.some((line) =>
          line.includes(
            `docker pull ${IMAGE_BUILD_FRONTEND_IMAGE}:v${IMAGE_BUILD_FRONTEND_VERSION}`,
          )
        ),
        true,
      );
    });
  },
});

test("the frontend tag is v-prefixed in the daemon and the buildkit role", async () => {
  assertEquals(IMAGE_BUILD_FRONTEND_TAG, `v${IMAGE_BUILD_FRONTEND_VERSION}`);
  const roles = new URL(
    "../../../orchestration/roles/buildkit/",
    import.meta.url,
  );
  const defaults = await Deno.readTextFile(new URL("defaults/main.yml", roles));
  const tasks = await Deno.readTextFile(new URL("tasks/main.yml", roles));
  assertEquals(
    /^railpack_frontend_tag: "(.+)"$/m.exec(defaults)?.[1],
    "v{{ railpack_frontend_version }}",
  );
  assertEquals(
    /^railpack_frontend_version: "(.+)"$/m.exec(defaults)?.[1],
    IMAGE_BUILD_FRONTEND_VERSION,
  );
  assertEquals(
    tasks.includes(
      'REF="{{ railpack_frontend_image }}:{{ railpack_frontend_tag }}"',
    ),
    true,
  );
});

test({
  name:
    "ensureBuildkitImageBuild reports the playbook failure when the fallback fails too",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const err = await assertRejects(
        () =>
          ensureBuildkitImageBuild(layout, {
            runBuildkitSetup: () =>
              Promise.reject(new Error("frontend task: non-zero return code")),
            resolveArch: () => "amd64",
            imageBuildSha256: FAKE_TARBALL_SHA256,
            runCommand: mockDownloadCommands({ fail: "railpack-curl" }),
          }),
        Error,
        "buildkit-setup playbook failed: frontend task: non-zero return code",
      );
      assertEquals(err.message.includes("direct download fallback"), true);
    });
  },
});

test({
  name: "ensureBuildkitImageBuild downloads after a non-Error playbook failure",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const tools = await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: () => Promise.reject("setup blew up"),
        resolveArch: () => "arm64",
        imageBuildSha256: FAKE_TARBALL_SHA256,
        runCommand: mockDownloadCommands(),
      });
      assertEquals(tools.frontendDigest, VALID_DIGEST);
    });
  },
});

test({
  name:
    "ensureBuildkitImageBuild downloads when setup succeeds without installing",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const record: string[] = [];
      const tools = await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        resolveArch: () => "amd64",
        imageBuildSha256: FAKE_TARBALL_SHA256,
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
  name:
    "ensureBuildkitImageBuild uses the host arch when resolveArch is omitted",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const expectedArch = Deno.build.arch === "aarch64" ? "arm64" : "amd64";
      const record: string[] = [];
      await ensureBuildkitImageBuild(layout, {
        runBuildkitSetup: () => Promise.resolve(),
        imageBuildSha256: FAKE_TARBALL_SHA256,
        runCommand: mockDownloadCommands({ record }),
      });
      assertEquals(
        record.some((line) => line.includes(imageBuildAssetName(expectedArch))),
        true,
      );
    });
  },
});

test({
  name:
    "ensureBuildkitImageBuild throws when download still leaves tools missing",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await assertRejects(
        () =>
          ensureBuildkitImageBuild(layout, {
            runBuildkitSetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            imageBuildSha256: FAKE_TARBALL_SHA256,
            runCommand: mockDownloadCommands({
              wipeImageBuildAfterFrontend: true,
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
  name: "ensureBuildkitImageBuild surfaces a thrown resolveArch",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await assertRejects(
        () =>
          ensureBuildkitImageBuild(layout, {
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
  name:
    "ensureBuildkitImageBuild refuses a tarball whose SHA-256 is not the pin",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await assertRejects(
        () =>
          ensureBuildkitImageBuild(layout, {
            runBuildkitSetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands(),
          }),
        Error,
        "SHA-256 mismatch",
      );
    });
  },
});

test({
  name: "the pinned Railpack digests cover both architectures",
  fn: () => {
    for (const arch of ["amd64", "arm64"] as const) {
      assertEquals(/^[0-9a-f]{64}$/.test(IMAGE_BUILD_SHA256[arch]), true);
    }
  },
});

test({
  name: "downloadBuildkitImageBuild surfaces curl / tar / docker failures",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    const cases: Array<{
      fail: NonNullable<Parameters<typeof mockDownloadCommands>[0]>["fail"];
      message: string;
      empty?: boolean;
    }> = [
      { fail: "railpack-curl", message: "curl failed: connection refused" },
      {
        fail: "railpack-curl",
        message: "curl failed: download error",
        empty: true,
      },
      { fail: "railpack-tar", message: "tar failed: not a gzip" },
      {
        fail: "railpack-tar",
        message: "tar failed: extract error",
        empty: true,
      },
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
            ensureBuildkitImageBuild(layout, {
              runBuildkitSetup: () => Promise.resolve(),
              resolveArch: () => "amd64",
              imageBuildSha256: FAKE_TARBALL_SHA256,
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
  name:
    "installImageBuildFrontend rejects a layout that is not a single digest",
  permissions: { read: true, write: true, run: ["ln"] },
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
            ensureBuildkitImageBuild(layout, {
              runBuildkitSetup: () => Promise.resolve(),
              resolveArch: () => "amd64",
              imageBuildSha256: FAKE_TARBALL_SHA256,
              runCommand: mockDownloadCommands({ frontendIndex }),
            }),
          Error,
        );
      });
    }
  },
});

test({
  name: "ensureBuildkitImageBuild runDefault path via mocked Deno.Command",
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
          // `createSymlink` spawns a real `ln`; let it through so the
          // `current` links this test asserts on are actually created.
          if (this.#command === "ln") {
            return new OriginalCommand(this.#command, {
              args: this.#args,
              stdout: "null",
              stderr: "piped",
              clearEnv: true,
              env: { PATH: "/usr/bin:/bin" },
            }).output();
          }
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
        const tools = await ensureBuildkitImageBuild(layout, {
          runBuildkitSetup: () => Promise.resolve(),
          imageBuildSha256: FAKE_TARBALL_SHA256,
        });
        assertEquals(tools.frontendDigest, VALID_DIGEST);
      } finally {
        // deno-lint-ignore no-explicit-any
        (Deno as any).Command = OriginalCommand;
      }
    });
  },
});

test({
  name: "ensureBuildkitImageBuild rethrows a non-NotFound digest read",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir);
      const digestPath = imageBuildFrontendDigestPath(layout.runtimesDir);
      await Deno.remove(digestPath);
      await Deno.mkdir(digestPath);
      await assertRejects(
        () =>
          ensureBuildkitImageBuild(layout, {
            runBuildkitSetup: () => Promise.resolve(),
            runCommand: () => {
              throw new TypeError("download must not run");
            },
          }),
        Error,
      );
    });
  },
});

test({
  name: "ensureBuildkitImageBuild rethrows a non-NotFound tool stat",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      await plantVendorTools(layout.runtimesDir);
      const originalStat = Deno.stat;
      const railpack = imageBuildBinaryPath(layout.runtimesDir);
      Deno.stat = ((path: string | URL) => {
        if (String(path) === railpack) {
          return Promise.reject(new TypeError("stat busy"));
        }
        return originalStat.call(Deno, path);
      }) as typeof Deno.stat;
      try {
        await assertRejects(
          () =>
            ensureBuildkitImageBuild(layout, {
              runBuildkitSetup: () => Promise.resolve(),
              runCommand: () => {
                throw new TypeError("download must not run");
              },
            }),
          TypeError,
          "stat busy",
        );
      } finally {
        Deno.stat = originalStat;
      }
    });
  },
});

test({
  name: "ensureBuildkitImageBuild rethrows when current cannot be replaced",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = layoutOf(fixture.env);
      const current = join(layout.runtimesDir, "railpack", "current");
      await Deno.mkdir(join(current, "nested"), { recursive: true });
      await Deno.writeTextFile(join(current, "nested", "keep"), "x");
      await assertRejects(
        () =>
          ensureBuildkitImageBuild(layout, {
            runBuildkitSetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            imageBuildSha256: FAKE_TARBALL_SHA256,
            runCommand: mockDownloadCommands(),
          }),
        Error,
      );
    });
  },
});

test("the Railpack tools get tenant build.env without any name that loads code or is the sandbox", () => {
  const env = imageBuildToolEnvironment({
    kind: "railpack",
    env: {
      NEXT_PUBLIC_SITE_URL: "https://example.test",
      LD_AUDIT: "/checkout/evil.so",
      LD_PRELOAD: "/checkout/evil.so",
      LD_DEBUG_OUTPUT: "/tmp/x",
      NODE_OPTIONS: "--require /checkout/evil.js",
      PYTHONSTARTUP: "/checkout/evil.py",
      JAVA_TOOL_OPTIONS: "-javaagent:/checkout/evil.jar",
      DOCKER_HOST: "tcp://evil:2375",
      PATH: "/checkout/bin",
      HOME: "/checkout",
      GIT_SSH_COMMAND: "ssh -i /evil",
      BASH_ENV: "/checkout/evil.sh",
      "BAD NAME": "x",
      "1BAD": "x",
      "A-B": "x",
      "": "x",
    },
  }, "/work");
  assertEquals(env.NEXT_PUBLIC_SITE_URL, "https://example.test");
  for (
    const refused of [
      "LD_AUDIT",
      "LD_PRELOAD",
      "LD_DEBUG_OUTPUT",
      "NODE_OPTIONS",
      "PYTHONSTARTUP",
      "JAVA_TOOL_OPTIONS",
      "DOCKER_HOST",
      "GIT_SSH_COMMAND",
      "BASH_ENV",
      "BAD NAME",
      "1BAD",
      "A-B",
      "",
    ]
  ) {
    assertEquals(refused in env, false, refused);
  }
  // The daemon's own PATH and the work tree HOME stay what they were.
  assertEquals(env.HOME, "/work");
  assertEquals(env.PATH === "/checkout/bin", false);
  assertEquals(env.CI, "1");
});

test("the names the Railpack lane drops are listed, by name only, and include tool config families", () => {
  const dropped = droppedImageBuildEnvNames({
    kind: "railpack",
    env: {
      NEXT_PUBLIC_SITE_URL: "https://example.test",
      GOFLAGS: "-toolexec=/x",
      MISE_CONFIG_DIR: "/x",
      ASDF_DATA_DIR: "/x",
      npm_config_registry: "https://x.test",
      BUNDLE_GEMFILE: "/x",
      PIP_INDEX_URL: "https://x.test",
      LD_PRELOAD: "/x",
    },
  });
  assertEquals(dropped, [
    "ASDF_DATA_DIR",
    "BUNDLE_GEMFILE",
    "GOFLAGS",
    "LD_PRELOAD",
    "MISE_CONFIG_DIR",
    "npm_config_registry",
    "PIP_INDEX_URL",
  ]);
  assertEquals(
    droppedImageBuildEnvNames({ kind: "railpack", env: { OK_NAME: "1" } }),
    [],
  );
});
