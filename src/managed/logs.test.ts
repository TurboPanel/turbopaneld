import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
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
    () => collectManagedLogs("../escape", undefined, () => Promise.resolve(ok(""))),
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
      `turbopanel-managed-${managedId}`,
      "logs",
      "--no-color",
      "--tail",
      "2000",
    ],
  ]);
});

test("collectManagedLogs truncates oversized stdout to the last 256 KiB", async () => {
  const chunk = "x".repeat(300 * 1024);
  const text = await collectManagedLogs(
    "managed_logs_2",
    undefined,
    () => Promise.resolve(ok(chunk)),
  );

  assertEquals(text.length, 256 * 1024);
  assertEquals(text, chunk.slice(chunk.length - 256 * 1024));
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
