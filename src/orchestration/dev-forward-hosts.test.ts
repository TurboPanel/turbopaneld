import { assertEquals } from "@std/assert";
import {
  mergeDevCertPublicUrls,
  readDevForwardHostsFile,
} from "./dev-forward-hosts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("mergeDevCertPublicUrls keeps configured https origins and forwarded LAN names", () => {
  assertEquals(
    mergeDevCertPublicUrls(
      "https://panel.lan:8443",
      "192.0.2.10\nlab.lan\n192.0.2.10\n",
    ),
    "https://panel.lan:8443,192.0.2.10,lab.lan",
  );
});

test("mergeDevCertPublicUrls drops blank and unsafe tokens", () => {
  assertEquals(mergeDevCertPublicUrls(undefined, ""), "");
  assertEquals(
    mergeDevCertPublicUrls("  ", "not a host\n$(id)\n192.0.2.11"),
    "192.0.2.11",
  );
  assertEquals(
    mergeDevCertPublicUrls("http://panel.example.com", "192.0.2.12"),
    "192.0.2.12",
  );
});

test("readDevForwardHostsFile returns an empty string when the file is absent", () => {
  assertEquals(
    readDevForwardHostsFile("/no/such/dev-forward-hosts", () => {
      throw new Error("missing");
    }),
    "",
  );
  assertEquals(
    readDevForwardHostsFile("/ignored", () => "192.0.2.10\n"),
    "192.0.2.10\n",
  );
});
