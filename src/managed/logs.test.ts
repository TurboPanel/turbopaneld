import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  createMutableTranscriptRedactor,
  rememberSecretPlaintexts,
  resetSharedSecretRedactorForTests,
} from "../logs/redactor.ts";
import { collectManagedLogs } from "./logs.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function ok(stdout: string): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function fail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

test("collectManagedLogs rejects unsafe managedId", async () => {
  await assertRejects(
    () =>
      collectManagedLogs("../escape", undefined, () => Promise.resolve(ok(""))),
    Error,
    "unsupported characters",
  );
});

test("collectManagedLogs clamps tail to 1..2000 and requests compose logs", async () => {
  const managedId = "managed_logs_1";
  const calls: string[][] = [];

  const text = await collectManagedLogs(
    managedId,
    { tail: 9999 },
    (args) => {
      calls.push([...args]);
      return Promise.resolve(ok("line-one\nline-two\n"));
    },
  );

  assertEquals(text, "line-one\nline-two\n");
  assertEquals(calls, [
    [
      "compose",
      "-p",
      // The compose project is the bare managed id — no readable prefix.
      managedId,
      "logs",
      "--no-color",
      "--tail",
      "2000",
    ],
  ]);
});

test("collectManagedLogs floors a missing or non-positive tail at 1", async () => {
  const tails: string[] = [];
  await collectManagedLogs(
    "managed_logs_floor",
    { tail: 0 },
    (args) => {
      tails.push(args.at(-1) ?? "");
      return Promise.resolve(ok(""));
    },
  );
  await collectManagedLogs(
    "managed_logs_floor",
    { tail: -12.7 },
    (args) => {
      tails.push(args.at(-1) ?? "");
      return Promise.resolve(ok(""));
    },
  );
  await collectManagedLogs(
    "managed_logs_floor",
    undefined,
    (args) => {
      tails.push(args.at(-1) ?? "");
      return Promise.resolve(ok(""));
    },
  );
  assertEquals(tails, ["1", "1", "200"]);
});

test("collectManagedLogs truncates oversized multibyte stdout by UTF-8 bytes", async () => {
  const euro = "\u20ac";
  const payload = `HEAD-DROP\n${euro.repeat(80_000)}\nTAIL-KEEP`;
  const text = await collectManagedLogs(
    "managed_logs_2",
    undefined,
    () => Promise.resolve(ok(payload)),
  );

  assertEquals(new TextEncoder().encode(text).byteLength <= 200 * 1024, true);
  assertEquals(text.includes("HEAD-DROP"), false);
  assertEquals(text.endsWith("\nTAIL-KEEP"), true);
  assertEquals(text.includes("\uFFFD"), false);
});

test("collectManagedLogs redacts secrets, strips escapes and keeps line breaks", async () => {
  const redactor = createMutableTranscriptRedactor(["s3cret"]);
  const text = await collectManagedLogs(
    "managed_logs_redact",
    undefined,
    () =>
      Promise.resolve(ok(
        "db  | started\r\n" +
          "db  | \x1b[31mpassword=s3cret\x1b[0m\n" +
          "db  | col1\tcol2\x07\n",
      )),
    redactor,
  );

  assertEquals(
    text,
    "db  | started\ndb  | password=***\ndb  | col1\tcol2_\n",
  );
});

test("collectManagedLogs redacts values in the process-wide deny-set", async () => {
  resetSharedSecretRedactorForTests();
  try {
    rememberSecretPlaintexts(["shared-secret-value"]);
    const text = await collectManagedLogs(
      "managed_logs_shared",
      undefined,
      () => Promise.resolve(ok("a shared-secret-value b\nsecond\n")),
    );
    assertEquals(text, "a *** b\nsecond\n");
  } finally {
    resetSharedSecretRedactorForTests();
  }
});

test("collectManagedLogs throws when compose logs fails", async () => {
  await assertRejects(
    () =>
      collectManagedLogs(
        "managed_logs_3",
        undefined,
        () => Promise.resolve(fail("compose unavailable")),
      ),
    Error,
    "compose unavailable",
  );
});

test("collectManagedLogs uses a fallback message when stderr is empty", async () => {
  await assertRejects(
    () =>
      collectManagedLogs(
        "managed_logs_4",
        undefined,
        () => Promise.resolve(fail("")),
      ),
    Error,
    "compose logs failed",
  );
});
