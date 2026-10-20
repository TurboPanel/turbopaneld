import { assertEquals } from "@std/assert";
import {
  addressKey,
  parseSnippet,
  snippetSiteAddresses,
  trimSnippetSites,
} from "./caddy-snippet.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SITE = (head: string, body = "  respond 200") =>
  `${head} {\n${body}\n}\n`;

test("addresses keep their port and drop only the scheme, and are compared in lowercase", () => {
  assertEquals(addressKey("HTTPS://A.com:8443"), "a.com:8443");
  assertEquals(addressKey("http://a.com"), "a.com");
  assertEquals(addressKey("*.a.com"), "*.a.com");
});

test("a site line may list several addresses, quoted, with schemes and ports, and a comment after the brace", () => {
  const text = [
    `a.com, "b.com" https://c.com:8443 { # the main site`,
    "  respond 200",
    "}",
    "",
  ].join("\n");
  assertEquals(snippetSiteAddresses(text), ["a.com", "b.com", "c.com:8443"]);
  assertEquals(parseSnippet(text).uninterpretable, false);
});

test("a wildcard only ever matches the same wildcard, and a port is a different address", () => {
  const text = SITE("*.a.com") + SITE("a.com:8443");
  const trimmed = trimSnippetSites(text, new Set(["a.com"]));
  assertEquals(trimmed.removed, []);
  assertEquals(trimmed.contents, text);
  const wild = trimSnippetSites(text, new Set(["*.a.com"]));
  assertEquals(wild.removed, ["*.a.com"]);
  assertEquals(snippetSiteAddresses(wild.contents), ["a.com:8443"]);
});

test("an import, a global block and a snippet definition are never read as addresses and are kept", () => {
  const text = [
    "{",
    "  email admin@example.test",
    "}",
    "(shared) {",
    "  header X-Test 1",
    "}",
    "import more",
    SITE("a.com"),
  ].join("\n");
  const parsed = parseSnippet(text);
  assertEquals(parsed.uninterpretable, false);
  assertEquals(snippetSiteAddresses(text), ["a.com"]);
  const trimmed = trimSnippetSites(text, new Set(["a.com"]));
  assertEquals(trimmed.sitesLeft, 0);
  assertEquals(trimmed.otherLeft, true);
  assertEquals(trimmed.contents.includes("import more"), true);
  assertEquals(trimmed.contents.includes("(shared) {"), true);
  assertEquals(trimmed.contents.includes("a.com"), false);
});

test("a line the reader cannot place is reported, not guessed at", () => {
  for (
    const odd of [
      "a.com\n{\n  respond 200\n}\n",
      "a.com,\nb.com {\n  respond 200\n}\n",
      "a.com b.com\n",
      "a.com{\n  respond 200\n}\n",
      '"a.com {\n  respond 200\n}\n',
    ]
  ) {
    assertEquals(parseSnippet(odd).uninterpretable, true, odd);
  }
});

test("a block ends where its braces balance, with nested blocks and placeholders inside", () => {
  const text = SITE(
    "a.com",
    "  handle /api/* {\n    reverse_proxy {$UPSTREAM}\n    header X-Host {host}\n  }",
  ) + SITE("b.com");
  const trimmed = trimSnippetSites(text, new Set(["a.com"]));
  assertEquals(trimmed.removed, ["a.com"]);
  assertEquals(trimmed.contents.includes("reverse_proxy"), false);
  assertEquals(snippetSiteAddresses(trimmed.contents), ["b.com"]);
  assertEquals(trimmed.sitesLeft, 1);
});

test("a block with other addresses keeps them and its body", () => {
  const text = SITE("a.com, b.com", "  reverse_proxy 127.0.0.1:1");
  const trimmed = trimSnippetSites(text, new Set(["a.com"]));
  assertEquals(trimmed.removed, ["a.com"]);
  assertEquals(snippetSiteAddresses(trimmed.contents), ["b.com"]);
  assertEquals(trimmed.contents.includes("reverse_proxy 127.0.0.1:1"), true);
});

test("the pieces of a snippet join back into the file", () => {
  const text = [
    "# a comment",
    "",
    SITE("a.com"),
    "import x",
    "(s) {",
    "}",
  ].join("\n");
  const parsed = parseSnippet(text);
  assertEquals(parsed.items.flatMap((item) => item.lines).join("\n"), text);
});
