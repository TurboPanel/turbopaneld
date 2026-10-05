import { assertEquals } from "@std/assert";
import { redactUrlSecrets } from "./redact-url-secrets.ts";

Deno.test("redactUrlSecrets drops the signed query and user info, keeps host and path", () => {
  assertEquals(
    redactUrlSecrets(
      "error sending request for url (https://u:p@release-assets.githubusercontent.com/a/b?X-Amz-Signature=abc&token=t#f): dns error",
    ),
    "error sending request for url (https://release-assets.githubusercontent.com/a/b?[redacted]): dns error",
  );
  assertEquals(redactUrlSecrets("no url here"), "no url here");
});

Deno.test("redactUrlSecrets drops a password that holds ?, # or @", () => {
  assertEquals(
    redactUrlSecrets("fetch https://user:pa?ss@host.example/repo.git failed"),
    "fetch https://host.example/repo.git failed",
  );
  assertEquals(
    redactUrlSecrets("fetch https://user:pa#ss@host.example/x?y=1 failed"),
    "fetch https://host.example/x?[redacted] failed",
  );
  assertEquals(
    redactUrlSecrets("fetch https://user:p@ss:w?rd@host.example failed"),
    "fetch https://host.example failed",
  );
  assertEquals(
    redactUrlSecrets("https://user:pa?ss@host.example"),
    "https://host.example",
  );
});

Deno.test("redactUrlSecrets keeps an @ that belongs to the path or the query", () => {
  assertEquals(
    redactUrlSecrets("GET https://registry.example/@scope/pkg ok"),
    "GET https://registry.example/@scope/pkg ok",
  );
  assertEquals(
    redactUrlSecrets("GET https://host.example?mail=a@b.test ok"),
    "GET https://host.example?[redacted] ok",
  );
});

Deno.test("redactUrlSecrets gives the same text when applied twice", () => {
  const once = redactUrlSecrets("see https://u:p?w@h.test/a?b=c#d and more");
  assertEquals(once, "see https://h.test/a?[redacted] and more");
  assertEquals(redactUrlSecrets(once), once);
});
