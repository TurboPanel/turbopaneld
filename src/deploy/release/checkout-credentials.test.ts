import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_HTTPS_CREDENTIAL_USERNAME,
  gitEnvironment,
  isSshCloneUrl,
  removeCheckoutCredentialFiles,
  resolveCredentialKind,
  resolveCredentialUsername,
  writeCheckoutCredentialFiles,
} from "./checkout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SSH_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END-----";

test("isSshCloneUrl recognizes both SSH clone forms", () => {
  assertEquals(isSshCloneUrl("ssh://git@example.com/owner/repo.git"), true);
  assertEquals(isSshCloneUrl("git@example.com:owner/repo.git"), true);
  assertEquals(isSshCloneUrl("https://example.com/owner/repo.git"), false);
});

test("resolveCredentialKind honors the wire field, else the transport", () => {
  assertEquals(
    resolveCredentialKind({ cloneUrl: "git@example.com:o/r.git" }),
    "ssh_key",
  );
  assertEquals(
    resolveCredentialKind({ cloneUrl: "https://example.com/o/r.git" }),
    "token",
  );
  assertEquals(
    resolveCredentialKind({
      cloneUrl: "https://example.com/o/r.git",
      credentialKind: "ssh_key",
    }),
    "ssh_key",
  );
});

test("an ssh_key credential becomes a 0600 identity file, never an askpass helper", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-ssh-" });
  try {
    const files = await writeCheckoutCredentialFiles({
      cloneUrl: "ssh://git@example.com/owner/repo.git",
      ref: "main",
      commitSha: "0".repeat(40),
      scratchDir,
      credential: SSH_KEY,
    });
    assertEquals(files.askpassPath, null);
    assertEquals(files.sshKeyPath !== null, true);
    if (!files.sshKeyPath) return;

    const stat = await Deno.stat(files.sshKeyPath);
    assertEquals((stat.mode ?? 0) & 0o777, 0o600);
    // OpenSSH rejects a key whose final line is unterminated.
    const written = await Deno.readTextFile(files.sshKeyPath);
    assertEquals(written, `${SSH_KEY}\n`);

    const env = gitEnvironment(files, scratchDir);
    assertEquals(env.GIT_ASKPASS, undefined);
    assertStringIncludes(env.GIT_SSH_COMMAND, `-i '${files.sshKeyPath}'`);
    assertStringIncludes(env.GIT_SSH_COMMAND, "IdentitiesOnly=yes");
    assertStringIncludes(env.GIT_SSH_COMMAND, "BatchMode=yes");
    // The key material itself never reaches the environment.
    for (const value of Object.values(env)) {
      assertEquals(value.includes("BEGIN OPENSSH"), false);
    }

    await removeCheckoutCredentialFiles(files);
    assertEquals(await pathExists(files.sshKeyPath), false);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("a token credential still goes through the askpass helper", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-token-" });
  try {
    const files = await writeCheckoutCredentialFiles({
      cloneUrl: "https://example.com/owner/repo.git",
      ref: "main",
      commitSha: "0".repeat(40),
      scratchDir,
      credential: "ghs_token",
    });
    assertEquals(files.sshKeyPath, null);
    assertEquals(files.askpassPath !== null, true);
    if (!files.askpassPath) return;

    const env = gitEnvironment(files, scratchDir);
    assertEquals(env.GIT_ASKPASS, files.askpassPath);
    assertEquals(env.GIT_SSH_COMMAND.includes("-i "), false);
    for (const value of Object.values(env)) {
      assertEquals(value.includes("ghs_token"), false);
    }

    await removeCheckoutCredentialFiles(files);
    assertEquals(await pathExists(files.askpassPath), false);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("resolveCredentialUsername honors the payload, else the HTTPS default", () => {
  assertEquals(
    resolveCredentialUsername({}),
    DEFAULT_HTTPS_CREDENTIAL_USERNAME,
  );
  assertEquals(
    resolveCredentialUsername({ credentialUsername: "" }),
    DEFAULT_HTTPS_CREDENTIAL_USERNAME,
  );
  assertEquals(
    resolveCredentialUsername({ credentialUsername: "oauth2" }),
    "oauth2",
  );
});

test("the askpass helper answers with the payload's username, not a hardcoded one", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-user-" });
  try {
    const files = await writeCheckoutCredentialFiles({
      cloneUrl: "https://example.com/owner/repo.git",
      ref: "main",
      commitSha: "0".repeat(40),
      scratchDir,
      credential: "glpat_token",
      credentialUsername: "oauth2",
    });
    if (!files.askpassPath) throw new TypeError("expected an askpass helper");

    const script = await Deno.readTextFile(files.askpassPath);
    assertStringIncludes(script, "Username*) printf '%s' 'oauth2'");
    // The default must not leak in alongside the payload's answer.
    assertEquals(script.includes(DEFAULT_HTTPS_CREDENTIAL_USERNAME), false);

    await removeCheckoutCredentialFiles(files);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("a token payload naming no username keeps the pre-existing default", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-default-" });
  try {
    const files = await writeCheckoutCredentialFiles({
      cloneUrl: "https://example.com/owner/repo.git",
      ref: "main",
      commitSha: "0".repeat(40),
      scratchDir,
      credential: "ghs_token",
    });
    if (!files.askpassPath) throw new TypeError("expected an askpass helper");

    const script = await Deno.readTextFile(files.askpassPath);
    assertStringIncludes(
      script,
      `Username*) printf '%s' '${DEFAULT_HTTPS_CREDENTIAL_USERNAME}'`,
    );

    await removeCheckoutCredentialFiles(files);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

test("no credential materializes no files at all", async () => {
  const scratchDir = await Deno.makeTempDir({ prefix: "tp-checkout-none-" });
  try {
    const files = await writeCheckoutCredentialFiles({
      cloneUrl: "https://example.com/owner/repo.git",
      ref: "main",
      commitSha: "0".repeat(40),
      scratchDir,
    });
    assertEquals(files, {
      askpassPath: null,
      sshKeyPath: null,
      knownHostsPath: null,
    });
    assertEquals(gitEnvironment(files, scratchDir).GIT_ASKPASS, undefined);
  } finally {
    await Deno.remove(scratchDir, { recursive: true });
  }
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
