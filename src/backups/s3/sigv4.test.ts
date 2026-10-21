import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  amzDate,
  EMPTY_PAYLOAD_SHA256,
  signS3Request,
  uriEncode,
} from "./sigv4.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// The published Signature Version 4 examples (documentation test vectors).
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2013-05-24T00:00:00Z");

test("signs the published GET object example", async () => {
  const headers = await signS3Request({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    credentials,
    headers: { Range: "bytes=0-9" },
    payloadHash: EMPTY_PAYLOAD_SHA256,
    now,
  });
  assertStringIncludes(
    headers["authorization"]!,
    "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("signs the published list example with a query string", async () => {
  const headers = await signS3Request({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/?lifecycle"),
    region: "us-east-1",
    credentials,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    now,
  });
  assertStringIncludes(
    headers["authorization"]!,
    "Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  );
});

test("date format and encoding helpers", () => {
  assertEquals(amzDate(now), "20130524T000000Z");
  assertEquals(uriEncode("a b/c", true), "a%20b/c");
  assertEquals(uriEncode("a b/c"), "a%20b%2Fc");
});
