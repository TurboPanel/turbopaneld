import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertControlPlaneBackupPreflight,
  assertControlPlaneManifestPreflight,
  assertControlPlaneUpdateAllowed,
  assertUpdateDiskPreflight,
  buildRunReconcileArgs,
  CDN_RUN_SCRIPT,
  ControlPlaneUpdateFailedError,
  downloadRunScript,
  encodeLicenseArg,
  ensureWebServerRunning,
  executeInstanceUpdateReconcile,
  executeRunReconcile,
  type InstanceUpdateHooks,
  InstanceUpdateRefusedError,
  MIN_INSTANCE_UPDATE_FREE_BACKUP_BYTES,
  MIN_INSTANCE_UPDATE_FREE_INSTALL_BYTES,
  PRODUCTION_CONTROL_PLANE,
  reconcileHelperInvocation,
  reconcileNeedsRootHelper,
  resolveAutomaticUpdateTrust,
  resolveBootstrapInsecureTls,
  resolveRunScriptUrl,
  restartControlPlaneUnits,
  rootHelperColocatedRefreshInvocation,
  rootHelperInstanceUpdateInvocation,
  rootHelperReconcileInvocation,
  rootHelperReconcileStdin,
  scriptWithLicense,
  spawnRootHelper,
  UpdatePreflightError,
  UpdateTrustRepairError,
} from "./run-reconcile.ts";
import { parseTurbopanelStageLine } from "./update-progress-reporter.ts";
import { join } from "@std/path";
import {
  signWithTestKey,
  TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
} from "../testing/release-signing-fixture.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function readableText(
  text: string,
  chunks?: string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = chunks ?? (text ? [text] : []);
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

function fakeReconcileChild(options: {
  stdout?: string;
  stdoutChunks?: string[];
  stderr?: string;
  code?: number;
} = {}) {
  const code = options.code ?? 0;
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
    stdout: readableText(options.stdout ?? "", options.stdoutChunks),
    stderr: readableText(options.stderr ?? ""),
    status: Promise.resolve({ code, success: code === 0 }),
  };
}

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
      instanceUrl: "https://turbopanel.dev",
      dlBase: "https://turbopanel.dev/downloads/daemon",
    }),
    [
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
      instanceUrl: PRODUCTION_CONTROL_PLANE,
    }),
    ["--no-start"],
  );
});

test("resolveBootstrapInsecureTls follows releaseTlsInsecure for an https origin", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      releaseTlsInsecure: "1",
      runScriptUrl: "https://huey.lan:8443/run.sh",
    }),
    true,
  );
});

test("buildRunReconcileArgs includes TLS flags for an https instance URL", () => {
  assertEquals(
    buildRunReconcileArgs({
      instanceUrl: "https://huey.lan:8443",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
      insecureTls: true,
    }),
    [
      "--host",
      "https://huey.lan:8443",
      "--instance-ca",
      "/etc/turbopanel/instance-ca.pem",
      "--insecure-tls",
      "--no-start",
    ],
  );
});

const RETRY_ARGS = [
  "--retry",
  "2",
  "--retry-delay",
  "3",
  "--retry-max-time",
  "60",
];

test("downloadRunScript applies insecure TLS flags", async () => {
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
    const script = await downloadRunScript("https://huey.lan:8443/run.sh", {
      insecureTls: true,
      caPath: "/etc/turbopanel/instance-ca.pem",
    });
    assertEquals(capturedArgs, [
      "-fsSL",
      "-k",
      ...RETRY_ARGS,
      "https://huey.lan:8443/run.sh",
    ]);
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
      instanceUrl: "https://huey.lan:8443",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
      insecureTls: true,
    }),
    [
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
      instanceUrl: "https://huey.lan:8443",
      instanceCaPath: "/tmp/platform-ca.pem",
      insecureTls: true,
    }),
    [
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
        return fakeReconcileChild();
      }
    } as unknown as typeof Deno.Command;

    const args = buildRunReconcileArgs({
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
        return fakeReconcileChild();
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
        return fakeReconcileChild({ code: 1, stderr: "reconcile blew up\n" });
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
    assertEquals(capturedArgs, [
      "-fsSL",
      "-k",
      ...RETRY_ARGS,
      "https://huey.lan:8443/run.sh",
    ]);
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
      ...RETRY_ARGS,
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
    assertEquals(capturedArgs, [
      "-fsSL",
      "-k",
      ...RETRY_ARGS,
      "https://huey.lan:8443/run.sh",
    ]);
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
        return fakeReconcileChild();
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

const PINNED_OLD_BUILD =
  "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-0.1.1-canary.20260927-192410-1ade037.json";
const TARGET_BUILD =
  "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-0.1.1-canary.20260927-193059-fc561fc.json";
const TAG_PIN =
  "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.1/manifest.json";
const CANARY_POINTER =
  "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest.json";

async function reconcileManifestEnv(
  hostPin: string | undefined,
  manifestUrl: string | undefined,
): Promise<string | undefined> {
  const originalCommand = Deno.Command;
  const originalPin = Deno.env.get("TURBOPANEL_MANIFEST_URL");
  const originalDlBase = Deno.env.get("TURBOPANEL_DL_BASE");
  let capturedEnv: Record<string, string> | undefined;
  try {
    Deno.env.delete("TURBOPANEL_DL_BASE");
    if (hostPin === undefined) Deno.env.delete("TURBOPANEL_MANIFEST_URL");
    else Deno.env.set("TURBOPANEL_MANIFEST_URL", hostPin);
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedEnv = opts.env as Record<string, string> | undefined;
      }
      spawn() {
        return fakeReconcileChild();
      }
    } as unknown as typeof Deno.Command;

    await executeRunReconcile({
      script: "#!/bin/sh\nexit 0",
      args: [],
      manifestUrl,
    });
    return capturedEnv?.TURBOPANEL_MANIFEST_URL;
  } finally {
    Deno.Command = originalCommand;
    if (originalPin === undefined) Deno.env.delete("TURBOPANEL_MANIFEST_URL");
    else Deno.env.set("TURBOPANEL_MANIFEST_URL", originalPin);
    if (originalDlBase === undefined) Deno.env.delete("TURBOPANEL_DL_BASE");
    else Deno.env.set("TURBOPANEL_DL_BASE", originalDlBase);
  }
}

test("executeRunReconcile installs the targeted build over the last build run.sh persisted", async () => {
  assertEquals(
    await reconcileManifestEnv(PINNED_OLD_BUILD, TARGET_BUILD),
    TARGET_BUILD,
  );
});

test("executeRunReconcile keeps a host pin when the message only names the channel", async () => {
  assertEquals(await reconcileManifestEnv(TAG_PIN, CANARY_POINTER), TAG_PIN);
  assertEquals(await reconcileManifestEnv(TAG_PIN, undefined), TAG_PIN);
});

test("executeRunReconcile uses the message URL when the host has no pin", async () => {
  assertEquals(
    await reconcileManifestEnv(undefined, CANARY_POINTER),
    CANARY_POINTER,
  );
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
        return fakeReconcileChild();
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

// --- automatic update trust ------------------------------------------------

const needsInsecure = (origin: string) => origin.includes(".lan");

test("resolveAutomaticUpdateTrust refuses plaintext http", () => {
  assertThrows(
    () =>
      resolveAutomaticUpdateTrust({
        runScriptUrl: "http://192.168.1.10/run.sh",
        originNeedsInsecureTls: needsInsecure,
      }),
    UpdateTrustRepairError,
    "plaintext HTTP",
  );
});

test("resolveAutomaticUpdateTrust: the CDN and public origins use system trust", () => {
  assertEquals(
    resolveAutomaticUpdateTrust({
      runScriptUrl: CDN_RUN_SCRIPT,
      originNeedsInsecureTls: () => true,
    }),
    { kind: "public-tls" },
  );
  assertEquals(
    resolveAutomaticUpdateTrust({
      runScriptUrl: "https://panel.example.com/run.sh",
      originNeedsInsecureTls: needsInsecure,
    }),
    { kind: "public-tls" },
  );
});

test("resolveAutomaticUpdateTrust: a private origin needs the Platform CA on disk", () => {
  assertEquals(
    resolveAutomaticUpdateTrust({
      runScriptUrl: "https://huey.lan:8443/run.sh",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
      originNeedsInsecureTls: needsInsecure,
      caFileExists: () => true,
    }),
    { kind: "platform-ca", caPath: "/etc/turbopanel/instance-ca.pem" },
  );
});

test("resolveAutomaticUpdateTrust: a private upload uses its issuer file, not the Platform CA path", () => {
  assertEquals(
    resolveAutomaticUpdateTrust({
      runScriptUrl: "https://private.example.com:8443/run.sh",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
      uploadedTrustPath: "/etc/turbopanel/instance-uploaded-trust.pem",
      originNeedsInsecureTls: () => true,
      caFileExists: (path) => path.endsWith("instance-uploaded-trust.pem"),
    }),
    {
      kind: "uploaded-trust",
      caPath: "/etc/turbopanel/instance-uploaded-trust.pem",
    },
  );
  assertEquals(
    resolveAutomaticUpdateTrust({
      runScriptUrl: "https://private.example.com:8443/run.sh",
      instanceCaPath: "/etc/turbopanel/instance-ca.pem",
      uploadedTrustPath: "/etc/turbopanel/instance-uploaded-trust.pem",
      originNeedsInsecureTls: () => true,
      caFileExists: () => true,
    }).kind,
    "platform-ca",
  );
});

test("resolveAutomaticUpdateTrust: no CA is a trust-repair error, never curl -k", () => {
  assertThrows(
    () =>
      resolveAutomaticUpdateTrust({
        runScriptUrl: "https://huey.lan:8443/run.sh",
        originNeedsInsecureTls: needsInsecure,
      }),
    UpdateTrustRepairError,
    "--instance-ca",
  );
  assertThrows(
    () =>
      resolveAutomaticUpdateTrust({
        runScriptUrl: "https://huey.lan:8443/run.sh",
        instanceCaPath: "/etc/turbopanel/instance-ca.pem",
        originNeedsInsecureTls: needsInsecure,
        caFileExists: () => false,
      }),
    UpdateTrustRepairError,
    "instance-ca.pem is missing",
  );
});

test("the automatic update path never consults TURBOPANEL_RELEASE_TLS_INSECURE or passes insecureTls", async () => {
  const client = await Deno.readTextFile(
    new URL("./client.ts", import.meta.url),
  );
  const start = client.indexOf("async #reconcileToLatestUpdate(");
  const end = client.indexOf("#sendUpdateResult(", start);
  if (start < 0 || end < 0) {
    throw new TypeError("client.ts lost #reconcileToLatestUpdate");
  }
  const body = client.slice(start, end);
  assertEquals(body.includes("TURBOPANEL_RELEASE_TLS_INSECURE"), false);
  assertEquals(body.includes("resolveBootstrapInsecureTls"), false);
  assertEquals(body.includes("insecureTls: true"), false);
  assertEquals(body.includes("insecureTls: false"), true);
  assertEquals(body.includes("resolveAutomaticUpdateTrust("), true);
  assertEquals(body.includes("uploadedTrustPath"), true);
  assertEquals(body.includes('trust.kind === "platform-ca"'), true);
  assertEquals(body.includes('trust.kind === "public-tls"'), true);
});

// --- managed-host reconcile through the root helper -----------------------

test("rootHelperReconcileInvocation hands validated flags to sudo -n tp-orchestrate update", () => {
  const args = [
    "--host",
    "https://p.example",
    "--no-start",
  ];
  const invocation = rootHelperReconcileInvocation(args, {
    channel: "release",
    manifestUrl:
      "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json",
  });
  assertEquals(invocation.bin, "sudo");
  assertEquals(invocation.args.slice(0, 2), ["-n", "--"]);
  assertEquals(invocation.args[2]?.endsWith("/scripts/tp-orchestrate"), true);
  assertEquals(invocation.args[3], "update");
  assertEquals(invocation.args.slice(4), [
    "--license-stdin",
    ...args,
    "--channel",
    "release",
    "--manifest-url",
    "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json",
    "--progress-markers",
  ]);
  // Never a shell, never a script body, never --insecure-tls.
  assertEquals(invocation.args.includes("sh"), false);
  assertEquals(invocation.args.includes("--insecure-tls"), false);
});

test("reconcileNeedsRootHelper follows the orchestration privilege rule", () => {
  assertEquals(
    reconcileNeedsRootHelper({ installMode: "production", uid: 9999 }),
    true,
  );
  assertEquals(
    reconcileNeedsRootHelper({ installMode: "development", uid: 1000 }),
    false,
  );
});

test("assertControlPlaneUpdateAllowed refuses only a downgrade below the daemon floor", () => {
  assertThrows(
    () => assertControlPlaneUpdateAllowed("0.0.1"),
    InstanceUpdateRefusedError,
    "below this daemon's supported minimum 0.1.0",
  );
  assertControlPlaneUpdateAllowed("0.1.0");
  assertControlPlaneUpdateAllowed("0.1.1");
  assertControlPlaneUpdateAllowed(undefined);
  assertControlPlaneUpdateAllowed(null);
  assertControlPlaneUpdateAllowed("not-a-version");
});

test("rootHelperInstanceUpdateInvocation is update-instance without enrolment flags", () => {
  const invocation = rootHelperInstanceUpdateInvocation({
    channel: "release",
    manifestUrl:
      "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
  });
  assertEquals(invocation.bin, "sudo");
  assertEquals(invocation.args.slice(0, 2), ["-n", "--"]);
  assertEquals(invocation.args[2]?.endsWith("/scripts/tp-orchestrate"), true);
  assertEquals(invocation.args[3], "update-instance");
  assertEquals(invocation.args.slice(4), [
    "--channel",
    "release",
    "--manifest-url",
    "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
    "--no-start",
  ]);
  assertEquals(invocation.args.includes("--license"), false);
  assertEquals(invocation.args.includes("--instance-ca"), false);
  assertEquals(invocation.args.includes("--insecure-tls"), false);

  const uiUrl =
    "https://github.com/TurboPanel/ui/releases/download/v0.1.1/manifest.json";
  const withUi = rootHelperInstanceUpdateInvocation({
    channel: "release",
    manifestUrl:
      "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
    uiManifestUrl: uiUrl,
  });
  assertEquals(withUi.args.slice(4), [
    "--channel",
    "release",
    "--manifest-url",
    "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
    "--ui-manifest-url",
    uiUrl,
    "--no-start",
  ]);
});

test("executeInstanceUpdateReconcile refuses a downgrade before it touches the helper", async () => {
  await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        targetVersion: "0.0.1",
      }),
    InstanceUpdateRefusedError,
    "below this daemon's supported minimum",
  );
});

test("executeInstanceUpdateReconcile refuses a development checkout", async () => {
  if (reconcileNeedsRootHelper()) return;
  await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        targetVersion: "0.1.1",
      }),
    InstanceUpdateRefusedError,
    "development host",
  );
});

test("assertUpdateDiskPreflight maps low free space to preflight_disk", async () => {
  await assertRejects(
    () =>
      assertUpdateDiskPreflight({
        statfsProbe: () => Promise.resolve({ bavail: 1, bsize: 4096 }),
      }),
    UpdatePreflightError,
    "preflight_disk",
  );
});

test("parseTurbopanelStageLine accepts marker lines", () => {
  assertEquals(
    parseTurbopanelStageLine("::turbopanel-stage::downloading"),
    "downloading",
  );
  assertEquals(
    parseTurbopanelStageLine("noise ::turbopanel-stage::installing"),
    null,
  );
  assertEquals(parseTurbopanelStageLine("not a marker"), null);
});

test("executeRunReconcile forwards split-chunk stage markers", async () => {
  const originalCommand = Deno.Command;
  const stages: string[] = [];
  try {
    Deno.Command = class {
      constructor(_cmd: string, _opts: Deno.CommandOptions) {}
      spawn() {
        return fakeReconcileChild({
          stdoutChunks: ["::turbo", "panel-stage::installing\n"],
        });
      }
    } as unknown as typeof Deno.Command;
    await executeRunReconcile({
      script: "#!/bin/sh\n",
      args: [],
      onStage: (stage) => {
        stages.push(stage);
      },
    });
    assertEquals(stages, ["installing"]);
  } finally {
    Deno.Command = originalCommand;
  }
});

test("executeRunReconcile surfaces stdout when stderr is empty on failure", async () => {
  const originalCommand = Deno.Command;
  try {
    Deno.Command = class {
      constructor(_cmd: string, _opts: Deno.CommandOptions) {}
      spawn() {
        return fakeReconcileChild({
          code: 2,
          stdout: "installer exploded\n",
        });
      }
    } as unknown as typeof Deno.Command;
    await assertRejects(
      () => executeRunReconcile({ script: "#!/bin/sh\n", args: [] }),
      Error,
      "installer exploded",
    );
  } finally {
    Deno.Command = originalCommand;
  }
});

test("assertUpdateDiskPreflight rejects an unreadable filesystem", async () => {
  await assertRejects(
    () =>
      assertUpdateDiskPreflight({
        installRoot: "/tmp",
        stateDir: "/tmp",
        tmpDir: "/tmp",
        statfsProbe: () => Promise.resolve(null),
      }),
    UpdatePreflightError,
    "preflight_disk",
  );
});

test("assertUpdateDiskPreflight rejects a failed statfs probe", async () => {
  await assertRejects(
    () =>
      assertUpdateDiskPreflight({
        installRoot: "/tmp",
        stateDir: "/tmp",
        tmpDir: "/tmp",
        statfsProbe: () => Promise.reject(new Error("EACCES")),
      }),
    UpdatePreflightError,
    "preflight_disk",
  );
});

test("assertUpdateDiskPreflight rejects an invalid statfs result", async () => {
  await assertRejects(
    () =>
      assertUpdateDiskPreflight({
        installRoot: "/tmp",
        stateDir: "/tmp",
        tmpDir: "/tmp",
        statfsProbe: () => Promise.resolve({ bavail: 10, bsize: 0 }),
      }),
    UpdatePreflightError,
    "preflight_disk",
  );
});

test("assertUpdateDiskPreflight probes install root, state, tmp in order and stops at the first low one", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-disk-order-" });
  try {
    const install = join(root, "install");
    const state = join(root, "state");
    const tmp = join(root, "tmp");
    const probed: string[] = [];
    const plenty = { bavail: Number.MAX_SAFE_INTEGER, bsize: 1 };
    const run = (lowAt: string | null) =>
      assertUpdateDiskPreflight({
        installRoot: install,
        stateDir: state,
        tmpDir: tmp,
        statfsProbe: (path) => {
          probed.push(path);
          return Promise.resolve(
            path === lowAt ? { bavail: 1, bsize: 1 } : plenty,
          );
        },
      });
    await run(null);
    assertEquals(probed, [install, state, tmp]);

    probed.length = 0;
    const err = await assertRejects(() => run(state), UpdatePreflightError);
    assertEquals(probed, [install, state]);
    assertStringIncludes(err.message, `insufficient free space on state`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("assertUpdateDiskPreflight probes a missing directory via create-or-parent", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-disk-missing-" });
  const missing = join(root, "state", "nested");
  try {
    await assertUpdateDiskPreflight({
      installRoot: root,
      stateDir: missing,
      tmpDir: root,
      statfsProbe: () => Promise.resolve({ bavail: 1024 * 1024, bsize: 4096 }),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const PLENTY_STATFS = () =>
  Promise.resolve({ bavail: 1024 * 1024, bsize: 4096 });

const INSTANCE_MANIFEST = {
  commit: "newcommit",
  version: "0.1.1",
  channel: "release",
};
const UI_MANIFEST = {
  commit: "uicommit",
  version: "0.1.1",
  channel: "release",
};
const SIGNED_INSTANCE_MANIFEST_BODY = JSON.stringify(
  await signWithTestKey(INSTANCE_MANIFEST),
);
const SIGNED_UI_MANIFEST_BODY = JSON.stringify(
  await signWithTestKey(UI_MANIFEST),
);

function instanceManifestBody(): string {
  return SIGNED_INSTANCE_MANIFEST_BODY;
}

function managedUpdateHooks(
  calls: Array<{ bin: string; args: string[] }>,
  overrides: Partial<InstanceUpdateHooks> = {},
): InstanceUpdateHooks {
  let clock = 0;
  return {
    forceManaged: true,
    manifestPublicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
    statfsProbe: PLENTY_STATFS,
    fetchText: () =>
      Promise.resolve({ ok: true, status: 200, body: instanceManifestBody() }),
    readCaddyfile: () => Promise.resolve("handle_errors\nupdating.html\n"),
    restartUnits: () => Promise.resolve(true),
    ensureWebServer: () => Promise.resolve(true),
    migrate: () =>
      Promise.resolve({
        code: 0,
        stdout: "migrations applied successfully\n",
        stderr: "",
      }),
    unitActive: () => Promise.resolve(true),
    readHealth: () =>
      Promise.resolve({ version: "0.1.1", commit: "newcommit" }),
    now: () => clock,
    sleep: () => {
      clock += 5 * 60 * 1000;
      return Promise.resolve();
    },
    run: (bin, args, onStage) => {
      calls.push({ bin, args });
      if (args[0] === "inspect") {
        return Promise.resolve({
          code: 0,
          stdout: "true healthy\n",
          stderr: "",
        });
      }
      if (args.includes("update-instance")) {
        onStage?.("downloading");
        onStage?.("installing");
        onStage?.("restarting");
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    ...overrides,
  };
}

test("assertUpdateDiskPreflight sizes a control-plane update for install and backup", async () => {
  await assertRejects(
    () =>
      assertUpdateDiskPreflight({
        installRoot: "/tmp",
        backupDir: "/tmp",
        statfsProbe: () => Promise.resolve({ bavail: 1, bsize: 4096 }),
      }),
    UpdatePreflightError,
    "preflight_disk",
  );
  assertEquals(
    MIN_INSTANCE_UPDATE_FREE_INSTALL_BYTES > 512 * 1024 * 1024,
    true,
  );
  assertEquals(MIN_INSTANCE_UPDATE_FREE_BACKUP_BYTES > 0, true);
});

test("assertControlPlaneBackupPreflight refuses a stopped database container", async () => {
  await assertRejects(
    () =>
      assertControlPlaneBackupPreflight(() =>
        Promise.resolve({ code: 0, stdout: "false exited\n", stderr: "" })
      ),
    UpdatePreflightError,
    "preflight_backup",
  );
  await assertRejects(
    () =>
      assertControlPlaneBackupPreflight(() =>
        Promise.resolve({ code: 1, stdout: "", stderr: "no such container" })
      ),
    UpdatePreflightError,
    "not present",
  );
});

/** Serve `bodies[url]` (by manifest kind) to the preflight fetch. */
function serveManifests(instance: string, ui?: string) {
  return (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: url.includes("/TurboPanel/ui/") ? (ui ?? "") : instance,
    });
}

const UI_PIN =
  "https://github.com/TurboPanel/ui/releases/download/v0.1.1/manifest.json";

test("assertControlPlaneManifestPreflight refuses an unsigned instance manifest", async () => {
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        installMode: "production",
        publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        fetchText: serveManifests(JSON.stringify(INSTANCE_MANIFEST)),
      }),
    UpdatePreflightError,
    "instance manifest is unsigned",
  );
});

test("assertControlPlaneManifestPreflight refuses an unsigned UI manifest", async () => {
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        uiManifestUrl: UI_PIN,
        installMode: "production",
        publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        fetchText: serveManifests(
          SIGNED_INSTANCE_MANIFEST_BODY,
          JSON.stringify(UI_MANIFEST),
        ),
      }),
    UpdatePreflightError,
    "ui manifest is unsigned",
  );
});

test("assertControlPlaneManifestPreflight refuses a tampered manifest", async () => {
  const tampered = JSON.stringify({
    ...JSON.parse(SIGNED_INSTANCE_MANIFEST_BODY),
    commit: "evilcommit",
  });
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        installMode: "production",
        publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        fetchText: serveManifests(tampered),
      }),
    UpdatePreflightError,
    "invalid",
  );
});

/** A fetchText that answers `statuses` in turn (the last one repeats) and counts calls. */
function flakyManifests(statuses: number[], okBody: string) {
  const calls = { n: 0 };
  const fetchText = (_url: string) => {
    const status = statuses[Math.min(calls.n, statuses.length - 1)];
    calls.n += 1;
    return Promise.resolve({
      ok: status === 200,
      status,
      body: status === 200 ? okBody : "",
    });
  };
  return { calls, fetchText };
}

const noWait = { sleep: () => Promise.resolve() };

test("assertControlPlaneManifestPreflight retries a 503 and then verifies", async () => {
  const flaky = flakyManifests([503, 200], SIGNED_INSTANCE_MANIFEST_BODY);
  const verified = await assertControlPlaneManifestPreflight({
    channel: "release",
    installMode: "production",
    publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
    fetchText: flaky.fetchText,
    retry: noWait,
  });
  assertEquals(verified.commit, "newcommit");
  assertEquals(flaky.calls.n, 2);
});

test("assertControlPlaneManifestPreflight gives up after four 504s with the original text", async () => {
  const flaky = flakyManifests([504], "");
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        installMode: "production",
        publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        fetchText: flaky.fetchText,
        retry: noWait,
      }),
    UpdatePreflightError,
    "failed to fetch instance manifest: HTTP 504",
  );
  assertEquals(flaky.calls.n, 4);
});

test("assertControlPlaneManifestPreflight does not retry a 404", async () => {
  const flaky = flakyManifests([404, 200], SIGNED_INSTANCE_MANIFEST_BODY);
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        installMode: "production",
        publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        fetchText: flaky.fetchText,
        retry: noWait,
      }),
    UpdatePreflightError,
    "HTTP 404",
  );
  assertEquals(flaky.calls.n, 1);
});

test("assertControlPlaneManifestPreflight does not retry a bad signature", async () => {
  const tampered = JSON.stringify({
    ...JSON.parse(SIGNED_INSTANCE_MANIFEST_BODY),
    commit: "evilcommit",
  });
  const flaky = flakyManifests([200], tampered);
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        installMode: "production",
        publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
        fetchText: flaky.fetchText,
        retry: noWait,
      }),
    UpdatePreflightError,
    "invalid",
  );
  assertEquals(flaky.calls.n, 1);
});

test("assertControlPlaneManifestPreflight accepts signed instance and UI manifests", async () => {
  const verified = await assertControlPlaneManifestPreflight({
    channel: "release",
    uiManifestUrl: UI_PIN,
    installMode: "production",
    publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
    fetchText: serveManifests(
      SIGNED_INSTANCE_MANIFEST_BODY,
      SIGNED_UI_MANIFEST_BODY,
    ),
  });
  assertEquals(verified.commit, "newcommit");
});

test("assertControlPlaneManifestPreflight never skips the signature for a pinned instance or UI manifest", async () => {
  const unsigned = serveManifests(JSON.stringify(INSTANCE_MANIFEST));
  const instancePin =
    "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json";
  const overlayEnv = {
    TURBOPANEL_DL_BASE: "https://dev.example.lan:8443",
    TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST: "1",
  };
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        manifestUrl: instancePin,
        installMode: "development",
        fetchText: unsigned,
      }),
    UpdatePreflightError,
    "unsigned",
  );
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        manifestUrl: instancePin,
        installMode: "production",
        env: overlayEnv,
        fetchText: unsigned,
      }),
    UpdatePreflightError,
    "unsigned",
  );
  // The channel's instance manifest may take the bypass; the UI pin may not.
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        uiManifestUrl: UI_PIN,
        installMode: "production",
        env: overlayEnv,
        fetchText: serveManifests(
          JSON.stringify(INSTANCE_MANIFEST),
          JSON.stringify(UI_MANIFEST),
        ),
      }),
    UpdatePreflightError,
    "ui manifest is unsigned",
  );
  // A release-signed pin still verifies on such a host.
  const pinned = await assertControlPlaneManifestPreflight({
    channel: "release",
    manifestUrl: instancePin,
    installMode: "development",
    publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
    fetchText: serveManifests(SIGNED_INSTANCE_MANIFEST_BODY),
  });
  assertEquals(pinned.commit, "newcommit");
});

test("assertControlPlaneManifestPreflight skips signatures only under the development bypass", async () => {
  const unsigned = serveManifests(JSON.stringify(INSTANCE_MANIFEST));
  // Source checkout: the one unconditional bypass.
  const dev = await assertControlPlaneManifestPreflight({
    channel: "release",
    installMode: "development",
    fetchText: unsigned,
  });
  assertEquals(dev.commit, "newcommit");
  // Overlay host that opted in: bypassed.
  const overlay = await assertControlPlaneManifestPreflight({
    channel: "release",
    installMode: "production",
    env: {
      TURBOPANEL_DL_BASE: "https://dev.example.lan:8443",
      TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST: "1",
    },
    fetchText: unsigned,
  });
  assertEquals(overlay.commit, "newcommit");
  // The opt-in without an overlay, or an overlay without the opt-in, is not.
  for (
    const env of [
      { TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST: "1" },
      { TURBOPANEL_DL_BASE: "https://dev.example.lan:8443" },
    ]
  ) {
    await assertRejects(
      () =>
        assertControlPlaneManifestPreflight({
          channel: "release",
          installMode: "production",
          env,
          fetchText: unsigned,
        }),
      UpdatePreflightError,
      "unsigned",
    );
  }
});

test("assertControlPlaneManifestPreflight rejects a bad instance manifest", async () => {
  await assertRejects(
    () =>
      assertControlPlaneManifestPreflight({
        channel: "release",
        fetchText: () =>
          Promise.resolve({ ok: true, status: 200, body: "not-json" }),
      }),
    UpdatePreflightError,
    "preflight_manifest",
  );
});

test("executeInstanceUpdateReconcile reports stages and backs up before install", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const stages: string[] = [];
  await executeInstanceUpdateReconcile({
    channel: "release",
    upgradeId: "up1",
    onStage: (stage) => stages.push(stage),
    hooks: managedUpdateHooks(calls),
  });
  assertEquals(stages, [
    "preparing",
    "downloading",
    "installing",
    "restarting",
    "verifying",
    "done",
  ]);
  const playbooks = calls.map((call) => call.args.at(-1));
  assertEquals(playbooks.includes("instance-backup.yml"), true);
  assertEquals(playbooks.includes("instance-launch-only.yml"), false);
  assertEquals(
    calls.some((call) => call.args.includes("update-instance")),
    true,
  );
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    false,
  );
  const backup = calls.find((call) =>
    call.args.includes("instance-backup.yml")
  );
  assertEquals(
    backup?.args.some((arg) => arg.startsWith("turbopanel_upgrade_id=up1")),
    true,
  );
});

test("executeInstanceUpdateReconcile refreshes Caddy when the updating page is absent", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  await executeInstanceUpdateReconcile({
    channel: "release",
    hooks: managedUpdateHooks(calls, {
      readCaddyfile: () => Promise.resolve("reverse_proxy only"),
    }),
  });
  const names = calls.map((call) => call.args.at(-1));
  const backupAt = names.indexOf("instance-backup.yml");
  const refreshAt = names.indexOf("instance-launch-only.yml");
  const installAt = calls.findIndex((call) =>
    call.args.includes("update-instance")
  );
  assertEquals(backupAt >= 0 && refreshAt > backupAt, true);
  assertEquals(installAt > refreshAt, true);
});

test("executeInstanceUpdateReconcile re-renders the units once, after the swap and before the restart", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const order: string[] = [];
  await executeInstanceUpdateReconcile({
    channel: "release",
    hooks: managedUpdateHooks(calls, {
      restartUnits: () => {
        order.push("restart");
        return Promise.resolve(true);
      },
      run: (bin, args) => {
        calls.push({ bin, args });
        order.push(
          args.includes("update-instance")
            ? "update-instance"
            : args.at(-1) ?? "",
        );
        if (args[0] === "inspect") {
          return Promise.resolve({
            code: 0,
            stdout: "true healthy\n",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  });
  const refreshes = order.filter((name) =>
    name === "instance-units-refresh.yml"
  );
  assertEquals(refreshes.length, 1);
  const refreshAt = order.indexOf("instance-units-refresh.yml");
  assertEquals(refreshAt > order.indexOf("update-instance"), true);
  assertEquals(order.indexOf("update-instance") >= 0, true);
  assertEquals(order.indexOf("restart") > refreshAt, true);
  assertEquals(order.filter((name) => name === "restart").length, 1);
});

test("executeInstanceUpdateReconcile warns and carries on when the unit refresh fails", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const base = managedUpdateHooks(calls);
  const stages: string[] = [];
  await executeInstanceUpdateReconcile({
    channel: "release",
    onStage: (stage) => stages.push(stage),
    hooks: {
      ...base,
      run: (bin, args, onStage) => {
        if (args.at(-1) === "instance-units-refresh.yml") {
          calls.push({ bin, args });
          return Promise.resolve({ code: 2, stdout: "", stderr: "boom" });
        }
        return base.run!(bin, args, onStage);
      },
    },
  });
  assertEquals(stages.at(-1), "done");
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    false,
  );
});

test("executeInstanceUpdateReconcile finishes a canary update: the manifest names the label, the binary its base version", async () => {
  // canary update #2 (2026-10-01): the new build served the target commit as
  // `0.1.7` (build `0.1.7-canary.56`), the manifest said `0.1.7-canary.56`,
  // and the strict version compare waited out the health budget and rolled back.
  const canaryManifest = JSON.stringify(
    await signWithTestKey({
      commit: "newcommit",
      version: "0.1.7-canary.56",
      channel: "canary",
    }),
  );
  const calls: Array<{ bin: string; args: string[] }> = [];
  const stages: string[] = [];
  await executeInstanceUpdateReconcile({
    channel: "canary",
    upgradeId: "up-canary",
    onStage: (stage) => stages.push(stage),
    hooks: managedUpdateHooks(calls, {
      fetchText: () =>
        Promise.resolve({ ok: true, status: 200, body: canaryManifest }),
      readHealth: () =>
        Promise.resolve({
          version: "0.1.7",
          commit: "newcommit",
          build: "0.1.7-canary.56",
        }),
    }),
  });
  assertEquals(stages.at(-1), "done");
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    false,
  );
});

test("executeInstanceUpdateReconcile names the running build in the backup playbook", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  await executeInstanceUpdateReconcile({
    channel: "release",
    upgradeId: "up-prev",
    hooks: managedUpdateHooks(calls, {
      readHealth: () =>
        Promise.resolve({ version: "0.1.0", commit: "oldcommit" }),
    }),
  }).catch(() => undefined);
  const backup = calls.find((call) =>
    call.args.includes("instance-backup.yml")
  );
  const joined = backup?.args.join(" ") ?? "";
  assertEquals(joined.includes("turbopanel_instance_version=0.1.0"), true);
  assertEquals(joined.includes("turbopanel_instance_revision=oldcommit"), true);
});

test("executeInstanceUpdateReconcile omits build vars from the backup when no build is running", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let reads = 0;
  await executeInstanceUpdateReconcile({
    channel: "release",
    upgradeId: "up-noprev",
    hooks: managedUpdateHooks(calls, {
      readHealth: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? null : { version: "0.1.1", commit: "newcommit" },
        );
      },
    }),
  });
  const backup = calls.find((call) =>
    call.args.includes("instance-backup.yml")
  );
  const joined = backup?.args.join(" ") ?? "";
  assertEquals(joined.includes("turbopanel_instance_version"), false);
  assertEquals(joined.includes("turbopanel_instance_revision"), false);
  assertEquals(joined.includes("turbopanel_upgrade_id=up-noprev"), true);
});

test("executeInstanceUpdateReconcile stops with preflight_backup when the backup playbook fails", async () => {
  for (
    const [stderr, expected] of [
      ["disk full\n", "disk full"],
      ["  ", "control-plane backup failed"],
    ] as const
  ) {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const base = managedUpdateHooks(calls);
    const error = await assertRejects(
      () =>
        executeInstanceUpdateReconcile({
          channel: "release",
          hooks: {
            ...base,
            run: (bin, args, onStage) =>
              args.includes("instance-backup.yml")
                ? Promise.resolve({ code: 1, stdout: "", stderr })
                : base.run!(bin, args, onStage),
          },
        }),
      UpdatePreflightError,
    );
    assertEquals(error.code, "preflight_backup");
    assertEquals(error.message.includes(expected), true);
    assertEquals(
      calls.some((call) => call.args.includes("update-instance")),
      false,
    );
  }
});

test("executeInstanceUpdateReconcile fails before installing when the Caddy refresh fails", async () => {
  for (
    const [stderr, expected] of [
      ["caddy render broke", "caddy render broke"],
      ["", "instance-launch-only refresh failed"],
    ] as const
  ) {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const base = managedUpdateHooks(calls, {
      readCaddyfile: () => Promise.resolve("reverse_proxy only"),
    });
    await assertRejects(
      () =>
        executeInstanceUpdateReconcile({
          channel: "release",
          hooks: {
            ...base,
            run: (bin, args, onStage) =>
              args.includes("instance-launch-only.yml")
                ? Promise.resolve({ code: 1, stdout: "", stderr })
                : base.run!(bin, args, onStage),
          },
        }),
      Error,
      expected,
    );
    assertEquals(
      calls.some((call) => call.args.includes("update-instance")),
      false,
    );
  }
});

test("executeInstanceUpdateReconcile rolls back when health never matches", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let reads = 0;
  await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        upgradeId: "up-health",
        hooks: managedUpdateHooks(calls, {
          readHealth: () => {
            reads += 1;
            if (reads === 1 || reads >= 6) {
              return Promise.resolve({ version: "0.1.0", commit: "oldcommit" });
            }
            return Promise.resolve(null);
          },
        }),
      }),
    ControlPlaneUpdateFailedError,
    "health_timeout",
  );
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    true,
  );
});

test("executeInstanceUpdateReconcile reports recovery_required when rollback fails", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const error = await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        upgradeId: "up-recover",
        hooks: managedUpdateHooks(calls, {
          readHealth: () =>
            Promise.resolve({ version: "0.1.0", commit: "oldcommit" }),
          run: (bin, args, onStage) => {
            calls.push({ bin, args });
            if (args.includes("instance-rollback.yml")) {
              return Promise.resolve({
                code: 1,
                stdout: "",
                stderr: "no previous generation",
              });
            }
            if (args[0] === "inspect") {
              return Promise.resolve({
                code: 0,
                stdout: "true healthy\n",
                stderr: "",
              });
            }
            if (args.includes("update-instance")) {
              onStage?.("downloading");
              onStage?.("installing");
              onStage?.("restarting");
            }
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
        }),
      }),
    ControlPlaneUpdateFailedError,
    "recovery_required",
  );
  assertEquals(error instanceof ControlPlaneUpdateFailedError, true);
  if (error instanceof ControlPlaneUpdateFailedError) {
    assertEquals(error.stage, "failed");
    assertEquals(error.code, "recovery_required");
    assertStringIncludes(error.message, "instance-rollback.yml");
    assertStringIncludes(error.message, "up-recover");
    // The plain fact leads; the commands come second, behind a health check.
    assertStringIncludes(
      error.message,
      "recovery_required: The new control plane",
    );
    assertStringIncludes(error.message, "could not be confirmed");
    assertEquals(
      error.message.indexOf("Check first") <
        error.message.indexOf("instance-rollback.yml"),
      true,
    );
  }
});

test("ensureWebServerRunning starts an inactive Caddy and then succeeds", async () => {
  let active = false;
  const calls: string[][] = [];
  const ok = await ensureWebServerRunning({
    isActive: () => Promise.resolve(active),
    runSystemctl: (args) => {
      calls.push(args);
      active = true;
      return Promise.resolve({ success: true, stderr: "" });
    },
    sleep: () => Promise.resolve(),
  });
  assertEquals(ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0], ["-n", "systemctl", "restart", "turbopanel-caddy"]);
});

test("ensureWebServerRunning leaves a running Caddy alone", async () => {
  let started = 0;
  const ok = await ensureWebServerRunning({
    isActive: () => Promise.resolve(true),
    runSystemctl: () => {
      started++;
      return Promise.resolve({ success: true, stderr: "" });
    },
  });
  assertEquals(ok, true);
  assertEquals(started, 0);
});

test("ensureWebServerRunning retries with backoff, then gives up", async () => {
  const waits: number[] = [];
  let starts = 0;
  const ok = await ensureWebServerRunning({
    isActive: () => Promise.resolve(false),
    runSystemctl: () => {
      starts++;
      return Promise.resolve({ success: false, stderr: "boom" });
    },
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    backoffMs: [1, 2, 3],
  });
  assertEquals(ok, false);
  assertEquals(starts, 3);
  assertEquals(waits, [1, 2, 3]);
});

test("a failed Caddy reload does not fail the instance restart", async () => {
  const run = (args: string[]) =>
    Promise.resolve({
      success: !args.includes("reload"),
      stderr: "Unit cannot be reloaded because it is inactive",
    });
  assertEquals(await restartControlPlaneUnits({ runSystemctl: run }), true);
});

test("Caddy down after the restart is started and the update succeeds", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let caddyUp = false;
  const result = await executeInstanceUpdateReconcile({
    channel: "release",
    hooks: managedUpdateHooks(calls, {
      ensureWebServer: () => {
        const ok = ensureWebServerRunning({
          isActive: () => Promise.resolve(caddyUp),
          runSystemctl: () => {
            caddyUp = true;
            return Promise.resolve({ success: true, stderr: "" });
          },
          sleep: () => Promise.resolve(),
        });
        return ok;
      },
    }),
  });
  assertEquals(caddyUp, true);
  assertEquals(result.warning, undefined);
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    false,
  );
});

test("a web server that never starts is its own error, with no rollback", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const error = await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        hooks: managedUpdateHooks(calls, {
          ensureWebServer: () => Promise.resolve(false),
        }),
      }),
    ControlPlaneUpdateFailedError,
    "web server did not start",
  );
  if (error instanceof ControlPlaneUpdateFailedError) {
    assertEquals(error.code, "web_server_failed");
    assertEquals(error.stage, "failed");
  }
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    false,
  );
});

test("a bad new build still rolls back even when the web server is down", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        hooks: managedUpdateHooks(calls, {
          ensureWebServer: () => Promise.resolve(false),
          readHealth: () => Promise.resolve(null),
        }),
      }),
    ControlPlaneUpdateFailedError,
  );
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    true,
  );
});

test("a slow host that answers after more than five minutes is not rolled back", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let clock = 0;
  let reads = 0;
  await executeInstanceUpdateReconcile({
    channel: "release",
    upgradeId: "up-slow",
    hooks: managedUpdateHooks(calls, {
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      readHealth: () => {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({ version: "0.1.0", commit: "oldcommit" });
        }
        // Silent for 7 minutes of fake time, then the new build answers.
        return Promise.resolve(
          clock < 7 * 60 * 1000
            ? null
            : { version: "0.1.1", commit: "newcommit" },
        );
      },
    }),
  });
  assertEquals(clock >= 7 * 60 * 1000, true);
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    false,
  );
});

test("a new build that is serving after a failed rollback is a success with a warning", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let clock = 0;
  let reads = 0;
  let rollbackRan = false;
  const base = managedUpdateHooks(calls);
  const outcome = await executeInstanceUpdateReconcile({
    channel: "release",
    upgradeId: "up-late",
    hooks: {
      ...base,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      readHealth: () => {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({ version: "0.1.0", commit: "oldcommit" });
        }
        return Promise.resolve(
          rollbackRan ? { version: "0.1.1", commit: "newcommit" } : null,
        );
      },
      run: (bin, args, onStage) => {
        if (args.includes("instance-rollback.yml")) {
          calls.push({ bin, args });
          rollbackRan = true;
          return Promise.resolve({ code: 1, stdout: "", stderr: "slow" });
        }
        return base.run!(bin, args, onStage);
      },
    },
  });
  assertEquals(rollbackRan, true);
  assertStringIncludes(outcome.warning ?? "", "health_timeout");
  assertStringIncludes(outcome.warning ?? "", "0.1.1 is serving");
});

test("a failed migration keeps the previous database and rolls back", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let history = ["0000_init"];
  const error = await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        upgradeId: "up-migrate",
        hooks: managedUpdateHooks(calls, {
          migrate: () => {
            history = ["0000_init"];
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "migration refused",
            });
          },
        }),
      }),
    ControlPlaneUpdateFailedError,
    "migration_failed",
  );
  assertEquals(history, ["0000_init"]);
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    true,
  );
  assertEquals(error instanceof ControlPlaneUpdateFailedError, true);
});

test("a successful migration lets the new instance boot", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let history = ["0000_init"];
  let booted = false;
  await executeInstanceUpdateReconcile({
    channel: "release",
    hooks: managedUpdateHooks(calls, {
      migrate: () => {
        history = ["0000_init", "0007_add_upgrade_tables"];
        return Promise.resolve({
          code: 0,
          stdout: "migrations applied successfully\n",
          stderr: "",
        });
      },
      readHealth: () => {
        booted = history.includes("0007_add_upgrade_tables");
        return Promise.resolve({ version: "0.1.1", commit: "newcommit" });
      },
    }),
  });
  assertEquals(booted, true);
  assertEquals(history.at(-1), "0007_add_upgrade_tables");
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    false,
  );
});

test("a partial install restores the previous instance and UI", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let instance = "old-instance";
  let ui = "old-ui";
  await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        upgradeId: "up-partial",
        hooks: managedUpdateHooks(calls, {
          filesTouched: () => Promise.resolve(true),
          readHealth: () =>
            Promise.resolve(
              instance === "old-instance" && ui === "old-ui"
                ? { version: "0.1.0", commit: "oldcommit" }
                : { version: "0.1.1", commit: "partial" },
            ),
          run: (bin, args, onStage) => {
            calls.push({ bin, args });
            if (args[0] === "inspect") {
              return Promise.resolve({
                code: 0,
                stdout: "true healthy\n",
                stderr: "",
              });
            }
            if (args.includes("update-instance")) {
              instance = "partial-instance";
              ui = "partial-ui";
              onStage?.("installing");
              return Promise.resolve({
                code: 1,
                stdout: "",
                stderr: "unpack failed after swap",
              });
            }
            if (args.includes("instance-rollback.yml")) {
              instance = "old-instance";
              ui = "old-ui";
              return Promise.resolve({ code: 0, stdout: "", stderr: "" });
            }
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
        }),
      }),
    ControlPlaneUpdateFailedError,
    "install_failed",
  );
  assertEquals(instance, "old-instance");
  assertEquals(ui, "old-ui");
  assertEquals(
    calls.some((call) => call.args.includes("instance-rollback.yml")),
    true,
  );
});

test("a thrown migration command restores the previous instance and UI", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let instance = "old-instance";
  let ui = "old-ui";
  await assertRejects(
    () =>
      executeInstanceUpdateReconcile({
        channel: "release",
        upgradeId: "up-throw",
        hooks: managedUpdateHooks(calls, {
          migrate: () => {
            throw new Error("migrate: spawn failed");
          },
          readHealth: () =>
            Promise.resolve(
              instance === "old-instance" && ui === "old-ui"
                ? { version: "0.1.0", commit: "oldcommit" }
                : { version: "0.1.1", commit: "newcommit" },
            ),
          run: (bin, args, onStage) => {
            calls.push({ bin, args });
            if (args[0] === "inspect") {
              return Promise.resolve({
                code: 0,
                stdout: "true healthy\n",
                stderr: "",
              });
            }
            if (args.includes("update-instance")) {
              instance = "new-instance";
              ui = "new-ui";
              onStage?.("downloading");
              onStage?.("installing");
              onStage?.("restarting");
              return Promise.resolve({ code: 0, stdout: "", stderr: "" });
            }
            if (args.includes("instance-rollback.yml")) {
              instance = "old-instance";
              ui = "old-ui";
              return Promise.resolve({ code: 0, stdout: "", stderr: "" });
            }
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
        }),
      }),
    ControlPlaneUpdateFailedError,
    "migration_failed",
  );
  assertEquals(instance, "old-instance");
  assertEquals(ui, "old-ui");
});

test("restart reloads Caddy unless its binary changed", async () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return Promise.resolve({ success: true, stderr: "" });
  };
  assertEquals(await restartControlPlaneUnits({ runSystemctl: run }), true);
  assertEquals(calls[0]?.includes("restart"), true);
  assertEquals(calls[0]?.includes("turbopanel-instance"), true);
  assertEquals(calls[1]?.includes("reload"), true);
  assertEquals(calls[1]?.includes("turbopanel-caddy"), true);
  calls.length = 0;
  assertEquals(
    await restartControlPlaneUnits({
      runSystemctl: run,
      restartCaddy: true,
    }),
    true,
  );
  assertEquals(calls[1]?.includes("restart"), true);
});

test("the updating page stays on :8443 while the instance restarts", async () => {
  const template = await Deno.readTextFile(
    new URL(
      "../../orchestration/roles/instance-launch/templates/Caddyfile.j2",
      import.meta.url,
    ),
  );
  assertStringIncludes(template, "updating.html");
  assertStringIncludes(template, "control_plane_updating");
  assertStringIncludes(template, "@webhook path /webhook/*");
  const tasks = await Deno.readTextFile(
    new URL(
      "../../orchestration/roles/instance-launch/tasks/main.yml",
      import.meta.url,
    ),
  );
  assertStringIncludes(tasks, "Reload turbopanel caddy");
});

test("rootHelperColocatedRefreshInvocation refreshes a panel host's daemon with no enrolment flags", () => {
  const invocation = rootHelperColocatedRefreshInvocation({
    channel: "canary",
  });
  assertEquals(invocation.bin, "sudo");
  assertEquals(invocation.args[2]?.endsWith("/scripts/tp-orchestrate"), true);
  assertEquals([...invocation.args.slice(0, 2), ...invocation.args.slice(3)], [
    "-n",
    "--",
    "update-colocated",
    "--channel",
    "canary",
    "--progress-markers",
    "--no-start",
  ]);
  const pinned =
    "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-0.1.2-canary.20260927-190000-abcdef0.json";
  assertEquals(
    rootHelperColocatedRefreshInvocation({
      channel: "canary",
      manifestUrl: pinned,
    }).args.slice(4),
    [
      "--channel",
      "canary",
      "--manifest-url",
      pinned,
      "--progress-markers",
      "--no-start",
    ],
  );
});

test("rootHelperColocatedRefreshInvocation refuses a missing channel and a non-daemon rail", () => {
  assertThrows(
    () => rootHelperColocatedRefreshInvocation({}),
    Error,
    "update channel",
  );
  assertThrows(() =>
    rootHelperColocatedRefreshInvocation({
      channel: "canary",
      manifestUrl:
        "https://github.com/TurboPanel/turbopanel/releases/download/canary/manifest.json",
    })
  );
});

test("reconcileHelperInvocation picks update-colocated for a panel host and update elsewhere", () => {
  const colocated = reconcileHelperInvocation({
    colocated: true,
    args: ["--no-start"],
    channel: "canary",
  });
  assertEquals(colocated.args[3], "update-colocated");
  assertEquals(colocated.args.includes("--license-stdin"), false);

  const remote = reconcileHelperInvocation({
    args: ["--no-start"],
    channel: "canary",
  });
  assertEquals(remote.args[3], "update");
  assertEquals(remote.args.includes("--license-stdin"), true);
});

test("the host license never reaches the root helper's argv, only its stdin", () => {
  const license = encodeLicenseArg("license-id", "secret-token");
  const args = buildRunReconcileArgs({
    instanceUrl: "https://huey.lan:8443",
    instanceCaPath: "/etc/turbopanel/instance-ca.pem",
  });
  const invocation = reconcileHelperInvocation({ args, channel: "canary" });
  assertEquals(invocation.args.some((a) => a.includes(license)), false);
  assertEquals(invocation.args.includes("--license"), false);
  assertEquals(rootHelperReconcileStdin({ license }), `${license}\n`);
  // A co-located refresh does not enrol: nothing on stdin, even if given.
  assertEquals(
    rootHelperReconcileStdin({ colocated: true, license }),
    undefined,
  );
});

test("rootHelperReconcileStdin refuses a missing or malformed license", () => {
  assertThrows(
    () => rootHelperReconcileStdin({}),
    Error,
    "needs the host license",
  );
  for (const bad of ["", "abc def", "abc'x", "abc\nx", "a;b"]) {
    assertThrows(
      () => rootHelperReconcileStdin({ license: bad }),
      Error,
      "malformed host license",
    );
  }
});

test("executeRunReconcile on a development host sets the license in the piped script, not argv", async () => {
  const originalCommand = Deno.Command;
  let capturedArgs: string[] | undefined;
  let written = "";
  try {
    Deno.Command = class {
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        capturedArgs = opts.args as string[];
      }
      spawn() {
        const child = fakeReconcileChild();
        return {
          ...child,
          stdin: {
            getWriter() {
              return {
                write(chunk: Uint8Array) {
                  written += new TextDecoder().decode(chunk);
                  return Promise.resolve();
                },
                close() {
                  return Promise.resolve();
                },
              };
            },
          },
        };
      }
    } as unknown as typeof Deno.Command;
    await executeRunReconcile({
      script: "#!/bin/sh\nexit 0\n",
      args: ["--no-start"],
      license: "bGljZW5zZS1pZDp0b2tlbg",
    });
    assertEquals(capturedArgs, ["sh", "-s", "--", "--no-start"]);
    assertEquals(
      written,
      "TURBOPANEL_LICENSE='bGljZW5zZS1pZDp0b2tlbg'\nexport TURBOPANEL_LICENSE\n#!/bin/sh\nexit 0\n",
    );
  } finally {
    Deno.Command = originalCommand;
  }
});

test("scriptWithLicense leaves the script alone without a license and refuses a malformed one", () => {
  assertEquals(scriptWithLicense("echo hi\n"), "echo hi\n");
  assertThrows(
    () => scriptWithLicense("echo hi\n", "x' ; id ; '"),
    Error,
    "malformed host license",
  );
});

test("executeRunReconcile refuses a co-located daemon update on a development host", async () => {
  const originalCommand = Deno.Command;
  let spawned = false;
  try {
    Deno.Command = class {
      constructor(_cmd: string, _opts: Deno.CommandOptions) {}
      spawn() {
        spawned = true;
        return fakeReconcileChild();
      }
    } as unknown as typeof Deno.Command;
    await assertRejects(
      () =>
        executeRunReconcile({ args: [], channel: "canary", colocated: true }),
      Error,
      "not supported on a development host",
    );
    assertEquals(spawned, false);
  } finally {
    Deno.Command = originalCommand;
  }
});

test("spawnRootHelper pipes the license to the helper's stdin and keeps it out of argv", async () => {
  const originalCommand = Deno.Command;
  let opts: Deno.CommandOptions | undefined;
  let written = "";
  let closed = false;
  try {
    Deno.Command = class {
      constructor(_cmd: string, o: Deno.CommandOptions) {
        opts = o;
      }
      spawn() {
        return {
          stdin: {
            getWriter() {
              return {
                write(chunk: Uint8Array) {
                  written += new TextDecoder().decode(chunk);
                  return Promise.resolve();
                },
                close() {
                  closed = true;
                  return Promise.resolve();
                },
              };
            },
          },
        };
      }
    } as unknown as typeof Deno.Command;
    await spawnRootHelper(
      { bin: "sudo", args: ["tp-orchestrate", "update", "--license-stdin"] },
      "/",
      "bGljZW5zZS1pZDp0b2tlbg\n",
    );
    assertEquals(opts?.stdin, "piped");
    assertEquals(written, "bGljZW5zZS1pZDp0b2tlbg\n");
    assertEquals(closed, true);
    assertEquals(
      (opts?.args ?? []).some((a) => a.includes("bGljZW5z")),
      false,
    );
  } finally {
    Deno.Command = originalCommand;
  }
});

test("spawnRootHelper leaves stdin closed without text and survives a helper that exits before reading", async () => {
  const originalCommand = Deno.Command;
  const stdins: Array<Deno.CommandOptions["stdin"]> = [];
  try {
    Deno.Command = class {
      constructor(_cmd: string, o: Deno.CommandOptions) {
        stdins.push(o.stdin);
      }
      spawn() {
        return {
          stdin: {
            getWriter() {
              return {
                write() {
                  return Promise.reject(new Error("broken pipe"));
                },
                close() {
                  return Promise.resolve();
                },
              };
            },
          },
        };
      }
    } as unknown as typeof Deno.Command;
    const helper = { bin: "sudo", args: ["tp-orchestrate"] };
    await spawnRootHelper(helper, "/", undefined);
    await spawnRootHelper(helper, "/", "abc\n");
    assertEquals(stdins, ["null", "piped"]);
  } finally {
    Deno.Command = originalCommand;
  }
});
