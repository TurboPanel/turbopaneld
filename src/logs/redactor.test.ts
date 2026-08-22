import { assertEquals } from "@std/assert";
import {
  createMutableTranscriptRedactor,
  createTranscriptRedactor,
  normalizeDenySet,
  redactPlaintexts,
  redactSecretValues,
} from "./redactor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("createTranscriptRedactor scrubs every deny-set value", () => {
  const redact = createTranscriptRedactor([
    "hunter2",
    "-----BEGIN PRIVATE KEY-----MIIkey-----END PRIVATE KEY-----",
    "db-root-pw",
  ]);
  assertEquals(
    redact("connecting with hunter2 and db-root-pw"),
    "connecting with *** and ***",
  );
  assertEquals(
    redact("key=-----BEGIN PRIVATE KEY-----MIIkey-----END PRIVATE KEY-----"),
    "key=***",
  );
});

test("createTranscriptRedactor strips log-injection control characters", () => {
  const redact = createTranscriptRedactor([]);
  assertEquals(redact("a\nb\rc\td"), "a_b_c_d");
});

test("normalizeDenySet drops short/empty values and orders longest first", () => {
  assertEquals(
    normalizeDenySet(["", null, undefined, "x", " pw ", "password-long"]),
    ["password-long", " pw ", "pw"],
  );
});

const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ",
  "Cw3fakekeymaterialline2/PLAINTEXT+not+for+disk==",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

test("normalizeDenySet expands multiline plaintexts into line fragments", () => {
  const denySet = normalizeDenySet([PEM]);
  // The whole PEM plus every non-trivial line of it.
  assertEquals(denySet.includes(PEM), true);
  assertEquals(
    denySet.includes(
      "Cw3fakekeymaterialline2/PLAINTEXT+not+for+disk==",
    ),
    true,
  );
  assertEquals(denySet.includes("-----BEGIN PRIVATE KEY-----"), true);
  assertEquals(denySet.includes("-----END PRIVATE KEY-----"), true);
  // Empty trailing line never becomes a deny-set entry.
  assertEquals(denySet.includes(""), false);
});

test("multiline PEM material is redacted line by line", () => {
  const redact = createTranscriptRedactor([PEM]);
  for (const line of PEM.split("\n")) {
    if (line.length === 0) continue;
    assertEquals(redact(`wrote ${line} to disk`), "wrote *** to disk");
  }
});

test("multiline variable secrets are redacted line by line", () => {
  const secret = "line-one-secret\nline-two-secret\nline-three-secret";
  const redact = createTranscriptRedactor([secret]);
  assertEquals(redact("env VAL=line-two-secret"), "env VAL=***");
  assertEquals(redact("env VAL=line-three-secret"), "env VAL=***");
});

test("redactPlaintexts normalizes raw plaintexts for error redaction", () => {
  assertEquals(
    redactPlaintexts("failed near line-two-secret", [
      "line-one-secret\nline-two-secret",
    ]),
    "failed near ***",
  );
});

test("longer secrets are redacted before shorter substrings of them", () => {
  const redact = createTranscriptRedactor(["pw", "pw-long-secret"]);
  assertEquals(redact("value=pw-long-secret"), "value=***");
});

test("redactSecretValues leaves non-secret text untouched", () => {
  assertEquals(
    redactSecretValues("plain build output", ["nope"]),
    "plain build output",
  );
});

test("mutable redactor picks up secrets added after construction", () => {
  const redactor = createMutableTranscriptRedactor(["first"]);
  assertEquals(redactor.redact("first second"), "*** second");
  redactor.add(["second", null, ""]);
  assertEquals(redactor.redact("first second"), "*** ***");
  assertEquals(redactor.secrets().length, 2);
});
