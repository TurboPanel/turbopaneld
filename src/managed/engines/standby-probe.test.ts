/**
 * Host-free coverage for mysql-family real-server readiness and seed errors.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { ManagedEngineContext, ManagedEngineExec } from "./types.ts";
import {
  execStandbySeedWithInitRetry,
  formatStandbySeedFailure,
  isTransientStandbySeedFailure,
  waitMysqlFamilyRealServer,
} from "./standby-probe.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("formatStandbySeedFailure describes empty stdout and stderr", () => {
  assertEquals(
    formatStandbySeedFailure({ stdout: "", stderr: "" }),
    "the seed command produced no output (the database container may have restarted during the seed)",
  );
  assertEquals(
    formatStandbySeedFailure({ stdout: "  ", stderr: "\n" }),
    "the seed command produced no output (the database container may have restarted during the seed)",
  );
});

test("formatStandbySeedFailure sanitizes non-empty stderr", () => {
  const text = formatStandbySeedFailure({
    stdout: "",
    stderr: "ERROR 1133 (28000) at line 11",
  });
  assertEquals(text.includes("1133"), true);
  assertEquals(text.includes("unknown"), false);
});

test("isTransientStandbySeedFailure matches empty output and init-window codes", () => {
  assertEquals(
    isTransientStandbySeedFailure({
      success: false,
      stdout: "",
      stderr: "",
    }),
    true,
  );
  assertEquals(
    isTransientStandbySeedFailure({
      success: false,
      stdout: "",
      stderr: "ERROR 1133 (28000) at line 11: Can't find any matching row",
    }),
    true,
  );
  assertEquals(
    isTransientStandbySeedFailure({
      success: false,
      stdout: "",
      stderr: "ERROR 2002 (HY000): Can't connect to server",
    }),
    true,
  );
  assertEquals(
    isTransientStandbySeedFailure({
      success: false,
      stdout: "",
      stderr: "ERROR 2013 (HY000): Lost connection to server during query",
    }),
    true,
  );
  assertEquals(
    isTransientStandbySeedFailure({
      success: false,
      stdout: "",
      stderr: "seed boom",
    }),
    false,
  );
  assertEquals(
    isTransientStandbySeedFailure({
      success: true,
      stdout: "",
      stderr: "",
    }),
    false,
  );
});

test("waitMysqlFamilyRealServer polls while TCP ping is refused", async () => {
  const kinds: string[] = [];
  let tcpFails = 1;
  await waitMysqlFamilyRealServer({
    label: "managed sql",
    fallbackError: "ping did not succeed",
    pollMs: 0,
    sleep: () => Promise.resolve(),
    ping: (kind) => {
      kinds.push(kind);
      if (kind === "tcp" && tcpFails > 0) {
        tcpFails--;
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "Can't connect to server on '127.0.0.1' (111)",
        });
      }
      return Promise.resolve({
        success: true,
        stdout: "is alive",
        stderr: "",
      });
    },
  });
  assertEquals(kinds, ["socket", "tcp", "socket", "tcp", "socket"]);
});

test("waitMysqlFamilyRealServer returns when socket then TCP then socket succeed", async () => {
  const kinds: string[] = [];
  await waitMysqlFamilyRealServer({
    label: "managed sql",
    fallbackError: "ping did not succeed",
    ping: (kind) => {
      kinds.push(kind);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  });
  assertEquals(kinds, ["socket", "tcp", "socket"]);
});

test("waitMysqlFamilyRealServer throws after the deadline", async () => {
  let nowCalls = 0;
  await assertRejects(
    () =>
      waitMysqlFamilyRealServer({
        label: "managed sql",
        fallbackError: "still booting",
        timeoutMs: 120_000,
        pollMs: 0,
        sleep: () => Promise.resolve(),
        now: () => {
          nowCalls++;
          if (nowCalls === 1) return 0;
          if (nowCalls === 2) return 1;
          return 130_000;
        },
        ping: () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "still booting",
          }),
      }),
    Error,
    "managed sql not ready within",
  );
});

test("execStandbySeedWithInitRetry retries once after empty output", async () => {
  let seeds = 0;
  let waited = 0;
  const exec: ManagedEngineExec = (argv) => {
    if (argv[0] === "sh") {
      seeds++;
      if (seeds === 1) {
        return Promise.resolve({ success: false, stdout: "", stderr: "" });
      }
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "sql",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec,
  };
  const result = await execStandbySeedWithInitRetry(
    ctx,
    () => "dump",
    "[client]\n",
    () => {
      waited++;
      return Promise.resolve();
    },
  );
  assertEquals(result.success, true);
  assertEquals(seeds, 2);
  assertEquals(waited, 1);
});

test("execStandbySeedWithInitRetry does not retry an unrelated error", async () => {
  let seeds = 0;
  let waited = 0;
  const exec: ManagedEngineExec = (argv) => {
    if (argv[0] === "sh") {
      seeds++;
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "seed boom",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "sql",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec,
  };
  const result = await execStandbySeedWithInitRetry(
    ctx,
    () => "dump",
    "[client]\n",
    () => {
      waited++;
      return Promise.resolve();
    },
  );
  assertEquals(result.success, false);
  assertEquals(seeds, 1);
  assertEquals(waited, 0);
  assertEquals(formatStandbySeedFailure(result).includes("unknown"), false);
});
