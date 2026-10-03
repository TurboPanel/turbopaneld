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
