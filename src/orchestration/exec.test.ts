import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  run,
  runLogged,
  runOrThrow,
  runStreamingLines,
  runtimeEnv,
} from "./exec.ts";
import { InstallPresenter } from "./install-presenter.ts";
import { setActiveInstallPresenter } from "./install-presenter-context.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("runtimeEnv disables OpenSSL ARM CPU probing for ansible cryptography", () => {
  const env = runtimeEnv();
  assertEquals(
    env.OPENSSL_armcap,
    "0",
    "OPENSSL_armcap must be 0 so cryptography wheels do not SIGILL on Apple Silicon VMs that advertise SVE2 without implementing it",
  );
});

test("runtimeEnv extra vars can override OPENSSL_armcap when needed", () => {
  const env = runtimeEnv({ OPENSSL_armcap: "1" });
  assertEquals(env.OPENSSL_armcap, "1");
});

test("runtimeEnv pins uv python install and cache directories", () => {
  const env = runtimeEnv();
  assertEquals(env.UV_PYTHON_INSTALL_BIN, "0");
  assertEquals(env.UV_NO_MODIFY_PATH, "1");
  assertEquals(env.UV_PYTHON_DOWNLOADS, "automatic");
  assertEquals(typeof env.UV_PYTHON_INSTALL_DIR, "string");
  assertEquals(typeof env.UV_CACHE_DIR, "string");
  assertEquals(env.PATH?.includes(":"), true);
});

test("runtimeEnv extra vars merge on top of the runtime PATH prefix", () => {
  const env = runtimeEnv({ EXTRA_FLAG: "1", PATH: "/custom/bin" });
  assertEquals(env.EXTRA_FLAG, "1");
  assertEquals(env.PATH, "/custom/bin");
  assertEquals(env.OPENSSL_armcap, "0");
});

describe("exec subprocess helpers", () => {
  it("run captures stdout when stream is false", async () => {
    const result = await run("/bin/echo", ["hello-exec"], { stream: false });
    assertEquals(result.success, true);
    assertEquals(result.code, 0);
    assertEquals(result.stdout.trim(), "hello-exec");
  });

  it("run reports failure for a non-zero exit", async () => {
    const result = await run("/bin/sh", ["-c", "exit 7"], { stream: false });
    assertEquals(result.success, false);
    assertEquals(result.code, 7);
  });

  it("runStreamingLines delivers stdout and stderr lines", async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const result = await runStreamingLines(
      "/bin/sh",
      ["-c", "echo out-line; echo err-line 1>&2"],
      {
        onStdoutLine: (line) => stdoutLines.push(line),
        onStderrLine: (line) => stderrLines.push(line),
      },
    );
    assertEquals(result.success, true);
    assertEquals(stdoutLines, ["out-line"]);
    assertEquals(stderrLines, ["err-line"]);
  });

  it("runLogged throws when the command fails", async () => {
    await assertRejects(
      () =>
        runLogged("/bin/sh", ["-c", "exit 3"], {
          level: "DEBUG",
          component: "exec-test",
        }),
      Error,
      "exit 3",
    );
  });

  it("runOrThrow includes captured stderr in the error", async () => {
    await assertRejects(
      () =>
        runOrThrow("/bin/sh", ["-c", "echo boom 1>&2; exit 2"], {
          stream: false,
        }),
      Error,
      "boom",
    );
  });

  it("run with default stream leaves captured stdout empty", async () => {
    const result = await run("/bin/echo", ["streamed"]);
    assertEquals(result.success, true);
    assertEquals(result.stdout, "");
    assertEquals(result.stderr, "");
  });

  it("runStreamingLines delivers a leftover buffer without a trailing newline", async () => {
    const stdoutLines: string[] = [];
    const result = await runStreamingLines(
      "/bin/sh",
      ["-c", "printf 'partial-no-newline'"],
      {
        onStdoutLine: (line) => stdoutLines.push(line),
      },
    );
    assertEquals(result.success, true);
    assertEquals(stdoutLines, ["partial-no-newline"]);
  });

  it("runStreamingLines cancels unused stdout when no line handler is set", async () => {
    // Silent command: writing to a cancelled pipe (e.g. echo) can SIGPIPE.
    const result = await runStreamingLines("/bin/true", []);
    assertEquals(result.success, true);
    assertEquals(result.code, 0);
  });

  it("runLogged returns success for a zero-exit command", async () => {
    const result = await runLogged("/bin/echo", ["logged-ok"], {
      level: "DEBUG",
      component: "exec-test",
    });
    assertEquals(result.success, true);
    assertEquals(result.code, 0);
  });

  it("runOrThrow returns the captured result when no presenter is active", async () => {
    const result = await runOrThrow("/bin/echo", ["plain-ok"], {
      stream: false,
    });
    assertEquals(result.success, true);
    assertEquals(result.stdout.trim(), "plain-ok");
  });

  it("runOrThrow routes lines through the active install presenter", async () => {
    const presenter = new InstallPresenter(false);
    setActiveInstallPresenter(presenter);
    presenter.beginStep("exec presenter");
    try {
      const result = await runOrThrow("/bin/echo", ["presented"], {
        stream: false,
      });
      assertEquals(result.success, true);
    } finally {
      presenter.dispose();
      setActiveInstallPresenter(null);
    }
  });
});
