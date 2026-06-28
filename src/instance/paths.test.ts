import { resolveInstanceConfig, resolveInstanceCaPath } from "./paths.ts";

const CADDY_HTTPS = "https://localhost:8443";
const PLATFORM_CA = "/opt/turbopanel/platform/instance/certs/ca.crt";

Deno.test("resolveInstanceConfig uses url mode when TURBOPANEL_INSTANCE_URL is set", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_URL: CADDY_HTTPS,
  });

  if (config.kind !== "url") {
    throw new Error("expected url mode when TURBOPANEL_INSTANCE_URL is set");
  }
  if (config.baseUrl !== CADDY_HTTPS) {
    throw new Error(`expected baseUrl ${CADDY_HTTPS}, got ${config.baseUrl}`);
  }
  if (config.wsBaseUrl !== "wss://localhost:8443") {
    throw new Error(
      `expected wss://localhost:8443, got ${config.wsBaseUrl}`,
    );
  }
});

Deno.test("resolveInstanceConfig uses socket mode when TURBOPANEL_INSTANCE_URL is absent", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "deno",
  });

  if (config.kind !== "socket") {
    throw new Error(
      "expected socket mode when TURBOPANEL_INSTANCE_URL is absent",
    );
  }
});

Deno.test("workers transition: url and CA env keys resolve to url mode", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "workers",
    TURBOPANEL_INSTANCE_URL: CADDY_HTTPS,
    TURBOPANEL_INSTANCE_CA: PLATFORM_CA,
  });

  if (config.kind !== "url") {
    throw new Error(
      "expected url mode after workers transition writes URL/CA keys",
    );
  }
  if (config.baseUrl !== CADDY_HTTPS) {
    throw new Error(`expected baseUrl ${CADDY_HTTPS}, got ${config.baseUrl}`);
  }
});

Deno.test("resolveInstanceCaPath prefers TURBOPANEL_INSTANCE_CA env", () => {
  const path = resolveInstanceCaPath({
    TURBOPANEL_INSTANCE_CA: PLATFORM_CA,
  });
  if (path !== PLATFORM_CA) {
    throw new Error(`expected ${PLATFORM_CA}, got ${path}`);
  }
});

Deno.test("resolveInstanceCaPath returns undefined when env unset and canonical file missing", () => {
  const path = resolveInstanceCaPath({});
  if (path !== undefined) {
    throw new Error(`expected undefined, got ${path}`);
  }
});

Deno.test("deno transition: cleared URL key restores socket mode", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "deno",
    TURBOPANEL_INSTANCE_CA: PLATFORM_CA,
  });

  if (config.kind !== "socket") {
    throw new Error(
      "expected socket mode after deno transition clears TURBOPANEL_INSTANCE_URL",
    );
  }
});
