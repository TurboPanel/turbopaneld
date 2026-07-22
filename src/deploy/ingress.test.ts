import { assertStringIncludes } from "jsr:@std/assert";
import {
  caddyfile,
  caddyTraefikUpstream,
  traefikCompose,
} from "./ingress.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CONFIG_DIR = "/etc/turbopanel";

test("traefikCompose publishes loopback ports with proxy protocol and TLS", () => {
  const compose = traefikCompose();
  assertStringIncludes(compose, "127.0.0.1:7080:7080");
  assertStringIncludes(compose, "127.0.0.1:7443:7443");
  assertStringIncludes(compose, "--entrypoints.web.address=:7080");
  assertStringIncludes(compose, "--entrypoints.websecure.address=:7443");
  assertStringIncludes(compose, "--entrypoints.websecure.http.tls=true");
  assertStringIncludes(compose, "--entrypoints.web.proxyProtocol.insecure=true");
  assertStringIncludes(
    compose,
    "--entrypoints.websecure.proxyProtocol.insecure=true",
  );
  if (compose.includes("socat")) {
    throw new Error("traefikCompose must not include socat");
  }
  if (compose.includes("ingress-bridge")) {
    throw new Error("traefikCompose must not include ingress-bridge");
  }
  if (compose.includes("alpine")) {
    throw new Error("traefikCompose must not include alpine");
  }
});

test("caddyTraefikUpstream http hop uses h2c and PROXY v2", () => {
  const upstream = caddyTraefikUpstream("http");
  assertStringIncludes(upstream, "127.0.0.1:7080");
  assertStringIncludes(upstream, "versions h2c");
  assertStringIncludes(upstream, "proxy_protocol v2");
  assertStringIncludes(upstream, "keepalive off");
});

test("caddyTraefikUpstream https hop uses TLS skip-verify and PROXY v2", () => {
  const upstream = caddyTraefikUpstream("https");
  assertStringIncludes(upstream, "127.0.0.1:7443");
  assertStringIncludes(upstream, "tls_insecure_skip_verify");
  assertStringIncludes(upstream, "versions 2");
  assertStringIncludes(upstream, "proxy_protocol v2");
  assertStringIncludes(upstream, "keepalive off");
});

test("caddyfile disables auto_https and advertises h1 h2 h3", () => {
  const config = caddyfile(CONFIG_DIR);
  assertStringIncludes(config, "auto_https off");
  assertStringIncludes(config, "protocols h1 h2 h3");
});
