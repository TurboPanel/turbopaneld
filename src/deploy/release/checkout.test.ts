/**
 * Host-free coverage for {@link checkoutRelease} with an injected git runner.
 * Credential file / kind helpers live in `checkout-credentials.test.ts`.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  checkoutRelease,
  gitEnvironment,
  type GitRunner,
  type GitRunResult,
  removeCheckoutCredentialFiles,
  writeCheckoutCredentialFiles,
} from "./checkout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

type Call = {
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

function scriptedGit(
  responses: Array<(call: Call) => GitRunResult>,
): { run: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const run: GitRunner = (args, cwd, env) => {
    const call = { args: [...args], cwd, env };
    calls.push(call);
    const respond = responses[i++];
    if (!respond) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: `unexpected git call #${i}: ${args.join(" ")}`,
      });
    }
    return Promise.resolve(respond(call));
  };
  return { run, calls };
}

test("gitEnvironment allow-list never carries credential material", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-env-" });
  try {
    const files = await writeCheckoutCredentialFiles({
      cloneUrl: "https://example.com/o/r.git",
      ref: "main",
      commitSha: SHA,
      scratchDir,
      credential: "super-secret-token",
    });
    const env = gitEnvironment(files, scratchDir);
    assertEquals(
      Object.keys(env).sort((a, b) => a.localeCompare(b)),
      [
        "GIT_ASKPASS",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_SSH_COMMAND",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "PATH",
      ],
    );
    assertEquals(env.HOME, scratchDir);
    assertEquals(env.GIT_TERMINAL_PROMPT, "0");
    assertEquals(env.GIT_CONFIG_NOSYSTEM, "1");
    for (const value of Object.values(env)) {
      assertEquals(value.includes("super-secret-token"), false);
    }
    await removeCheckoutCredentialFiles(files);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("checkoutRelease returns when the shallow clone already matches commitSha", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-ok-" });
  try {
    const { run, calls } = scriptedGit([
      () => ({ success: true, stdout: "", stderr: "" }),
      () => ({ success: true, stdout: SHA, stderr: "" }),
    ]);
    const result = await checkoutRelease({
      cloneUrl: "https://example.com/o/r.git",
      ref: "main",
      commitSha: SHA,
      scratchDir,
      runGit: run,
    });
    assertEquals(result, {
      workingDir: join(scratchDir, "source"),
      commitSha: SHA,
    });
    assertEquals(calls.length, 2);
    assertEquals(calls[0]?.args[0], "clone");
    assertEquals(calls[1]?.args, ["rev-parse", "HEAD"]);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("checkoutRelease fetches and checks out when the branch tip drifted", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-fetch-" });
  try {
    const { run, calls } = scriptedGit([
      () => ({ success: true, stdout: "", stderr: "" }),
      () => ({ success: true, stdout: OTHER_SHA, stderr: "" }),
      () => ({ success: true, stdout: "", stderr: "" }),
      () => ({ success: true, stdout: "", stderr: "" }),
      () => ({ success: true, stdout: SHA, stderr: "" }),
    ]);
    const result = await checkoutRelease({
      cloneUrl: "https://example.com/o/r.git",
      ref: "main",
      commitSha: SHA,
      scratchDir,
      runGit: run,
    });
    assertEquals(result.commitSha, SHA);
    assertEquals(calls[2]?.args, ["fetch", "--depth", "1", "origin", SHA]);
    assertEquals(calls[3]?.args, ["checkout", "--detach", "FETCH_HEAD"]);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("checkoutRelease redacts and throws when clone fails", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-fail-" });
  try {
    const { run } = scriptedGit([
      () => ({
        success: false,
        stdout: "",
        stderr: "fatal: Authentication failed for secret-token",
      }),
    ]);
    await assertRejects(
      () =>
        checkoutRelease({
          cloneUrl: "https://example.com/o/r.git",
          ref: "main",
          commitSha: SHA,
          scratchDir,
          runGit: run,
          redactSummary: (text) => text.replaceAll("secret-token", "***"),
        }),
      Error,
      "***",
    );
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("checkoutRelease unlinks credential files even when clone fails", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-clean-" });
  try {
    let askpassPath: string | null = null;
    const { run } = scriptedGit([
      (_call) => ({
        success: false,
        stdout: "",
        stderr: "clone failed",
      }),
    ]);
    await assertRejects(() =>
      checkoutRelease({
        cloneUrl: "https://example.com/o/r.git",
        ref: "main",
        commitSha: SHA,
        scratchDir,
        credential: "ghs_token",
        runGit: async (args, cwd, env, onOutput) => {
          if (typeof env.GIT_ASKPASS === "string") {
            askpassPath = env.GIT_ASKPASS;
          }
          return await run(args, cwd, env, onOutput);
        },
      })
    );
    if (askpassPath === null) {
      throw new TypeError("expected askpass path to be captured");
    }
    try {
      await Deno.stat(askpassPath);
      throw new TypeError("askpass file should have been removed");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("checkoutRelease throws when the pinned-commit fetch fails", async () => {
  const scratchDir = await Deno.makeTempDir({
    prefix: "tp-checkout-fetchfail-",
  });
  try {
    const { run } = scriptedGit([
      () => ({ success: true, stdout: "", stderr: "" }),
      () => ({ success: true, stdout: OTHER_SHA, stderr: "" }),
      () => ({ success: false, stdout: "", stderr: "object not found" }),
    ]);
    await assertRejects(
      () =>
        checkoutRelease({
          cloneUrl: "https://example.com/o/r.git",
          ref: "main",
          commitSha: SHA,
          scratchDir,
          runGit: run,
        }),
      Error,
      "object not found",
    );
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("SSH gitEnvironment quotes identity and known-hosts paths", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-ssh-env-" });
  try {
    const files = await writeCheckoutCredentialFiles({
      cloneUrl: "git@example.com:o/r.git",
      ref: "main",
      commitSha: SHA,
      scratchDir,
      credential: "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END-----\n",
      credentialKind: "ssh_key",
    });
    const env = gitEnvironment(files, scratchDir);
    assertStringIncludes(env.GIT_SSH_COMMAND, "IdentityAgent=none");
    assertStringIncludes(env.GIT_SSH_COMMAND, "UserKnownHostsFile=");
    assertEquals(files.knownHostsPath !== null, true);
    await removeCheckoutCredentialFiles(files);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});
