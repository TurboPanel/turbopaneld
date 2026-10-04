import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  ensureHostingCaddy,
  type EnsureHostingCaddyDeps,
  grantHostingCaddyRead,
  HOSTING_CADDY_VERSION,
  INGRESS_GUARD_UNIT,
  INGRESS_GUARD_VERSION,
  verifyHostingCaddyTarballSha256,
} from "./ensure-hosting-caddy.ts";

const skipTarballDigestVerify = () => Promise.resolve();
const accountPresent = () => Promise.resolve(true);
/** The ingress guard ruleset is current and its unit active. */
const guardReady = {
  ingressGuardCurrent: () => Promise.resolve(true),
  ingressGuardActive: () => Promise.resolve(true),
} satisfies EnsureHostingCaddyDeps;

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function plantVendorCaddy(
  runtimesDir: string,
  contents = "#!/bin/true\n",
): Promise<string> {
  const versionDir = join(runtimesDir, "caddy", HOSTING_CADDY_VERSION);
  const currentLink = join(runtimesDir, "caddy", "current");
  const binPath = join(currentLink, "caddy");
  await Deno.mkdir(versionDir, { recursive: true });
  await Deno.writeTextFile(join(versionDir, "caddy"), contents, {
    mode: 0o750,
  });
  try {
    await Deno.remove(currentLink);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.symlink(versionDir, currentLink);
  return binPath;
}

function mockDownloadCommands(opts: {
  curlOk?: boolean;
  tarOk?: boolean;
  chownOk?: boolean;
  curlStderr?: string;
  tarStderr?: string;
  chownStderr?: string;
  writeExtracted?: boolean;
}): NonNullable<EnsureHostingCaddyDeps["runCommand"]> {
  const curlOk = opts.curlOk !== false;
  const tarOk = opts.tarOk !== false;
  const chownOk = opts.chownOk === true;
  const writeExtracted = opts.writeExtracted !== false;
  return (command, args) => {
    if (command === "/usr/bin/curl") {
      if (!curlOk) {
        return Promise.resolve({
          success: false,
          stderr: opts.curlStderr ?? "",
        });
      }
      const outIdx = args.indexOf("-o");
      const tarball = outIdx >= 0 ? args[outIdx + 1] : undefined;
      if (typeof tarball !== "string") {
        throw new TypeError("curl mock expected -o <path>");
      }
      return Deno.writeTextFile(tarball, "fake-tarball").then(() => ({
        success: true,
        stderr: "",
      }));
    }
    if (command === "/usr/bin/tar") {
      if (!tarOk) {
        return Promise.resolve({
          success: false,
          stderr: opts.tarStderr ?? "",
        });
      }
      const cIdx = args.indexOf("-C");
      const dest = cIdx >= 0 ? args[cIdx + 1] : undefined;
      if (typeof dest !== "string") {
        throw new TypeError("tar mock expected -C <dir>");
      }
      if (!writeExtracted) {
        return Promise.resolve({ success: true, stderr: "" });
      }
      return Deno.writeTextFile(join(dest, "caddy"), "#!/bin/caddy-mock\n", {
        mode: 0o750,
      }).then(() => ({ success: true, stderr: "" }));
    }
    if (command === "sudo") {
      return Promise.resolve({
        success: chownOk,
        stderr: chownOk ? "" : (opts.chownStderr ?? ""),
      });
    }
    throw new TypeError(`unexpected command: ${command}`);
  };
}

test({
  name: "ensureHostingCaddy returns existing vendor binary without downloading",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const binPath = await plantVendorCaddy(layout.runtimesDir);

      let setupCalls = 0;
      const resolved = await ensureHostingCaddy(layout, {
        accountExists: accountPresent,
        ...guardReady,
        runCaddySetup: () => {
          setupCalls += 1;
          return Promise.resolve();
        },
        runCommand: () => {
          throw new TypeError("download must not run when binary exists");
        },
      });
      assertEquals(resolved, binPath);
      assertEquals(setupCalls, 0);
      assertEquals(await Deno.readTextFile(resolved), "#!/bin/true\n");
    });
  },
});

test({
  name: "ensureHostingCaddy returns after successful caddy-setup playbook",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      let setupCalls = 0;
      const resolved = await ensureHostingCaddy(layout, {
        accountExists: accountPresent,
        ...guardReady,
        runCaddySetup: async () => {
          setupCalls += 1;
          await plantVendorCaddy(layout.runtimesDir, "#!/bin/from-setup\n");
        },
        runCommand: () => {
          throw new TypeError("download must not run after setup installs");
        },
      });
      assertEquals(setupCalls, 1);
      assertEquals(await Deno.readTextFile(resolved), "#!/bin/from-setup\n");
    });
  },
});

test({
  name: "ensureHostingCaddy downloads when setup fails and chown is skipped",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const commands: string[] = [];
      const resolved = await ensureHostingCaddy(layout, {
        accountExists: accountPresent,
        ...guardReady,
        runCaddySetup: () => Promise.reject(new Error("playbook missing")),
        resolveArch: () => "amd64",
        runCommand: (command, args, opts) => {
          commands.push(command);
          return mockDownloadCommands({ chownOk: false })(command, args, opts);
        },
        verifyTarballSha256: skipTarballDigestVerify,
      });
      assertEquals(commands, ["/usr/bin/curl", "/usr/bin/tar", "sudo"]);
      assertEquals(await Deno.readTextFile(resolved), "#!/bin/caddy-mock\n");
      assertEquals(
        await Deno.readTextFile(
          join(layout.runtimesDir, "caddy", HOSTING_CADDY_VERSION, "caddy"),
        ),
        "#!/bin/caddy-mock\n",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy downloads when setup succeeds without installing",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      // Pre-create a stale current link so Deno.remove covers the non-NotFound path.
      const staleDir = join(layout.runtimesDir, "caddy", "stale");
      const currentLink = join(layout.runtimesDir, "caddy", "current");
      await Deno.mkdir(staleDir, { recursive: true });
      await Deno.writeTextFile(join(staleDir, "caddy"), "stale\n");
      await Deno.symlink(staleDir, currentLink);
      // Remove the file so caddyBinaryPresent is false, but keep the symlink target dir.
      await Deno.remove(join(staleDir, "caddy"));

      const resolved = await ensureHostingCaddy(layout, {
        accountExists: accountPresent,
        ...guardReady,
        runCaddySetup: () => Promise.resolve(),
        resolveArch: () => "arm64",
        runCommand: mockDownloadCommands({
          chownOk: true,
          chownStderr: "",
        }),
        verifyTarballSha256: skipTarballDigestVerify,
      });
      assertEquals(await Deno.readTextFile(resolved), "#!/bin/caddy-mock\n");
    });
  },
});

test({
  name: "verifyHostingCaddyTarballSha256 rejects digest mismatch",
  permissions: { read: true, write: true },
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-caddy-digest-" });
    const tarball = join(tmp, "caddy.tar.gz");
    await Deno.writeTextFile(tarball, "not-a-real-caddy-release");
    try {
      await assertRejects(
        () => verifyHostingCaddyTarballSha256("amd64", tarball),
        Error,
        "SHA-256 mismatch",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

test({
  name: "ensureHostingCaddy surfaces digest verification failure",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ...guardReady,
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({}),
            verifyTarballSha256: () =>
              Promise.reject(new Error("digest mismatch")),
          }),
        Error,
        "digest mismatch",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces curl failure",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ...guardReady,
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({
              curlOk: false,
              curlStderr: "connection refused",
            }),
            verifyTarballSha256: skipTarballDigestVerify,
          }),
        Error,
        "curl failed: connection refused",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces curl failure with empty stderr",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ...guardReady,
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({ curlOk: false, curlStderr: "" }),
            verifyTarballSha256: skipTarballDigestVerify,
          }),
        Error,
        "curl failed: download error",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces tar failure",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ...guardReady,
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({
              tarOk: false,
              tarStderr: "not a gzip",
            }),
            verifyTarballSha256: skipTarballDigestVerify,
          }),
        Error,
        "tar failed: not a gzip",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces tar failure with empty stderr",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ...guardReady,
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({ tarOk: false, tarStderr: "" }),
            verifyTarballSha256: skipTarballDigestVerify,
          }),
        Error,
        "tar failed: extract error",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy throws when download leaves binary missing",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const base = mockDownloadCommands({ chownOk: true });
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ...guardReady,
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: async (command, args, opts) => {
              const result = await base(command, args, opts);
              if (command === "sudo") {
                // Wipe the tree after a successful install so the final
                // presence check fails.
                await Deno.remove(join(layout.runtimesDir, "caddy"), {
                  recursive: true,
                }).catch(() => {});
              }
              return result;
            },
            verifyTarballSha256: skipTarballDigestVerify,
          }),
        Error,
        "Hosting Caddy runtime is missing",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy runDefault path via mocked Deno.Command",
  permissions: { read: true, write: true, run: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
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
          const enc = new TextEncoder();
          if (this.#command === "/usr/bin/curl") {
            const outIdx = this.#args.indexOf("-o");
            const tarball = outIdx >= 0 ? this.#args[outIdx + 1] : undefined;
            if (typeof tarball !== "string") {
              throw new TypeError("curl mock expected -o <path>");
            }
            Deno.writeTextFileSync(tarball, "fake-tarball");
            return Promise.resolve({
              success: true,
              code: 0,
              signal: null,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          }
          if (this.#command === "/usr/bin/tar") {
            const cIdx = this.#args.indexOf("-C");
            const dest = cIdx >= 0 ? this.#args[cIdx + 1] : undefined;
            if (typeof dest !== "string") {
              throw new TypeError("tar mock expected -C <dir>");
            }
            Deno.writeTextFileSync(join(dest, "caddy"), "#!/bin/via-command\n");
            return Promise.resolve({
              success: true,
              code: 0,
              signal: null,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          }
          if (this.#command === "sudo") {
            return Promise.resolve({
              success: false,
              code: 1,
              signal: null,
              stdout: new Uint8Array(),
              stderr: enc.encode("no passwordless sudo\n"),
            });
          }
          // `createSymlink` spawns a real `ln`; let it through so the
          // `current` link this test asserts on is actually created.
          if (this.#command === "ln") {
            return new OriginalCommand(this.#command, {
              args: this.#args,
              stdout: "null",
              stderr: "piped",
              clearEnv: true,
              env: { PATH: "/usr/bin:/bin" },
            }).output();
          }
          throw new TypeError(`unexpected command: ${this.#command}`);
        }
      };

      try {
        // No resolveArch / runCommand inject — exercises defaults.
        const resolved = await ensureHostingCaddy(layout, {
          accountExists: accountPresent,
          ...guardReady,
          runCaddySetup: () => Promise.resolve(),
          verifyTarballSha256: skipTarballDigestVerify,
        });
        assertEquals(await Deno.readTextFile(resolved), "#!/bin/via-command\n");
      } finally {
        // deno-lint-ignore no-explicit-any
        (Deno as any).Command = OriginalCommand;
      }
    });
  },
});

test({
  name: "ensureHostingCaddy logs non-Error setup failures then downloads",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const resolved = await ensureHostingCaddy(layout, {
        accountExists: accountPresent,
        ...guardReady,
        runCaddySetup: () => Promise.reject("setup blew up"),
        resolveArch: () => "amd64",
        runCommand: mockDownloadCommands({
          chownOk: false,
          chownStderr: "sudo: a password is required",
        }),
        verifyTarballSha256: skipTarballDigestVerify,
      });
      assertEquals(await Deno.readTextFile(resolved), "#!/bin/caddy-mock\n");
    });
  },
});

test({
  name: "ensureHostingCaddy rejects unsupported architecture",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ...guardReady,
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => {
              throw new Error(
                "Unsupported CPU architecture for hosting Caddy: riscv64",
              );
            },
            runCommand: () => {
              throw new TypeError("runCommand must not be called");
            },
          }),
        Error,
        "Unsupported CPU architecture for hosting Caddy: riscv64",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy rethrows when the caddy binary cannot be statted",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const originalStat = Deno.stat.bind(Deno);
      const caddyPath = join(layout.runtimesDir, "caddy", "current", "caddy");
      Deno.stat = ((path: string | URL) => {
        if (String(path) === caddyPath) {
          return Promise.reject(new Deno.errors.PermissionDenied("caddy"));
        }
        return originalStat(path);
      }) as typeof Deno.stat;
      try {
        await assertRejects(
          () =>
            ensureHostingCaddy(layout, {
              accountExists: accountPresent,
              ...guardReady,
              runCaddySetup: () => Promise.resolve(),
            }),
          Deno.errors.PermissionDenied,
          "caddy",
        );
      } finally {
        Deno.stat = originalStat;
      }
    });
  },
});

test({
  name:
    "ensureHostingCaddy rethrows when the current symlink cannot be removed",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const staleDir = join(layout.runtimesDir, "caddy", "stale-link");
      const currentLink = join(layout.runtimesDir, "caddy", "current");
      await Deno.mkdir(staleDir, { recursive: true });
      await Deno.symlink(staleDir, currentLink);
      const originalRemove = Deno.remove.bind(Deno);
      Deno.remove = ((path: string | URL, opts?: Deno.RemoveOptions) => {
        if (String(path) === currentLink) {
          return Promise.reject(new Deno.errors.PermissionDenied("link"));
        }
        return originalRemove(path, opts);
      }) as typeof Deno.remove;
      try {
        await assertRejects(
          () =>
            ensureHostingCaddy(layout, {
              accountExists: accountPresent,
              ...guardReady,
              runCaddySetup: () => Promise.resolve(),
              resolveArch: () => "amd64",
              runCommand: mockDownloadCommands({}),
              verifyTarballSha256: skipTarballDigestVerify,
            }),
          Deno.errors.PermissionDenied,
          "link",
        );
      } finally {
        Deno.remove = originalRemove;
      }
    });
  },
});

test({
  name:
    "ensureHostingCaddy runs caddy-setup when the binary exists but the account does not",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const bin = await plantVendorCaddy(layout.runtimesDir);
      let account = false;
      let setupCalls = 0;
      const resolved = await ensureHostingCaddy(layout, {
        accountExists: () => Promise.resolve(account),
        ...guardReady,
        runCaddySetup: () => {
          setupCalls += 1;
          account = true;
          return Promise.resolve();
        },
      });
      assertEquals(resolved, bin);
      assertEquals(setupCalls, 1);
    });
  },
});

test({
  name: "ensureHostingCaddy refuses when caddy-setup leaves no account",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await plantVendorCaddy(layout.runtimesDir);
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: () => Promise.resolve(false),
            runCaddySetup: () => Promise.resolve(),
          }),
        Error,
        "Hosting Caddy account tpedge is missing",
      );
    });
  },
});

test({
  name:
    "ensureHostingCaddy re-runs caddy-setup when the guard unit is inactive",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const bin = await plantVendorCaddy(layout.runtimesDir);
      let active = false;
      let setupCalls = 0;
      const resolved = await ensureHostingCaddy(layout, {
        accountExists: accountPresent,
        ingressGuardCurrent: () => Promise.resolve(true),
        ingressGuardActive: () => Promise.resolve(active),
        runCaddySetup: () => {
          setupCalls += 1;
          active = true;
          return Promise.resolve();
        },
      });
      assertEquals(resolved, bin);
      assertEquals(setupCalls, 1);
    });
  },
});

test({
  name:
    "ensureHostingCaddy refuses when caddy-setup leaves no current ingress guard",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await plantVendorCaddy(layout.runtimesDir);
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ingressGuardCurrent: () => Promise.resolve(false),
            ingressGuardActive: () => Promise.resolve(true),
            runCaddySetup: () => Promise.resolve(),
          }),
        Error,
        `Ingress guard ${INGRESS_GUARD_VERSION} is not installed`,
      );
    });
  },
});

test({
  name: "ensureHostingCaddy refuses when the ingress guard unit stays inactive",
  permissions: { read: true, write: true, run: ["ln"] },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await plantVendorCaddy(layout.runtimesDir);
      await assertRejects(
        () =>
          ensureHostingCaddy(layout, {
            accountExists: accountPresent,
            ingressGuardCurrent: () => Promise.resolve(true),
            ingressGuardActive: () => Promise.resolve(false),
            runCaddySetup: () => Promise.resolve(),
          }),
        Error,
        `Ingress guard ${INGRESS_GUARD_UNIT} is not active`,
      );
    });
  },
});

type Reply = { success: boolean; stderr: string; stdout?: string };
type Call = { command: string; args: string[] };

async function plantHostingTree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tp-hosting-acl-" });
  await Deno.mkdir(join(dir, "sites"), { mode: 0o750 });
  await Deno.writeTextFile(join(dir, "Caddyfile"), "x", { mode: 0o640 });
  await Deno.writeTextFile(join(dir, "sites", "a.caddy"), "x", { mode: 0o640 });
  await Deno.symlink("/etc/passwd", join(dir, "sites", "link.caddy"));
  return dir;
}

/** getfacl text where each path carries `acl` for the user. */
function getfaclFor(paths: string[], line: string): string {
  return paths.map((p) => `# file: ${p}\nuser::rw-\n${line}\n`).join("\n");
}

function fakeHost(opts: {
  account?: boolean;
  setfaclOk?: boolean;
  acl?: (path: string) => string;
}): { calls: Call[]; run: NonNullable<EnsureHostingCaddyDeps["runCommand"]> } {
  const calls: Call[] = [];
  const run = (command: string, args: string[]): Promise<Reply> => {
    calls.push({ command, args });
    if (command === "getent") {
      return Promise.resolve({
        success: opts.account !== false,
        stderr: "",
      });
    }
    if (command === "setfacl") {
      return Promise.resolve({
        success: opts.setfaclOk !== false,
        stderr: opts.setfaclOk === false ? "Operation not permitted" : "",
      });
    }
    const paths = args.slice(args.indexOf("--") + 1);
    return Promise.resolve({
      success: true,
      stderr: "",
      stdout: paths.map((p) =>
        `# file: ${p}\nuser::rw-\n${opts.acl?.(p) ?? ""}\n`
      ).join("\n"),
    });
  };
  return { calls, run };
}

const OK_ACL = (p: string) =>
  p.endsWith("sites") || !p.includes(".")
    ? "user:tpedge:r-x\t#effective:r-x"
    : "user:tpedge:r--\t#effective:r--";

test("grantHostingCaddyRead sets rX on files, rX plus a default on folders, skips symlinks, then reads back", async () => {
  const dir = await plantHostingTree();
  try {
    const host = fakeHost({ acl: OK_ACL });
    await grantHostingCaddyRead(dir, host.run);
    const [getent, files, dirs, getfacl] = host.calls;
    assertEquals(getent?.command, "getent");
    assertEquals(files?.command, "setfacl");
    assertEquals(files?.args.slice(0, 3), ["-m", "u:tpedge:rX", "--"]);
    assertEquals(
      files?.args.slice(3).sort(),
      [join(dir, "Caddyfile"), join(dir, "sites", "a.caddy")].sort(),
    );
    assertEquals(dirs?.args.slice(0, 5), [
      "-m",
      "u:tpedge:rX",
      "-m",
      "d:u:tpedge:rX",
      "--",
    ]);
    assertEquals(getfacl?.command, "getfacl");
    assertEquals(
      host.calls.some((c) => c.args.some((a) => a.endsWith("link.caddy"))),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("grantHostingCaddyRead leaves a host without the account alone", async () => {
  const dir = await plantHostingTree();
  try {
    const host = fakeHost({ account: false });
    await grantHostingCaddyRead(dir, host.run);
    assertEquals(host.calls.map((c) => c.command), ["getent"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("grantHostingCaddyRead fails loudly when tpedge still cannot read (setfacl refused or missing)", async () => {
  const dir = await plantHostingTree();
  try {
    await assertRejects(
      () => grantHostingCaddyRead(dir, fakeHost({ setfaclOk: false }).run),
      Error,
      "cannot read its config",
    );
    const missing: NonNullable<EnsureHostingCaddyDeps["runCommand"]> = (
      command,
    ) =>
      command === "getent"
        ? Promise.resolve({ success: true, stderr: "" })
        : Promise.reject(new Deno.errors.NotFound(command));
    await assertRejects(
      () => grantHostingCaddyRead(dir, missing),
      Error,
      "cannot read its config",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("grantHostingCaddyRead: a root-owned file passes only when it already carries the entry", async () => {
  const dir = await plantHostingTree();
  try {
    // setfacl is refused for it (not ours), but the default entry gave it one.
    await grantHostingCaddyRead(
      dir,
      fakeHost({ setfaclOk: false, acl: OK_ACL }).run,
    );
    const lacking = fakeHost({
      setfaclOk: false,
      acl: (p) => p.endsWith("a.caddy") ? "" : OK_ACL(p),
    });
    const err = await assertRejects(
      () => grantHostingCaddyRead(dir, lacking.run),
      Error,
      "cannot read its config",
    );
    assertStringIncludes(err.message, "a.caddy");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("grantHostingCaddyRead reports a mask that hides the entry (file chmod 0600)", async () => {
  const dir = await plantHostingTree();
  try {
    await assertRejects(
      () =>
        grantHostingCaddyRead(
          dir,
          fakeHost({
            acl: (p) =>
              p.endsWith("Caddyfile")
                ? "user:tpedge:r--\t#effective:---"
                : OK_ACL(p),
          }).run,
        ),
      Error,
      "Caddyfile",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function toolOk(command: string): Promise<boolean> {
  try {
    return (await new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false;
  }
}

async function acl(path: string): Promise<string> {
  const out = await new Deno.Command("getfacl", {
    args: ["-c", path],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(out.stdout);
}

// Linux only: files and a folder made BEFORE any default entry existed (the
// fresh install and the update the canary proof hit) get the entry, a file made
// afterwards inherits it, and a chmod 0600 is reported. The current user
// stands in for tpedge. CI (ubuntu has acl) must not skip this.
test({
  name:
    "grantHostingCaddyRead backfills and inherits with real setfacl (linux)",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    if (!(await toolOk("setfacl")) || !(await toolOk("getfacl"))) {
      if (Deno.env.get("CI")) throw new Error("setfacl/getfacl missing on CI");
      return;
    }
    const user = new TextDecoder().decode(
      (await new Deno.Command("id", { args: ["-un"], stdout: "piped" })
        .output()).stdout,
    ).trim();
    const dir = await plantHostingTree();
    try {
      await grantHostingCaddyRead(dir, undefined, user);
      const want = `user:${user}:r`;
      for (const f of ["Caddyfile", "sites/a.caddy", "sites"]) {
        assertStringIncludes(await acl(join(dir, f)), want);
      }
      assertStringIncludes(await acl(join(dir, "sites")), `default:${want}`);
      await Deno.writeTextFile(join(dir, "sites", "b.caddy"), "x", {
        mode: 0o640,
      });
      assertStringIncludes(await acl(join(dir, "sites", "b.caddy")), want);
      await Deno.chmod(join(dir, "Caddyfile"), 0o600);
      // A later chmod 0600 masks the entry away; the next grant restores it.
      await grantHostingCaddyRead(dir, undefined, user);
      assertStringIncludes(await acl(join(dir, "Caddyfile")), want);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
