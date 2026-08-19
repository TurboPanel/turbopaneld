import { assertEquals } from "@std/assert";
import { installOriginNeedsInsecureTls } from "./install-tls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("installOriginNeedsInsecureTls trusts public HTTPS on 443", () => {
  assertEquals(installOriginNeedsInsecureTls("https://turbopanel.dev"), false);
  assertEquals(
    installOriginNeedsInsecureTls("https://panel.example.com"),
    false,
  );
});

test("installOriginNeedsInsecureTls flags platform-CA listeners", () => {
  assertEquals(
    installOriginNeedsInsecureTls("https://studio.lan:8443"),
    true,
  );
  assertEquals(installOriginNeedsInsecureTls("https://studio.lan"), true);
  assertEquals(installOriginNeedsInsecureTls("http://studio.lan:8880"), false);
});

test("installOriginNeedsInsecureTls flags RFC1918 and loopback IPv4 on 443", () => {
  assertEquals(installOriginNeedsInsecureTls("https://10.0.0.1"), true);
  assertEquals(installOriginNeedsInsecureTls("https://127.0.0.1"), true);
  assertEquals(installOriginNeedsInsecureTls("https://192.168.1.10"), true);
  assertEquals(installOriginNeedsInsecureTls("https://172.16.5.1"), true);
  assertEquals(installOriginNeedsInsecureTls("https://172.31.255.1"), true);
  assertEquals(installOriginNeedsInsecureTls("https://169.254.1.1"), true);
  // Public TEST-NET-3 still uses public TLS on 443.
  assertEquals(installOriginNeedsInsecureTls("https://203.0.113.10"), false);
  // Outside 172.16/12 remains public.
  assertEquals(installOriginNeedsInsecureTls("https://172.32.0.1"), false);
});

test("installOriginNeedsInsecureTls flags loopback and ULA IPv6 on 443", () => {
  assertEquals(installOriginNeedsInsecureTls("https://[::1]"), true);
  assertEquals(
    installOriginNeedsInsecureTls("https://[0:0:0:0:0:0:0:1]"),
    true,
  );
  assertEquals(installOriginNeedsInsecureTls("https://[fe80::1]"), true);
  assertEquals(installOriginNeedsInsecureTls("https://[fc00::1]"), true);
  assertEquals(installOriginNeedsInsecureTls("https://[fd12::1]"), true);
});

test("installOriginNeedsInsecureTls flags reserved LAN TLDs and localhost", () => {
  assertEquals(installOriginNeedsInsecureTls("https://app.local"), true);
  assertEquals(installOriginNeedsInsecureTls("https://app.internal"), true);
  assertEquals(installOriginNeedsInsecureTls("https://app.home"), true);
  assertEquals(installOriginNeedsInsecureTls("https://app.corp"), true);
  assertEquals(installOriginNeedsInsecureTls("https://localhost"), true);
  assertEquals(installOriginNeedsInsecureTls("https://foo.localhost"), true);
});

test("installOriginNeedsInsecureTls rejects non-https and invalid origins", () => {
  assertEquals(installOriginNeedsInsecureTls(""), false);
  assertEquals(installOriginNeedsInsecureTls("  "), false);
  assertEquals(installOriginNeedsInsecureTls("http://203.0.113.10"), false);
  assertEquals(installOriginNeedsInsecureTls("not a url"), false);
  assertEquals(installOriginNeedsInsecureTls("https://"), false);
});

test("installOriginNeedsInsecureTls ignores malformed dotted hosts as private IPv4", () => {
  // Deno's URL parser expands https://10.0.0 → 10.0.0.0 (private).
  assertEquals(installOriginNeedsInsecureTls("https://10.0.0"), true);
  // Out-of-range octets are rejected by URL → false via catch.
  assertEquals(installOriginNeedsInsecureTls("https://10.0.0.256"), false);
  // Non-numeric final label is not an IPv4 literal.
  assertEquals(installOriginNeedsInsecureTls("https://10.0.0.1a"), false);
});
