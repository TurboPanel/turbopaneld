import { assertEquals } from "@std/assert";
import { endpointRefusal } from "./endpoint-guard.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("accepts https hosts and private http addresses", () => {
  assertEquals(endpointRefusal("https://s3.example.com"), null);
  assertEquals(endpointRefusal("https://s3.example.com:9000/"), null);
  assertEquals(endpointRefusal("http://10.1.2.3:9000"), null);
  assertEquals(endpointRefusal("http://192.168.1.5"), null);
  assertEquals(endpointRefusal("http://[fd12::1]:9000"), null);
  assertEquals(endpointRefusal("https://[2001:db8::1]:9000"), null);
  assertEquals(endpointRefusal("https://[::ffff:8.8.8.8]"), null);
  assertEquals(endpointRefusal("http://[::ffff:10.1.2.3]:9000"), null);
});

test("refuses loopback and link-local addresses written as IPv6", () => {
  for (
    const url of [
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:a9fe:a9fe]",
      "https://[::ffff:169.254.169.254]",
      "https://[0:0:0:0:0:ffff:7f00:1]",
      "https://[::127.0.0.1]",
      "https://[::7f00:1]",
      "https://[64:ff9b::7f00:1]",
      "https://[64:ff9b::a9fe:a9fe]",
      "https://[::ffff:0.0.0.0]",
    ]
  ) {
    assertEquals(typeof endpointRefusal(url), "string", url);
    assertEquals(
      typeof endpointRefusal(url.replace("https", "http")),
      "string",
      url,
    );
  }
});

test("a mapped public address over plain http is still refused", () => {
  assertEquals(typeof endpointRefusal("http://[::ffff:8.8.8.8]"), "string");
});

test("refuses loopback, link-local, metadata and public http", () => {
  for (
    const url of [
      "http://127.0.0.1:9000",
      "https://localhost",
      "https://169.254.169.254",
      "https://metadata.google.internal",
      "https://[::1]",
      "https://[fe80::1]",
      "http://8.8.8.8",
      "http://s3.example.com",
      "ftp://s3.example.com",
      "https://u:p@s3.example.com",
      "https://s3.example.com/bucket",
      "nonsense",
    ]
  ) {
    assertEquals(typeof endpointRefusal(url), "string", url);
  }
});

test("tests can allow loopback over http", () => {
  assertEquals(
    endpointRefusal("http://127.0.0.1:9000", { allowLoopback: true }),
    null,
  );
  assertEquals(
    typeof endpointRefusal("https://169.254.169.254", { allowLoopback: true }),
    "string",
  );
});
