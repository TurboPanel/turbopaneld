import { assertEquals } from "@std/assert";
import {
  buildRunReconcileArgs,
  CDN_RUN_SCRIPT,
  downloadRunScript,
  encodeLicenseArg,
  executeRunReconcile,
  PRODUCTION_CONTROL_PLANE,
  resolveBootstrapInsecureTls,
  resolveRunScriptUrl,
} from "./run-reconcile.ts";
import { join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("encodeLicenseArg uses base64url without padding", () => {
  const encoded = encodeLicenseArg("license-id", "token");
  assertEquals(encoded.includes(":"), false);
  assertEquals(encoded.includes("+"), false);
  assertEquals(encoded.includes("/"), false);
  assertEquals(encoded.includes("="), false);
});

test("resolveRunScriptUrl uses CDN for production control plane", () => {
  assertEquals(
    resolveRunScriptUrl({
      kind: "url",
      baseUrl: PRODUCTION_CONTROL_PLANE,
      wsBaseUrl: "wss://turbopanel.app",
    }),
    CDN_RUN_SCRIPT,
  );
});

test("resolveRunScriptUrl uses CDN for self-hosted HTTPS installs", () => {
  assertEquals(
    resolveRunScriptUrl({
      kind: "url",
      baseUrl: "https://huey.lan:8443",
      wsBaseUrl: "wss://huey.lan:8443",
    }),
    CDN_RUN_SCRIPT,
  );
});

test("resolveRunScriptUrl uses instance host for plaintext dev overlay", () => {
  assertEquals(
    resolveRunScriptUrl({
      kind: "url",
      baseUrl: "http://huey.lan:8880",
      wsBaseUrl: "ws://huey.lan:8880",
    }),
    "http://huey.lan:8880/run.sh",
  );
});

test("resolveRunScriptUrl uses instance /run.sh when overlay dlBase is set", () => {
  assertEquals(
    resolveRunScriptUrl({
      kind: "url",
      baseUrl: "https://turbopanel.dev",
      wsBaseUrl: "wss://turbopanel.dev",
    }, { dlBase: "https://turbopanel.dev/downloads/daemon" }),
    "https://turbopanel.dev/run.sh",
  );
});

test("buildRunReconcileArgs passes --dl-base for overlay catalogs", () => {
  assertEquals(
    buildRunReconcileArgs({
      licenseArg: "abc",
      instanceUrl: "https://turbopanel.dev",
      dlBase: "https://turbopanel.dev/downloads/daemon",
    }),
    [
      "--license",
      "abc",
      "--host",
      "https://turbopanel.dev",
      "--dl-base",
      "https://turbopanel.dev/downloads/daemon",
      "--no-start",
    ],
  );
});

test("buildRunReconcileArgs omits --host for production", () => {
  assertEquals(
    buildRunReconcileArgs({
      licenseArg: "abc",
      instanceUrl: PRODUCTION_CONTROL_PLANE,
    }),
    ["--license", "abc", "--no-start"],
  );
});

test("resolveBootstrapInsecureTls returns false for plaintext http even with releaseTlsInsecure", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      releaseTlsInsecure: "1",
      runScriptUrl: "http://localhost:8880",
    }),
    false,
  );
});

test("buildRunReconcileArgs omits TLS flags for plaintext http instance URL", () => {
  assertEquals(
    buildRunReconcileArgs({
      licenseArg: "abc",
      instanceUrl: "http://localhost:8880",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
      insecureTls: true,
    }),
    ["--license", "abc", "--host", "http://localhost:8880", "--no-start"],
  );
});

test("downloadRunScript uses plain -fsSL for plaintext http URL", async () => {
  const originalCommand = Deno.Command;
  let capturedArgs: string[] | undefined;
  try {
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedArgs = opts.args as string[];
      }

      output() {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new TextEncoder().encode("#!/bin/sh\necho ok"),
          stderr: new Uint8Array(),
        });
      }
    } as typeof Deno.Command;
    const script = await downloadRunScript("http://localhost:8880", {
      insecureTls: true,
      caPath: "/etc/turbopanel/instance-ca.pem",
    });
    assertEquals(capturedArgs, ["-fsSL", "http://localhost:8880"]);
    if (!script.trim()) {
      throw new Error("expected non-empty script");
    }
  } finally {
    Deno.Command = originalCommand;
  }
});

test("resolveBootstrapInsecureTls uses CDN without insecure flag", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      runScriptUrl: CDN_RUN_SCRIPT,
    }),
    false,
  );
});

test("resolveBootstrapInsecureTls enables insecure for self-hosted without CA", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      runScriptUrl: "https://huey.lan:8443",
    }),
    true,
  );
});

test("resolveBootstrapInsecureTls prefers platform CA for self-hosted", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      runScriptUrl: "https://huey.lan:8443",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
    }),
    false,
  );
});

test("buildRunReconcileArgs includes self-hosted flags", () => {
  assertEquals(
    buildRunReconcileArgs({
      licenseArg: "abc",
      instanceUrl: "https://huey.lan:8443",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
      insecureTls: true,
    }),
    [
      "--license",
      "abc",
      "--host",
      "https://huey.lan:8443",
      "--instance-ca",
      "/etc/turbopanel/instance-ca.pem",
      "--insecure-tls",
      "--no-start",
    ],
  );
});

test("buildRunReconcileArgs passes non-canonical instance CA path", () => {
  assertEquals(
    buildRunReconcileArgs({
      licenseArg: "abc",
      instanceUrl: "https://huey.lan:8443",
      instanceCaPath: "/tmp/platform-ca.pem",
      insecureTls: true,
    }),
    [
      "--license",
      "abc",
      "--host",
      "https://huey.lan:8443",
      "--instance-ca",
      "/tmp/platform-ca.pem",
      "--insecure-tls",
      "--no-start",
    ],
  );
});

test("buildRunReconcileArgs never emits a release-insecure token during insecure instance bootstrap", () => {
  const args = buildRunReconcileArgs({
    licenseArg: "abc",
    instanceUrl: "https://huey.lan:8443",
    insecureTls: true,
  });
  // Instance bootstrap relaxation is expressed only as --insecure-tls, which
  // run.sh scopes to the self-hosted instance legs (run.sh re-exec + CA fetch).
  assertEquals(args.includes("--insecure-tls"), true);
  // Release/CDN downloads must stay TLS-verified: no release-insecure flag or
  // override token may ever leak into the reconcile args.
  const joined = args.join(" ").toLowerCase();
  assertEquals(joined.includes("release"), false);
  assertEquals(joined.includes("override"), false);
});

test("executeRunReconcile keeps release downloads TLS-verified when instance bootstrap is insecure", async () => {
  const originalCommand = Deno.Command;
  let capturedEnv: Record<string, string> | undefined;
  let capturedArgs: string[] | undefined;
  try {
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedEnv = opts.env as Record<string, string> | undefined;
        capturedArgs = opts.args as string[];
      }

      spawn() {
        return {
          stdin: {
            getWriter() {
              return {
                write() {
                  return Promise.resolve();
                },
                close() {
                  return Promise.resolve();
                },
              };
            },
          },
          output() {
            return Promise.resolve({
              success: true,
              code: 0,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          },
        };
      }
    } as unknown as typeof Deno.Command;

    const args = buildRunReconcileArgs({
      licenseArg: "abc",
      // Self-hosted, self-signed, no CA on disk → insecure instance bootstrap.
      instanceUrl: "https://huey.lan:8443",
      insecureTls: true,
    });
    await executeRunReconcile({
      script: "#!/bin/sh\nexit 0",
      args,
    });

    // Instance bootstrap relaxation is passed as --insecure-tls only.
    assertEquals(capturedArgs?.includes("--insecure-tls"), true);
    // run.sh only relaxes release/CDN downloads via the undocumented
    // operator-only override; reconcile must never inject it, so release
    // manifest/artifact/Deno downloads stay TLS-verified.
    assertEquals(
      capturedEnv?.TURBOPANEL_RELEASE_TLS_INSECURE_OVERRIDE ?? undefined,
      undefined,
    );
    // The retired signal must not be forwarded either.
    assertEquals(
      capturedEnv?.TURBOPANEL_RELEASE_TLS_INSECURE ?? undefined,
      undefined,
    );
  } finally {
    Deno.Command = originalCommand;
  }
});

test("executeRunReconcile chdir survives daemon directory swap", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "tp-reconcile-" });
  const daemonDir = join(tmp, "daemon");
  await Deno.mkdir(daemonDir, { recursive: true });
  const originalCwd = Deno.cwd();
  const originalCommand = Deno.Command;
  let spawnCwd: string | undefined;
  let spawnEnv: Record<string, string> | undefined;
  try {
    Deno.chdir(daemonDir);

    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        spawnCwd = typeof opts.cwd === "string" ? opts.cwd : undefined;
        spawnEnv = opts.env as Record<string, string> | undefined;
      }

      spawn() {
        // Mimic run.sh replacing the checkout while reconcile cwd is elsewhere.
        Deno.renameSync(daemonDir, `${daemonDir}.old`);
        Deno.mkdirSync(daemonDir, { recursive: true });
        Deno.writeTextFileSync(join(daemonDir, "main.ts"), "x\n");
        Deno.removeSync(`${daemonDir}.old`, { recursive: true });
        return {
          stdin: {
            getWriter() {
              return {
                write() {
                  return Promise.resolve();
                },
                close() {
                  return Promise.resolve();
                },
              };
            },
          },
          output() {
            return Promise.resolve({
              success: true,
              code: 0,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          },
        };
      }
    } as unknown as typeof Deno.Command;

    await executeRunReconcile({
      script: "#!/bin/sh\nexit 0",
      args: [],
      channel: "trunk",
    });

    const cwdAfter = Deno.cwd();
    if (cwdAfter === daemonDir) {
      throw new Error(
        `expected cwd to move off deleted daemon dir, still ${cwdAfter}`,
      );
    }
    assertEquals(spawnCwd === daemonDir, false);
    assertEquals(spawnEnv?.TURBOPANEL_UPDATE_CHANNEL, "trunk");
  } finally {
    Deno.Command = originalCommand;
    Deno.chdir(originalCwd);
    await Deno.remove(tmp, { recursive: true }).catch((err) => {
      if (
        err instanceof Deno.errors.PermissionDenied ||
        err instanceof Deno.errors.NotFound
      ) {
        return;
      }
      console.warn(`cleanup ${tmp}:`, err);
    });
  }
});

test("executeRunReconcile reports sudo failure stderr", async () => {
  const originalCommand = Deno.Command;
  try {
    Deno.Command = class {
      constructor(_cmd: string, _opts: Deno.CommandOptions) {}
      spawn() {
        return {
          stdin: {
            getWriter() {
              return {
                write() {
                  return Promise.resolve();
                },
                close() {
                  return Promise.resolve();
                },
              };
            },
          },
          output() {
            return Promise.resolve({
              success: false,
              code: 1,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("reconcile blew up\n"),
            });
          },
        };
      }
    } as unknown as typeof Deno.Command;

    let message = "";
    try {
      await executeRunReconcile({ script: "#!/bin/sh\n", args: [] });
    } catch (err) {
      if (!(err instanceof Error)) {
        throw new TypeError("expected Error");
      }
      message = err.message;
    }
    assertEquals(message, "reconcile blew up");
  } finally {
    Deno.Command = originalCommand;
  }
});

test("resolveBootstrapInsecureTls honors releaseTlsInsecure for HTTPS", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      releaseTlsInsecure: "1",
      runScriptUrl: CDN_RUN_SCRIPT,
    }),
    true,
  );
  assertEquals(
    resolveBootstrapInsecureTls({
      releaseTlsInsecure: "1",
      runScriptUrl: "https://huey.lan:8443/run.sh",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
    }),
    true,
  );
});

test("downloadRunScript uses -k for insecure HTTPS", async () => {
  const originalCommand = Deno.Command;
  let capturedArgs: string[] | undefined;
  try {
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedArgs = opts.args as string[];
      }
      output() {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new TextEncoder().encode("#!/bin/sh\necho ok"),
          stderr: new Uint8Array(),
        });
      }
    } as typeof Deno.Command;
    await downloadRunScript("https://huey.lan:8443/run.sh", {
      insecureTls: true,
    });
    assertEquals(capturedArgs, ["-fsSL", "-k", "https://huey.lan:8443/run.sh"]);
  } finally {
    Deno.Command = originalCommand;
  }
});

test("downloadRunScript uses --cacert when platform CA is provided", async () => {
  const originalCommand = Deno.Command;
  let capturedArgs: string[] | undefined;
  try {
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedArgs = opts.args as string[];
      }
      output() {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new TextEncoder().encode("#!/bin/sh\necho ok"),
          stderr: new Uint8Array(),
        });
      }
    } as typeof Deno.Command;
    await downloadRunScript("https://huey.lan:8443/run.sh", {
      caPath: "/etc/turbopanel/instance-ca.pem",
    });
    assertEquals(capturedArgs, [
      "-fsSL",
      "--cacert",
      "/etc/turbopanel/instance-ca.pem",
      "https://huey.lan:8443/run.sh",
    ]);
  } finally {
    Deno.Command = originalCommand;
  }
});

test("downloadRunScript accepts legacy boolean insecureTls option", async () => {
  const originalCommand = Deno.Command;
  let capturedArgs: string[] | undefined;
  try {
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedArgs = opts.args as string[];
      }
      output() {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new TextEncoder().encode("#!/bin/sh\necho ok"),
          stderr: new Uint8Array(),
        });
      }
    } as typeof Deno.Command;
    await downloadRunScript("https://huey.lan:8443/run.sh", true);
    assertEquals(capturedArgs, ["-fsSL", "-k", "https://huey.lan:8443/run.sh"]);
  } finally {
    Deno.Command = originalCommand;
  }
});

test("downloadRunScript surfaces curl stderr on failure", async () => {
  const originalCommand = Deno.Command;
  try {
    Deno.Command = class {
      constructor(_cmd: string, _opts: Deno.CommandOptions) {}
      output() {
        return Promise.resolve({
          success: false,
          code: 22,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("curl: (22) HTTP 404\n"),
        });
      }
    } as typeof Deno.Command;
    let message = "";
    try {
      await downloadRunScript("https://huey.lan:8443/run.sh");
    } catch (err) {
      if (!(err instanceof Error)) {
        throw new TypeError("expected Error");
      }
      message = err.message;
    }
    assertEquals(message.includes("curl: (22)"), true);
  } finally {
    Deno.Command = originalCommand;
  }
});

test("downloadRunScript rejects empty script body", async () => {
  const originalCommand = Deno.Command;
  try {
    Deno.Command = class {
      constructor(_cmd: string, _opts: Deno.CommandOptions) {}
      output() {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new TextEncoder().encode("   \n"),
          stderr: new Uint8Array(),
        });
      }
    } as typeof Deno.Command;
    let message = "";
    try {
      await downloadRunScript("https://huey.lan:8443/run.sh");
    } catch (err) {
      if (!(err instanceof Error)) {
        throw new TypeError("expected Error");
      }
      message = err.message;
    }
    assertEquals(message.includes("empty run script"), true);
  } finally {
    Deno.Command = originalCommand;
  }
});

test("executeRunReconcile preserves trimmed TURBOPANEL_DL_BASE", async () => {
  const originalCommand = Deno.Command;
  const originalDlBase = Deno.env.get("TURBOPANEL_DL_BASE");
  let capturedEnv: Record<string, string> | undefined;
  try {
    Deno.env.set(
      "TURBOPANEL_DL_BASE",
      "  https://overlay.example/downloads/daemon  ",
    );
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedEnv = opts.env as Record<string, string> | undefined;
      }
      spawn() {
        return {
          stdin: {
            getWriter() {
              return {
                write() {
                  return Promise.resolve();
                },
                close() {
                  return Promise.resolve();
                },
              };
            },
          },
          output() {
            return Promise.resolve({
              success: true,
              code: 0,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          },
        };
      }
    } as unknown as typeof Deno.Command;

    await executeRunReconcile({
      script: "#!/bin/sh\nexit 0",
      args: [],
    });
    assertEquals(
      capturedEnv?.TURBOPANEL_DL_BASE,
      "https://overlay.example/downloads/daemon",
    );
  } finally {
    Deno.Command = originalCommand;
    if (originalDlBase === undefined) Deno.env.delete("TURBOPANEL_DL_BASE");
    else Deno.env.set("TURBOPANEL_DL_BASE", originalDlBase);
  }
});

test("executeRunReconcile falls back cwd when primary chdir fails", async () => {
  const originalCommand = Deno.Command;
  const originalChdir = Deno.chdir;
  const originalStatSync = Deno.statSync;
  const chdirTargets: string[] = [];
  try {
    Deno.statSync = ((path: string | URL) => {
      if (String(path) === "/opt/turbopanel") {
        return { isDirectory: true } as Deno.FileInfo;
      }
      return originalStatSync.call(Deno, path);
    }) as typeof Deno.statSync;
    Deno.chdir = ((path: string | URL) => {
      const target = String(path);
      chdirTargets.push(target);
      if (target === "/opt/turbopanel") {
        throw new Deno.errors.PermissionDenied("mocked chdir");
      }
      // Host-free: do not mutate the real process cwd.
    }) as typeof Deno.chdir;

    Deno.Command = class {
      constructor(_cmd: string, _opts: Deno.CommandOptions) {}
      spawn() {
        return {
          stdin: {
            getWriter() {
              return {
                write() {
                  return Promise.resolve();
                },
                close() {
                  return Promise.resolve();
                },
              };
            },
          },
          output() {
            return Promise.resolve({
              success: true,
              code: 0,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          },
        };
      }
    } as unknown as typeof Deno.Command;

    await executeRunReconcile({
      script: "#!/bin/sh\nexit 0",
      args: [],
    });
    assertEquals(chdirTargets.includes("/opt/turbopanel"), true);
    assertEquals(chdirTargets.includes("/"), true);
  } finally {
    Deno.Command = originalCommand;
    Deno.chdir = originalChdir;
    Deno.statSync = originalStatSync;
  }
});
