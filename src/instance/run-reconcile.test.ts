import {
  buildRunReconcileArgs,
  CDN_RUN_SCRIPT,
  encodeLicenseArg,
  PRODUCTION_CONTROL_PLANE,
  resolveBootstrapInsecureTls,
  resolveRunScriptUrl,
} from "./run-reconcile.ts";
import { join } from "@std/path";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("encodeLicenseArg uses base64url without padding", () => {
  const encoded = encodeLicenseArg("license-id", "token");
  assertEquals(encoded.includes(":"), false);
  assertEquals(encoded.includes("+"), false);
  assertEquals(encoded.includes("/"), false);
  assertEquals(encoded.includes("="), false);
});

Deno.test("resolveRunScriptUrl uses CDN for production control plane", () => {
  assertEquals(
    resolveRunScriptUrl({
      kind: "url",
      baseUrl: PRODUCTION_CONTROL_PLANE,
      wsBaseUrl: "wss://turbopanel.app",
    }),
    CDN_RUN_SCRIPT,
  );
});

Deno.test("resolveRunScriptUrl uses instance host for self-hosted installs", () => {
  assertEquals(
    resolveRunScriptUrl({
      kind: "url",
      baseUrl: "https://huey.lan:8443",
      wsBaseUrl: "wss://huey.lan:8443",
    }),
    "https://huey.lan:8443/run.sh",
  );
});

Deno.test("buildRunReconcileArgs omits --host for production", () => {
  assertEquals(
    buildRunReconcileArgs({
      licenseArg: "abc",
      instanceUrl: PRODUCTION_CONTROL_PLANE,
    }),
    ["--license", "abc", "--no-start"],
  );
});

Deno.test("resolveBootstrapInsecureTls uses CDN without insecure flag", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      runScriptUrl: CDN_RUN_SCRIPT,
    }),
    false,
  );
});

Deno.test("resolveBootstrapInsecureTls enables insecure for self-hosted without CA", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      runScriptUrl: "https://huey.lan:8443/run.sh",
    }),
    true,
  );
});

Deno.test("resolveBootstrapInsecureTls prefers platform CA for self-hosted", () => {
  assertEquals(
    resolveBootstrapInsecureTls({
      runScriptUrl: "https://huey.lan:8443/run.sh",
      instanceCaPath: "/opt/turbopanel/platform/config/instance-ca.pem",
    }),
    false,
  );
});

Deno.test("buildRunReconcileArgs includes self-hosted flags", () => {
  assertEquals(
    buildRunReconcileArgs({
      licenseArg: "abc",
      instanceUrl: "https://huey.lan:8443",
      instanceCaPath: "/opt/turbopanel/platform/config/instance-ca.pem",
      insecureTls: true,
    }),
    [
      "--license",
      "abc",
      "--host",
      "https://huey.lan:8443",
      "--instance-ca",
      "/opt/turbopanel/platform/config/instance-ca.pem",
      "--insecure-tls",
      "--no-start",
    ],
  );
});

Deno.test("buildRunReconcileArgs passes non-canonical instance CA path", () => {
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

Deno.test("executeRunReconcile chdir survives daemon directory swap", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "tp-reconcile-" });
  const daemonDir = join(tmp, "daemon");
  await Deno.mkdir(daemonDir, { recursive: true });
  const originalCwd = Deno.cwd();
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

  const { executeRunReconcile } = await import("./run-reconcile.ts");
  await executeRunReconcile({ script: swapScript, args: [] });

  const cwdAfter = Deno.cwd();
  if (cwdAfter === daemonDir) {
    throw new Error(`expected cwd to move off deleted daemon dir, still ${cwdAfter}`);
  }

  Deno.chdir(originalCwd);
  try {
    await Deno.remove(tmp, { recursive: true });
  } catch {
    await new Deno.Command("sudo", {
      args: ["rm", "-rf", tmp],
    }).output();
  }
});
