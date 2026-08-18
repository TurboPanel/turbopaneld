import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  ensureHostingCaddy,
  HOSTING_CADDY_VERSION,
  type EnsureHostingCaddyDeps,
} from "./ensure-hosting-caddy.ts";

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
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const binPath = await plantVendorCaddy(layout.runtimesDir);

      let setupCalls = 0;
      const resolved = await ensureHostingCaddy(layout, {
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
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      let setupCalls = 0;
      const resolved = await ensureHostingCaddy(layout, {
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
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const commands: string[] = [];
      const resolved = await ensureHostingCaddy(layout, {
        runCaddySetup: () => Promise.reject(new Error("playbook missing")),
        resolveArch: () => "amd64",
        runCommand: (command, args, opts) => {
          commands.push(command);
          return mockDownloadCommands({ chownOk: false })(command, args, opts);
        },
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
  permissions: { read: true, write: true },
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
        runCaddySetup: () => Promise.resolve(),
        resolveArch: () => "arm64",
        runCommand: mockDownloadCommands({
          chownOk: true,
          chownStderr: "",
        }),
      });
      assertEquals(await Deno.readTextFile(resolved), "#!/bin/caddy-mock\n");
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces curl failure",
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
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({
              curlOk: false,
              curlStderr: "connection refused",
            }),
          }),
        Error,
        "curl failed: connection refused",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces curl failure with empty stderr",
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
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({ curlOk: false, curlStderr: "" }),
          }),
        Error,
        "curl failed: download error",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces tar failure",
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
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({
              tarOk: false,
              tarStderr: "not a gzip",
            }),
          }),
        Error,
        "tar failed: not a gzip",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy surfaces tar failure with empty stderr",
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
            runCaddySetup: () => Promise.resolve(),
            resolveArch: () => "amd64",
            runCommand: mockDownloadCommands({ tarOk: false, tarStderr: "" }),
          }),
        Error,
        "tar failed: extract error",
      );
    });
  },
});

test({
  name: "ensureHostingCaddy throws when download leaves binary missing",
  permissions: { read: true, write: true },
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
          throw new TypeError(`unexpected command: ${this.#command}`);
        }
      };

      try {
        // No resolveArch / runCommand inject — exercises defaults.
        const resolved = await ensureHostingCaddy(layout, {
          runCaddySetup: () => Promise.resolve(),
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
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const resolved = await ensureHostingCaddy(layout, {
        runCaddySetup: () => Promise.reject("setup blew up"),
        resolveArch: () => "amd64",
        runCommand: mockDownloadCommands({
          chownOk: false,
          chownStderr: "sudo: a password is required",
        }),
      });
      assertEquals(await Deno.readTextFile(resolved), "#!/bin/caddy-mock\n");
    });
  },
});

test({
  name: "ensureHostingCaddy rejects unsupported architecture",
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
