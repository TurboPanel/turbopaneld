import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import {
  createSymlink,
  installVendorExecutable,
  VENDOR_BINARY_MODE,
} from "./scoped-writes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "../..");

test("installVendorExecutable copies the file and marks it executable", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const source = join(dir, "downloaded");
    const dest = join(dir, "bin", "tool");
    await Deno.writeTextFile(source, "#!/bin/sh\necho hello\n");
    await Deno.chmod(source, 0o600);
    await Deno.mkdir(join(dir, "bin"));

    await installVendorExecutable(source, dest);

    assertEquals(await Deno.readTextFile(dest), "#!/bin/sh\necho hello\n");
    const mode = (await Deno.stat(dest)).mode ?? 0;
    assertEquals(
      (mode & 0o777).toString(8).padStart(4, "0"),
      VENDOR_BINARY_MODE,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("installVendorExecutable replaces an existing binary", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const source = join(dir, "downloaded");
    const dest = join(dir, "tool");
    await Deno.writeTextFile(dest, "old");
    await Deno.writeTextFile(source, "new");

    await installVendorExecutable(source, dest);

    assertEquals(await Deno.readTextFile(dest), "new");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("installVendorExecutable reports the failing program and the destination", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const dest = join(dir, "tool");
    let message = "";
    try {
      await installVendorExecutable(join(dir, "missing"), dest);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, `Failed to install ${dest}`);
    assertStringIncludes(message, "cp exited");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * The production regression this module exists for.
 *
 * Deno refuses every write to a path in `--allow-run`, so the compiled daemon
 * — which is also the installer — cannot put uv, uvx, or cloudflared in place
 * with `Deno.copyFile` / `writeFile` / `chmod` even though their parent dirs
 * are in `--allow-write`. The canary install failed exactly here with
 * `Requires write access to "/opt/turbopanel/vendor/uv/0.11.21/uv"`.
 *
 * Child processes reproduce the production grant shape: the same scoped
 * write root, with and without the destination on the run allowlist.
 */
async function runChild(
  dir: string,
  runGrant: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const source = join(dir, "downloaded");
  const dest = join(dir, "bin", "tool");
  await Deno.writeTextFile(source, "payload");
  await Deno.mkdir(join(dir, "bin"), { recursive: true });

  const script = join(dir, "child.ts");
  await Deno.writeTextFile(
    script,
    `import { installVendorExecutable } from ${
      JSON.stringify(
        toFileUrl(join(repoRoot, "src/permissions/scoped-writes.ts")).href,
      )
    };
const [source, dest] = Deno.args;
try {
  await Deno.copyFile(source, dest);
  console.log("DENO_WRITE_ALLOWED");
} catch (err) {
  console.log(
    err instanceof Deno.errors.NotCapable
      ? "DENO_WRITE_REFUSED"
      : \`DENO_WRITE_UNEXPECTED:\${err}\`,
  );
}
await installVendorExecutable(source, dest);
console.log("SUBPROCESS_INSTALL_OK");
`,
  );

  // clearEnv keeps LD_*/DYLD_* out of the child: Deno 2.9 refuses a scoped
  // `--allow-run` spawn that would inherit them, and CI exports
  // LD_LIBRARY_PATH before the suite runs.
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      join(repoRoot, "deno.json"),
      `--allow-read=${dir},${repoRoot}`,
      `--allow-write=${dir}`,
      `--allow-run=${runGrant}`,
      "--allow-env",
      script,
      source,
      dest,
    ],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: Deno.env.get("HOME") ?? dir,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    code: output.code,
  };
}

test("Deno refuses its own writes to a path on the run allowlist, and the helper installs it anyway", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const dest = join(dir, "bin", "tool");
    const result = await runChild(dir, `${dest},cp,chmod`);
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stdout, "DENO_WRITE_REFUSED");
    assertStringIncludes(result.stdout, "SUBPROCESS_INSTALL_OK");
    assertEquals(await Deno.readTextFile(dest), "payload");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("the same write is allowed when the destination is not a run target", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const result = await runChild(dir, "cp,chmod");
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stdout, "DENO_WRITE_ALLOWED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("createSymlink points a fresh link at its target", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const target = join(dir, "1.2.3");
    const link = join(dir, "current");
    await Deno.mkdir(target);

    await createSymlink(target, link);

    assertEquals(await Deno.readLink(link), target);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("createSymlink repoints an existing link instead of nesting inside it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const old = join(dir, "1.2.3");
    const next = join(dir, "1.2.4");
    const link = join(dir, "current");
    await Deno.mkdir(old);
    await Deno.mkdir(next);
    await createSymlink(old, link);

    await createSymlink(next, link);

    // Without `ln -n` this would land at `<old>/1.2.4`, leaving `current`
    // pointing at the stale version.
    assertEquals(await Deno.readLink(link), next);
    assertEquals(await directoryExists(join(old, "1.2.4")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("createSymlink reports the failing program and the link path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const link = join(dir, "missing-parent", "current");
    let message = "";
    try {
      await createSymlink(join(dir, "target"), link);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, `Failed to install ${link}`);
    assertStringIncludes(message, "ln exited");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * The second production regression, found while verifying the first.
 *
 * `Deno.symlink()` refuses **path-scoped** read/write grants outright — a
 * link's target is only resolved when the link is traversed, so no scoped
 * grant can cover it. Every `current` symlink under the vendor tree was
 * therefore skipped on the compiled daemon, with only a warning to show for
 * it, no matter how wide `--allow-write` was.
 */
test("Deno.symlink is refused under scoped grants, and the helper links it anyway", async () => {
  const dir = await Deno.makeTempDir({ prefix: "turbopanel-scoped-writes-" });
  try {
    const target = join(dir, "1.2.3");
    const link = join(dir, "current");
    await Deno.mkdir(target);

    const script = join(dir, "child.ts");
    await Deno.writeTextFile(
      script,
      `import { createSymlink } from ${
        JSON.stringify(
          toFileUrl(join(repoRoot, "src/permissions/scoped-writes.ts")).href,
        )
      };
const [target, link] = Deno.args;
try {
  await Deno.symlink(target, link, { type: "dir" });
  console.log("DENO_SYMLINK_ALLOWED");
} catch (err) {
  console.log(
    err instanceof Deno.errors.NotCapable
      ? "DENO_SYMLINK_REFUSED"
      : \`DENO_SYMLINK_UNEXPECTED:\${err}\`,
  );
}
await createSymlink(target, link);
console.log("SUBPROCESS_LINK_OK");
`,
    );

    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        join(repoRoot, "deno.json"),
        `--allow-read=${dir},${repoRoot}`,
        // Deliberately the widest *scoped* write grant that still covers the
        // link: the refusal is about scoping, not about reach.
        `--allow-write=${dir}`,
        "--allow-run=ln",
        "--allow-env",
        script,
        target,
        link,
      ],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: Deno.env.get("HOME") ?? dir,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    const stdout = decoder.decode(output.stdout);

    assertEquals(output.code, 0, decoder.decode(output.stderr));
    assertStringIncludes(stdout, "DENO_SYMLINK_REFUSED");
    assertStringIncludes(stdout, "SUBPROCESS_LINK_OK");
    assertEquals(await Deno.readLink(link), target);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * The whole daemon runs on the compiled binary's scoped grants, so a new
 * `Deno.symlink` call anywhere in `src/` cannot succeed on a managed host —
 * it only warns at install time (orchestration) or throws mid-deploy
 * (release promote), and neither shows up until a real install runs.
 */
test("no production source creates a symlink with Deno.symlink", async () => {
  const srcDir = join(repoRoot, "src");
  const offenders: string[] = [];
  for await (const path of walkTypeScript(srcDir)) {
    if (path.endsWith(".test.ts")) continue;
    // The module that documents and replaces the call.
    if (path === join(srcDir, "scoped-writes.ts")) continue;
    const source = await Deno.readTextFile(path);
    if (callsDenoSymlink(source)) {
      offenders.push(path.slice(repoRoot.length + 1));
    }
  }
  assertEquals(
    offenders,
    [],
    `Deno.symlink() is refused under the compiled daemon's path-scoped ` +
      `grants, so these calls are dead on every managed host — use ` +
      `createSymlink from src/permissions/scoped-writes.ts in: ${
        offenders.join(", ")
      }`,
  );
});

/** Prose that names the API — as this file and its callers do — is not a call. */
function callsDenoSymlink(source: string): boolean {
  return source.split("\n").some((line) => {
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    return code.includes("Deno.symlink(");
  });
}

async function* walkTypeScript(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      yield* walkTypeScript(path);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}
