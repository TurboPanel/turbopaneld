import {
  buildRunReconcileArgs,
  CDN_RUN_SCRIPT,
  encodeLicenseArg,
  PRODUCTION_CONTROL_PLANE,
  resolveRunScriptUrl,
} from "./run-reconcile.ts";

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
