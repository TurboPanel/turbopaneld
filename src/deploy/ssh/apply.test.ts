import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import type { RunFn, RunResult } from "../ensure-principal.ts";
import { applySshAccess } from "./apply.ts";
import {
  authorizedKeysContent,
  authorizedKeysPath,
  MAX_KEYS_PER_PRINCIPAL,
} from "./authorized-keys.ts";
import { ALLOWED_SSH_KEY_TYPES, isCanonicalSshPublicKey } from "./key-types.ts";
import {
  sshdAccessRestrictions,
  sshdConfigIncludesDropIns,
  sshdDropInContent,
} from "./sshd-config.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ED25519 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEmvBcjT+NvO6sokGNoJ0zA3dr0nhIQhhZ3wP220uFZ";
const ED25519_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEmvBcjT+NvO6sokGNoJ0zA3dr0nhIQhhZ3wP220uFa";

const INCLUDING_SSHD_CONFIG = [
  "# host config",
  "Include /etc/ssh/sshd_config.d/*.conf",
  "",
  "PermitRootLogin prohibit-password",
  "",
].join("\n");

function ok(stdout = ""): RunResult {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): RunResult {
  return { success: false, stdout: "", stderr };
}

type Host = {
  root: string;
  keysDir: string;
  sshdConfigPath: string;
  dropInPath: string;
  run: RunFn;
  calls: Array<{ command: string; args: string[] }>;
  /** Mode string the last `install` used for a given destination. */
  modes: Map<string, string>;
  /** Set to fail `sshd -t`, as a real host would on a bad config. */
  sshdTestError: string | null;
  reloads: string[];
  cleanup: () => Promise<void>;
};

async function filesMatch(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      Deno.readFile(a),
      Deno.readFile(b),
    ]);
    if (left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
  } catch {
    return false;
  }
}

/**
 * Host-free `sudo` seam. `install`, `cmp`, `cat`, `ls`, `cp`, `mv`, and `rm`
 * are real so the unchanged-content rule and the rollback path are exercised
 * rather than mocked; `sshd -t` and `systemctl` are recorded.
 */
async function makeHost(
  opts: { sshdConfig?: string } = {},
): Promise<Host> {
  const root = await Deno.makeTempDir({ prefix: "tp-ssh-" });
  const keysDir = join(root, "etc/ssh/turbopanel/authorized_keys");
  const sshdConfigPath = join(root, "etc/ssh/sshd_config");
  const dropInPath = join(root, "etc/ssh/sshd_config.d/60-turbopanel.conf");
  await Deno.mkdir(dirname(sshdConfigPath), { recursive: true });
  await Deno.writeTextFile(
    sshdConfigPath,
    opts.sshdConfig ?? INCLUDING_SSHD_CONFIG,
  );

  const host: Host = {
    root,
    keysDir,
    sshdConfigPath,
    dropInPath,
    calls: [],
    modes: new Map(),
    sshdTestError: null,
    reloads: [],
    run: () => Promise.resolve(ok()),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };

  host.run = async (command, args) => {
    host.calls.push({ command, args: [...args] });
    if (command !== "sudo") return ok();
    const rest = args[0] === "-n" ? args.slice(1) : args;
    const [tool, ...tail] = rest;

    if (tool === "sshd") {
      return host.sshdTestError === null ? ok() : fail(host.sshdTestError);
    }
    if (tool === "systemctl") {
      const unit = tail.at(-1) as string;
      // Only Debian's unit name exists on this fake host, so the fallback path
      // is exercised too.
      if (unit !== "ssh.service") return fail(`Unit ${unit} not found.`);
      host.reloads.push(unit);
      return ok();
    }
    if (tool === "cat") {
      try {
        return ok(await Deno.readTextFile(tail.at(-1) as string));
      } catch {
        return fail("No such file or directory");
      }
    }
    if (tool === "ls") {
      try {
        const names: string[] = [];
        for await (const entry of Deno.readDir(tail.at(-1) as string)) {
          names.push(entry.name);
        }
        return ok(names.sort((a, b) => a.localeCompare(b)).join("\n"));
      } catch {
        return fail("No such file or directory");
      }
    }
    if (tool === "cmp") {
      const right = tail.at(-1) as string;
      const left = tail.at(-2) as string;
      return (await filesMatch(left, right)) ? ok() : fail("files differ");
    }
    if (tool === "install" && tail.includes("-d")) {
      await Deno.mkdir(tail.at(-1) as string, { recursive: true });
      return ok();
    }
    if (tool === "install") {
      const dest = tail.at(-1) as string;
      const src = tail.at(-2) as string;
      const modeIndex = tail.indexOf("-m");
      host.modes.set(dest, tail[modeIndex + 1] as string);
      await Deno.mkdir(dirname(dest), { recursive: true });
      await Deno.copyFile(src, dest);
      return ok();
    }
    if (tool === "cp" || tool === "mv") {
      const dest = tail.at(-1) as string;
      const src = tail.at(-2) as string;
      try {
        await Deno.copyFile(src, dest);
        if (tool === "mv") await Deno.remove(src);
        return ok();
      } catch {
        return fail("cp/mv failed");
      }
    }
    if (tool === "rm") {
      try {
        await Deno.remove(tail.at(-1) as string);
      } catch { /* -f */ }
      return ok();
    }
    return ok();
  };

  return host;
}

function apply(host: Host, principals: { username: string; keys: string[] }[]) {
  return applySshAccess(
    principals,
    {
      authorizedKeysDir: host.keysDir,
      sshdConfigPath: host.sshdConfigPath,
      sshdDropInPath: host.dropInPath,
      prune: true,
    },
    host.run,
  );
}

test("a managed account's key file is root-owned 0644 and holds its keys", async () => {
  const host = await makeHost();
  try {
    const result = await apply(host, [
      { username: "appuser", keys: [ED25519, ED25519_B] },
    ]);
    assertEquals(result.changedPrincipals, ["appuser"]);

    const path = authorizedKeysPath("appuser", host.keysDir);
    const contents = await Deno.readTextFile(path);
    assertStringIncludes(contents, ED25519);
    assertStringIncludes(contents, ED25519_B);
    // `sshd` with StrictModes refuses a group- or world-writable key file.
    assertEquals(host.modes.get(path), "0644");

    const mkdir = host.calls.find((call) =>
      call.args.includes("install") && call.args.includes("-d") &&
      call.args.at(-1) === host.keysDir
    );
    assert(mkdir);
    assertEquals(mkdir.args[mkdir.args.indexOf("-m") + 1], "0750");

    const install = host.calls.find((call) =>
      call.args.includes("install") && call.args.at(-1) === path
    );
    assert(install);
    assertEquals(install.args[install.args.indexOf("-o") + 1], "root");
    assertEquals(install.args[install.args.indexOf("-g") + 1], "root");
  } finally {
    await host.cleanup();
  }
});

test("an account with no keys gets an empty file, not a missing one", async () => {
  const host = await makeHost();
  try {
    await apply(host, [{ username: "appuser", keys: [] }]);
    const contents = await Deno.readTextFile(
      authorizedKeysPath("appuser", host.keysDir),
    );
    // Distinguishable from "never touched": a revocation that ran leaves a file
    // behind saying so.
    assertStringIncludes(contents, "Managed by TurboPanel");
    assertEquals(
      contents.split("\n").filter((line) =>
        line.length > 0 && !line.startsWith("#")
      ),
      [],
    );
  } finally {
    await host.cleanup();
  }
});

test("an account dropped from the payload has its key file removed", async () => {
  const host = await makeHost();
  try {
    await apply(host, [
      { username: "appuser", keys: [ED25519] },
      { username: "olduser", keys: [ED25519] },
    ]);
    const result = await apply(host, [{
      username: "appuser",
      keys: [ED25519],
    }]);

    assertEquals(result.removedPrincipals, ["olduser"]);
    await Deno.stat(authorizedKeysPath("appuser", host.keysDir));
    await assertRejects(() =>
      Deno.stat(authorizedKeysPath("olduser", host.keysDir))
    );
  } finally {
    await host.cleanup();
  }
});

test("a file in the managed directory that is not a username is left alone", async () => {
  const host = await makeHost();
  try {
    await apply(host, [{ username: "appuser", keys: [ED25519] }]);
    const stray = join(host.keysDir, "notes.txt");
    await Deno.writeTextFile(stray, "keep me");

    const result = await apply(host, [{
      username: "appuser",
      keys: [ED25519],
    }]);
    assertEquals(result.removedPrincipals, []);
    assertEquals(await Deno.readTextFile(stray), "keep me");
  } finally {
    await host.cleanup();
  }
});

test("an unchanged payload rewrites nothing and does not reload sshd", async () => {
  const host = await makeHost();
  try {
    await apply(host, [{ username: "appuser", keys: [ED25519] }]);
    host.reloads.length = 0;
    const second = await apply(host, [{
      username: "appuser",
      keys: [ED25519],
    }]);

    assertEquals(second.changedPrincipals, []);
    assertEquals(second.sshdReloaded, false);
    // A routine deploy must not touch the host's SSH daemon at all.
    assertEquals(host.reloads, []);
  } finally {
    await host.cleanup();
  }
});

test("the drop-in ends with `Match all`", async () => {
  const host = await makeHost();
  try {
    await apply(host, [{ username: "appuser", keys: [ED25519] }]);
    const contents = await Deno.readTextFile(host.dropInPath);

    // Debian includes the drop-in dir at the TOP of sshd_config, inline. A
    // Match block that runs to end-of-file therefore swallows every global
    // directive below the Include line in the administrator's own config.
    const directives = contents.split("\n").map((line) => line.trim()).filter(
      (line) => line.length > 0 && !line.startsWith("#"),
    );
    assertEquals(directives.at(-1), "Match all");
  } finally {
    await host.cleanup();
  }
});

test("the drop-in sets no global directive before its first Match", () => {
  const contents = sshdDropInContent({
    sftpGroup: "tpsftp",
    shellGroup: "tpshell",
  });
  const directives = contents.split("\n").map((line) => line.trim()).filter(
    (line) => line.length > 0 && !line.startsWith("#"),
  );
  // With the include at the top of sshd_config, `sshd` takes the first
  // occurrence of most keywords — so a global here would override the
  // administrator's own value for the entire host.
  assert(directives[0].startsWith("Match Group "));
});

test("sshd reloads only when the drop-in changed, and never restarts", async () => {
  const host = await makeHost();
  try {
    const result = await apply(host, [{
      username: "appuser",
      keys: [ED25519],
    }]);
    assertEquals(result.sshdReloaded, true);
    // A restart would evict the operator watching it happen; a reload leaves
    // established sessions alive.
    assertEquals(host.reloads, ["ssh.service"]);
    assert(
      !host.calls.some((call) => call.args.includes("restart")),
      "sshd must never be restarted",
    );
  } finally {
    await host.cleanup();
  }
});

test("a config sshd refuses is rolled back and never reloaded", async () => {
  const host = await makeHost();
  try {
    // Land a known-good drop-in first, so there is a previous state to restore.
    await apply(host, [{ username: "appuser", keys: [ED25519] }]);
    const good = await Deno.readTextFile(host.dropInPath);
    host.reloads.length = 0;

    // Force the next config test to fail, and make the rendered bytes genuinely
    // differ (a different key directory moves `AuthorizedKeysFile`) so the swap
    // is actually attempted rather than skipped by the unchanged-content rule.
    host.sshdTestError = "line 12: Bad configuration option";
    const error = await assertRejects(() =>
      applySshAccess(
        [{ username: "appuser", keys: [ED25519] }],
        {
          authorizedKeysDir: join(host.root, "etc/ssh/turbopanel/moved"),
          sshdConfigPath: host.sshdConfigPath,
          sshdDropInPath: host.dropInPath,
        },
        host.run,
      )
    );
    assertStringIncludes(String(error), "rolled back");
    assertStringIncludes(String(error), "Bad configuration option");

    // The host is exactly as it was, and nothing was reloaded — a rejected
    // config left in place would break the next `systemctl reload ssh` by
    // anyone, for any reason.
    assertEquals(await Deno.readTextFile(host.dropInPath), good);
    assertEquals(host.reloads, []);
  } finally {
    await host.cleanup();
  }
});

test("a refused first-ever config leaves no drop-in behind", async () => {
  const host = await makeHost();
  try {
    host.sshdTestError = "Bad configuration option";
    await assertRejects(() =>
      apply(host, [{ username: "appuser", keys: [ED25519] }])
    );
    await assertRejects(() => Deno.stat(host.dropInPath));
    assertEquals(host.reloads, []);
  } finally {
    await host.cleanup();
  }
});

test("a host with no Include line fails without editing sshd_config", async () => {
  const original = ["# host config", "PermitRootLogin no", ""].join("\n");
  const host = await makeHost({ sshdConfig: original });
  try {
    const error = await assertRejects(() =>
      apply(host, [{ username: "appuser", keys: [ED25519] }])
    );
    assertStringIncludes(String(error), "does not include");
    assertStringIncludes(String(error), "Include /");

    // Editing an administrator's sshd_config so our own file starts taking
    // effect is not a move a hosting panel makes silently.
    assertEquals(await Deno.readTextFile(host.sshdConfigPath), original);
    await assertRejects(() => Deno.stat(host.dropInPath));
  } finally {
    await host.cleanup();
  }
});

test("keys are still reconciled on a host that cannot include the drop-in", async () => {
  const host = await makeHost({ sshdConfig: "PermitRootLogin no\n" });
  try {
    await assertRejects(() =>
      apply(host, [{ username: "appuser", keys: [ED25519] }])
    );
    // Correct-but-unconsulted keys is a better state to leave behind than
    // neither half done.
    assertStringIncludes(
      await Deno.readTextFile(authorizedKeysPath("appuser", host.keysDir)),
      ED25519,
    );
  } finally {
    await host.cleanup();
  }
});

test("AllowUsers is reported, not worked around", async () => {
  const host = await makeHost({
    sshdConfig: [
      "Include /etc/ssh/sshd_config.d/*.conf",
      "AllowUsers admin deploy",
      "",
    ].join("\n"),
  });
  try {
    const result = await apply(host, [{
      username: "appuser",
      keys: [ED25519],
    }]);
    assertEquals(result.warnings.length, 1);
    assertStringIncludes(result.warnings[0], "allowusers");
    assertStringIncludes(result.warnings[0], "before any Match block");
    // The reconcile still completes: the warning is the whole remedy available.
    assertEquals(result.sshdReloaded, true);
  } finally {
    await host.cleanup();
  }
});

test("a non-canonical key fails the reconcile instead of being dropped", async () => {
  const host = await makeHost();
  try {
    await assertRejects(
      () =>
        apply(host, [
          { username: "appuser", keys: [`${ED25519} trailing-comment`] },
        ]),
      Error,
      "canonical",
    );
  } finally {
    await host.cleanup();
  }
});

test("the daemon refuses a key file for a username it could not have written", async () => {
  const host = await makeHost();
  try {
    await assertRejects(
      () => apply(host, [{ username: "../../root", keys: [ED25519] }]),
      Error,
      "Invalid principal username",
    );
  } finally {
    await host.cleanup();
  }
});

test("duplicate keys collapse to one line", () => {
  const contents = authorizedKeysContent([ED25519, ED25519]);
  const keyLines = contents.split("\n").filter((line) =>
    line.startsWith("ssh-")
  );
  assertEquals(keyLines, [ED25519]);
});

test("an absurd key count is refused", () => {
  const keys = Array.from(
    { length: MAX_KEYS_PER_PRINCIPAL + 1 },
    () => ED25519,
  );
  let threw = false;
  try {
    authorizedKeysContent(keys);
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "too many keys");
  }
  assert(threw);
});

test("the rejection message never echoes the key", () => {
  let message = "";
  try {
    authorizedKeysContent(['ssh-ed25519 AAAA command="rm -rf /"']);
  } catch (err) {
    message = String(err);
  }
  // This runs on a rejected credential and the message reaches a transcript.
  assert(!message.includes("rm -rf"));
  assertStringIncludes(message, "canonical");
});

test("sshdConfigIncludesDropIns ignores an Include below a Match", () => {
  assert(sshdConfigIncludesDropIns("Include /etc/ssh/sshd_config.d/*.conf\n"));
  assert(sshdConfigIncludesDropIns("Include /etc/ssh/sshd_config.d/*\n"));
  assert(
    !sshdConfigIncludesDropIns("#Include /etc/ssh/sshd_config.d/*.conf\n"),
  );
  assert(!sshdConfigIncludesDropIns("Include /etc/ssh/other/*.conf\n"));
  // Below a Match the include is itself conditional, so our blocks would only
  // apply to whoever that Match selected.
  assert(
    !sshdConfigIncludesDropIns(
      "Match User bob\nInclude /etc/ssh/sshd_config.d/*.conf\n",
    ),
  );
});

test("sshdAccessRestrictions finds each directive once", () => {
  assertEquals(
    sshdAccessRestrictions("AllowGroups a\nDenyUsers b\nAllowGroups c\n"),
    ["allowgroups", "denyusers"],
  );
  assertEquals(sshdAccessRestrictions("# AllowUsers admin\n"), []);
});

test("the wire validator and the file renderer agree on canonical form", async () => {
  // `contracts.ts` is a zero-import leaf, so its regex is a mirror of
  // `key-types.ts` rather than an import. This is what keeps the two gates from
  // drifting into disagreeing about what a canonical key is — a drift where the
  // wire is looser than the file turns a rejected credential into a failed
  // deploy at the worst moment.
  const contracts = await Deno.readTextFile(
    new URL("../../instance/commands/contracts.ts", import.meta.url),
  );
  const mirrored = /const CANONICAL_SSH_KEY_RE =\s*\/\^\(\?:([^)]+)\)/.exec(
    contracts,
  );
  assert(mirrored, "contracts.ts must declare CANONICAL_SSH_KEY_RE");
  const wireTypes = mirrored[1].split("|").map((type) =>
    type.replaceAll("\\.", ".")
  );
  assertEquals(wireTypes, [...ALLOWED_SSH_KEY_TYPES]);
});

test("isCanonicalSshPublicKey accepts every allowed type and nothing structural", () => {
  for (const type of ALLOWED_SSH_KEY_TYPES) {
    assert(isCanonicalSshPublicKey(`${type} AAAAB3Nz`), type);
  }
  assert(!isCanonicalSshPublicKey(`${ED25519} comment`));
  assert(!isCanonicalSshPublicKey(`command="x" ${ED25519}`));
  assert(!isCanonicalSshPublicKey(`${ED25519}\nssh-rsa AAAA`));
  assert(!isCanonicalSshPublicKey("ssh-dss AAAAB3Nz"));
});

test("a deploy never prunes another environment's key files", async () => {
  const host = await makeHost();
  try {
    await apply(host, [
      { username: "appuser", keys: [ED25519] },
      { username: "otherenv", keys: [ED25519] },
    ]);

    // `environment.deploy` carries ONE environment's principals; a host serves
    // many. Pruning from that set would delete the key files of every other
    // environment on the box.
    const result = await applySshAccess(
      [{ username: "appuser", keys: [ED25519] }],
      {
        authorizedKeysDir: host.keysDir,
        sshdConfigPath: host.sshdConfigPath,
        sshdDropInPath: host.dropInPath,
      },
      host.run,
    );

    assertEquals(result.removedPrincipals, []);
    assertStringIncludes(
      await Deno.readTextFile(authorizedKeysPath("otherenv", host.keysDir)),
      ED25519,
    );
  } finally {
    await host.cleanup();
  }
});

test("prune defaults off", async () => {
  const host = await makeHost();
  try {
    await apply(host, [{ username: "gone", keys: [ED25519] }]);
    const result = await applySshAccess(
      [],
      {
        authorizedKeysDir: host.keysDir,
        sshdConfigPath: host.sshdConfigPath,
        sshdDropInPath: host.dropInPath,
      },
      host.run,
    );
    assertEquals(result.removedPrincipals, []);
    await Deno.stat(authorizedKeysPath("gone", host.keysDir));
  } finally {
    await host.cleanup();
  }
});
