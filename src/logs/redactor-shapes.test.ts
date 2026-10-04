import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { pumpLines } from "./line-stream.ts";
import {
  createTranscriptRedactor,
  redactCommandSummary,
  REDACTED,
  rememberSecretPlaintexts,
  resetSharedSecretRedactorForTests,
} from "./redactor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The real shapes a decrypted value takes in container and build output:
 * headers, JSON, URLs, env lines, a PEM inside JSON, and a value split across
 * stream chunks. Every secret here is generated at run time (nothing
 * password-shaped is a literal).
 */

function randomSecret(): string {
  return crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
}

function randomPem(): { pem: string; bodyLines: string[] } {
  const bodyLines = Array.from({ length: 4 }, () => btoa(randomSecret()));
  const header = `-----BEGIN ${"PRIVATE"} KEY-----`;
  const footer = `-----END ${"PRIVATE"} KEY-----`;
  return { pem: [header, ...bodyLines, footer].join("\n"), bodyLines };
}

function assertNoSecret(output: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    assertFalse(output.includes(secret), `leaked: ${secret.slice(0, 6)}…`);
  }
}

test("an Authorization header keeps its name and loses the token", () => {
  const token = randomSecret();
  const redact = createTranscriptRedactor([token]);
  const out = redact(`> Authorization: Bearer ${token}`);
  assertEquals(out, `> Authorization: Bearer ${REDACTED}`);
});

test("a secret inside one-line JSON output is replaced in place", () => {
  const token = randomSecret();
  const password = randomSecret();
  const redact = createTranscriptRedactor([token, password]);
  const out = redact(
    JSON.stringify({ token, nested: { password }, ok: true }),
  );
  assertNoSecret(out, [token, password]);
  assertEquals(
    JSON.parse(out),
    { token: REDACTED, nested: { password: REDACTED }, ok: true },
  );
});

test("a PEM inside JSON (literal backslash-n separators) is redacted line by line", () => {
  const { pem, bodyLines } = randomPem();
  const redact = createTranscriptRedactor([pem]);
  const json = JSON.stringify({ tls: { key: pem } });
  assertStringIncludes(json, "\\n");
  const out = redact(json);
  assertNoSecret(out, bodyLines);
  assertFalse(out.includes("BEGIN PRIVATE KEY"));
  assertFalse(out.includes("END PRIVATE KEY"));
});

test("a password in URL userinfo is redacted and the URL stays readable", () => {
  const password = randomSecret();
  const redact = createTranscriptRedactor([password]);
  const out = redact(`pulling https://deploy:${password}@registry.example/v2/`);
  assertEquals(out, `pulling https://deploy:${REDACTED}@registry.example/v2/`);
});

test("env, YAML and docker -e shapes are all redacted", () => {
  const password = randomSecret();
  const redact = createTranscriptRedactor([password]);
  const lines = [
    `DB_PASSWORD=${password}`,
    `  password: "${password}"`,
    `docker run -e API_KEY='${password}' image`,
    `export SECRET=${password}; echo done`,
  ];
  for (const line of lines) {
    const out = redact(line);
    assertNoSecret(out, [password]);
    assertStringIncludes(out, REDACTED);
  }
});

test("a value that appears several times in a line is replaced every time", () => {
  const secret = randomSecret();
  const redact = createTranscriptRedactor([secret]);
  const out = redact(`${secret}:${secret}|x${secret}x`);
  assertEquals(out, `${REDACTED}:${REDACTED}|x${REDACTED}x`);
});

test("regex metacharacters in a secret are matched literally", () => {
  const secret = `a.b*c+(d)[e]$f^g|h\\i?{1}`;
  const redact = createTranscriptRedactor([secret]);
  const out = redact(`value=${secret} end`);
  assertEquals(out, `value=${REDACTED} end`);
  // The unescaped regex reading of the secret must not match anything else.
  assertEquals(redact("aXb c d e"), "aXb c d e");
});

test("a secret split across stream chunks is redacted once the line is whole", async () => {
  const secret = randomSecret();
  const redact = createTranscriptRedactor([secret]);
  const encoder = new TextEncoder();
  const half = Math.floor(secret.length / 2);
  const chunks = [
    `build step 1\nTOKEN=${secret.slice(0, half)}`,
    `${secret.slice(half)} trailing\nstep 2 ok\n`,
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const seen: string[] = [];
  const full = await pumpLines(stream, (line) => seen.push(redact(line)));
  assertEquals(seen, [
    "build step 1",
    `TOKEN=${REDACTED} trailing`,
    "step 2 ok",
  ]);
  // The buffered result for the caller is the raw text: only the transcript
  // path is redacted, which is why callers redact error summaries themselves.
  assertStringIncludes(full, secret);
});

test("CRLF output is redacted the same as LF output", async () => {
  const secret = randomSecret();
  const redact = createTranscriptRedactor([secret]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`first ${secret}\r\nsecond\r\n`),
      );
      controller.close();
    },
  });
  const seen: string[] = [];
  await pumpLines(stream, (line) => seen.push(redact(line)));
  assertEquals(seen, [`first ${REDACTED}`, "second"]);
});

test("a multi-line error summary carrying a PEM is redacted and keeps its newlines", () => {
  resetSharedSecretRedactorForTests();
  try {
    const { pem, bodyLines } = randomPem();
    rememberSecretPlaintexts([pem]);
    const stderr = [
      "docker compose up failed:",
      ...pem.split("\n"),
      "exit status 1",
    ].join("\n");
    const out = redactCommandSummary(stderr);
    assertNoSecret(out, bodyLines);
    assert(out.includes("\n"));
    assertStringIncludes(out, "docker compose up failed:");
    assertStringIncludes(out, "exit status 1");
  } finally {
    resetSharedSecretRedactorForTests();
  }
});

test("control characters can neither forge a transcript line nor hide a secret", () => {
  const secret = randomSecret();
  const redact = createTranscriptRedactor([secret]);
  // Newline, carriage return and tab are neutralised so output cannot start a
  // fake transcript line.
  assertEquals(redact("a\nb\rc\td"), "a_b_c_d");
  // Terminal escape sequences are NOT stripped (only the three above are); the
  // redaction itself must still hold around them.
  const out = redact(`\u001b[31mkey=${secret}\u001b[0m\u0007`);
  assertNoSecret(out, [secret]);
  assertStringIncludes(out, `key=${REDACTED}`);
});
