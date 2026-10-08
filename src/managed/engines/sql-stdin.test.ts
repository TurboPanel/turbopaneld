import { assertEquals } from "@std/assert";
import {
  execSqlWithStdinRetry,
  isTransientSqlStdinFailure,
} from "./sql-stdin.ts";
import type { ManagedEngineExec } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isTransientSqlStdinFailure matches a closed-stream spawn with no SQL output", () => {
  assertEquals(
    isTransientSqlStdinFailure({
      success: false,
      stdout: "",
      stderr: "spawn failed: Writable stream is closed",
    }),
    true,
  );
  assertEquals(
    isTransientSqlStdinFailure({
      success: false,
      stdout: "",
      stderr: "Broken pipe (EPIPE)",
    }),
    true,
  );
});

test("isTransientSqlStdinFailure rejects SQL errors and success", () => {
  assertEquals(
    isTransientSqlStdinFailure({
      success: true,
      stdout: "",
      stderr: "spawn failed: Writable stream is closed",
    }),
    false,
  );
  assertEquals(
    isTransientSqlStdinFailure({
      success: false,
      stdout: "",
      stderr: 'ERROR:  relation "x" already exists',
    }),
    false,
  );
  assertEquals(
    isTransientSqlStdinFailure({
      success: false,
      stdout: "1",
      stderr: "spawn failed: Writable stream is closed",
    }),
    false,
  );
  assertEquals(
    isTransientSqlStdinFailure({
      success: false,
      stdout: "",
      stderr: "role exists",
    }),
    false,
  );
});

test("execSqlWithStdinRetry retries once then succeeds", async () => {
  let calls = 0;
  const exec: ManagedEngineExec = () => {
    calls++;
    if (calls === 1) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "spawn failed: Writable stream is closed",
      });
    }
    return Promise.resolve({ success: true, stdout: "ok", stderr: "" });
  };
  const result = await execSqlWithStdinRetry(exec, ["psql"], "SELECT 1;");
  assertEquals(result.success, true);
  assertEquals(result.stdout, "ok");
  assertEquals(calls, 2);
});

test("execSqlWithStdinRetry does not retry a SQL error", async () => {
  let calls = 0;
  const exec: ManagedEngineExec = () => {
    calls++;
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "ERROR:  syntax error",
    });
  };
  const result = await execSqlWithStdinRetry(exec, ["psql"], "FOO");
  assertEquals(result.success, false);
  assertEquals(result.stderr, "ERROR:  syntax error");
  assertEquals(calls, 1);
});

test("execSqlWithStdinRetry names a second closed-stdin failure", async () => {
  let calls = 0;
  const exec: ManagedEngineExec = () => {
    calls++;
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "spawn failed: Writable stream is closed",
    });
  };
  const result = await execSqlWithStdinRetry(exec, ["psql"], "SELECT 1;");
  assertEquals(result.success, false);
  assertEquals(result.stderr.includes("stdin closed after retry"), true);
  assertEquals(result.stderr.includes("Writable stream is closed"), true);
  assertEquals(calls, 2);
});
