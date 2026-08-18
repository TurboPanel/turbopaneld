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
