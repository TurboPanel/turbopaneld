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
  try {
    Deno.chdir(daemonDir);

    const swapScript = [
      "#!/bin/sh",
      `mkdir -p "${tmp}/staging"`,
      `echo x > "${tmp}/staging/main.ts"`,
      `mv "${daemonDir}" "${daemonDir}.old"`,
      `mv "${tmp}/staging" "${daemonDir}"`,
      `rm -rf "${daemonDir}.old"`,
      "exit 0",
    ].join("\n");

    await executeRunReconcile({ script: swapScript, args: [] });

    const cwdAfter = Deno.cwd();
    if (cwdAfter === daemonDir) {
      throw new Error(
        `expected cwd to move off deleted daemon dir, still ${cwdAfter}`,
      );
    }
  } finally {
    Deno.chdir(originalCwd);
    // Directory swap can leave an unremovable tree; never hang on sudo.
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
