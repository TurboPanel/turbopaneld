import { assert, assertEquals, assertFalse } from "@std/assert";
import { createTranscriptRedactor, redactCommandSummary } from "./redactor.ts";
import { stripLogInjection } from "../util/logger.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests (see redactor-shapes.test.ts). */
const test = Deno.test.bind(Deno);

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

function randomSecret(): string {
  return crypto.randomUUID().replaceAll("-", "") + '/+ "q';
}

function toHex(value: string): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(value)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

test("ANSI colour, cursor and OSC sequences never reach a transcript line", () => {
  const redact = createTranscriptRedactor([]);
  assertEquals(redact(`${ESC}[31mred${ESC}[0m ok`), "red ok");
  assertEquals(redact(`a${ESC}[2K${ESC}[1Ab`), "ab");
  assertEquals(redact(`${ESC}]0;evil title${BEL}text`), "text");
  assertEquals(
    redact(`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\`),
    "link",
  );
});

test("BEL, backspace, NUL, DEL and C1 controls are neutralised", () => {
  const input = `a${BEL}b\bc\u0000d\u007fe\u009bf`;
  const out = stripLogInjection(input);
  for (const code of [0x07, 0x08, 0x00, 0x7f, 0x9b]) {
    assertFalse(out.includes(String.fromCharCode(code)), `kept ${code}`);
  }
  assertEquals(out.replaceAll("_", ""), "abcdef");
});

test("ordinary text, unicode and the existing newline/tab mapping are unchanged", () => {
  assertEquals(stripLogInjection("a\nb\rc\td"), "a_b_c_d");
  assertEquals(stripLogInjection("héllo → 世界"), "héllo → 世界");
});

test("a bare trailing ESC or unterminated CSI cannot throw or loop", () => {
  assertEquals(stripLogInjection(`x${ESC}`), "x");
  assertEquals(stripLogInjection(`x${ESC}[31`), "x");
  assertEquals(stripLogInjection(`x${ESC}]0;never ends`), "x");
});

test("encoded copies of a secret are redacted (base64, base64url, URL, JSON, hex)", () => {
  const secret = randomSecret();
  const bytes = new TextEncoder().encode(secret);
  const b64 = btoa(String.fromCharCode(...bytes));
  const encodings = [
    b64,
    b64.replaceAll("=", ""),
    b64.replaceAll("+", "-").replaceAll("/", "_"),
    b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    toHex(secret),
    toHex(secret).toUpperCase(),
  ];
  const redact = createTranscriptRedactor([secret]);
  for (const encoded of encodings) {
    const out = redact(`token=${encoded}&x=1`);
    assertFalse(out.includes(encoded), `leaked ${encoded.slice(0, 8)}`);
    assertEquals(out, "token=***&x=1");
  }
});

test("command summaries get the same encoded-copy redaction", () => {
  const secret = randomSecret();
  const encoded = encodeURIComponent(secret);
  const out = redactCommandSummary(`failed: ${encoded}\nnext`, [secret]);
  assertFalse(out.includes(encoded));
  assert(out.includes("\nnext"));
});

test("short secrets are not expanded into encodings", () => {
  const redact = createTranscriptRedactor(["abc"]);
  // base64("abc") is "YWJj": a short secret must not shred unrelated output.
  assertEquals(redact("YWJj and 616263"), "YWJj and 616263");
});

test("the derived set is cached per secret list (same output on repeat calls)", () => {
  const secret = randomSecret();
  const redact = createTranscriptRedactor([secret]);
  const line = `v=${encodeURIComponent(secret)}`;
  for (let i = 0; i < 3; i++) assertEquals(redact(line), "v=***");
});
