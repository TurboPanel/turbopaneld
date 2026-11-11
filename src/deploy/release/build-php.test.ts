import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  buildEnvironment,
  isReservedBuildEnvKey,
  type NativeBuildRuntime,
  PHP_DEPENDENCY_INSTALL_COMMAND,
  runReleaseBuild,
  sandboxBuildEnvironment,
} from "./build.ts";
import type { BuildWork } from "./build-sandbox.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const RUNTIME: NativeBuildRuntime = {
  nodeBinDir: "/opt/turbopanel/vendor/node-app/24/current/bin",
  nodeEnv: "production",
  php: {
    series: "8.4",
    composerBinDir: "/opt/turbopanel/vendor/composer/current/bin",
  },
};

const WORK: BuildWork = {
  buildId: "b1",
  projectKey: "p1",
  owner: "alice",
  workDir: "/srv/work/b1",
  checkoutDir: "/srv/work/b1/source",
  cacheDir: "/srv/caches/alice/p1",
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-php-build-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("a PHP site's build puts the package manager on PATH after Node and pins its series and folders", () => {
  const env = buildEnvironment({ kind: "native" }, "/work", RUNTIME);
  assertEquals(
    env.PATH,
    `${RUNTIME.nodeBinDir}:${RUNTIME.php?.composerBinDir}:/usr/local/bin:/usr/bin:/bin`,
  );
  assertEquals(env.TURBOPANEL_PHP, "8.4");
  assertEquals(env.COMPOSER_CACHE_DIR, "/work/.composer-cache");
  assertEquals(env.COMPOSER_HOME, "/work/.composer-home");
  assertEquals(env.COMPOSER_NO_INTERACTION, "1");
});

test("a sandboxed PHP build caches per account and project and keeps its home out of the checkout", () => {
  const env = sandboxBuildEnvironment({ kind: "native" }, WORK, RUNTIME);
  assertEquals(env.COMPOSER_CACHE_DIR, "/srv/caches/alice/p1/composer");
  assertEquals(env.COMPOSER_HOME, "/srv/work/b1/.composer-home");
  assertEquals(env.TURBOPANEL_PHP, "8.4");
  assert(env.PATH?.startsWith(RUNTIME.nodeBinDir));
  // Without PHP nothing changes.
  const plain = sandboxBuildEnvironment({ kind: "native" }, WORK, {
    nodeBinDir: RUNTIME.nodeBinDir,
    nodeEnv: "production",
  });
  assertEquals(plain.TURBOPANEL_PHP, undefined);
  assertEquals(plain.PATH, `${RUNTIME.nodeBinDir}:/usr/bin:/bin`);
});

test("the package manager's folders, series and credentials are never build variables", () => {
  for (
    const name of [
      "COMPOSER_HOME",
      "COMPOSER_CACHE_DIR",
      "COMPOSER_AUTH",
      "TURBOPANEL_PHP",
    ]
  ) {
    assert(isReservedBuildEnvKey(name), name);
  }
  const env = buildEnvironment(
    {
      kind: "native",
      env: {
        COMPOSER_AUTH: '{"github-oauth":{}}',
        COMPOSER_HOME: "/evil",
        TURBOPANEL_PHP: "7.4",
        COMPOSER_MEMORY_LIMIT: "-1",
      },
    },
    "/work",
    RUNTIME,
  );
  assertEquals(env.COMPOSER_AUTH, undefined);
  assertEquals(env.COMPOSER_HOME, "/work/.composer-home");
  assertEquals(env.TURBOPANEL_PHP, "8.4");
  assertEquals(env.COMPOSER_MEMORY_LIMIT, "-1");
});

test("composer.json derives the PHP dependency install, and it runs before everything else", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "composer.json"), "{}");
    await Deno.writeTextFile(join(dir, "composer.lock"), "{}");
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    await Deno.writeTextFile(join(dir, "package-lock.json"), "{}");
    const ran: string[] = [];
    const lines: string[] = [];
    await runReleaseBuild({
      build: { kind: "native", buildCommand: "npm run build" },
      workingDir: dir,
      nativeRuntime: RUNTIME,
      phpCliExists: () => Promise.resolve(true),
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran[0], PHP_DEPENDENCY_INSTALL_COMMAND);
    assertEquals(ran.length, 3);
    assertEquals(ran.at(-1), "npm run build");
    assert(PHP_DEPENDENCY_INSTALL_COMMAND.includes("--no-dev"));
    assert(PHP_DEPENDENCY_INSTALL_COMMAND.includes("--optimize-autoloader"));
    assertEquals(
      PHP_DEPENDENCY_INSTALL_COMMAND.includes("--no-scripts"),
      false,
    );
    assert(lines.includes("derived PHP dependency install from composer.json"));
    assertEquals(
      lines.some((line) => line.includes("composer.lock is missing")),
      false,
    );
  });
});

test("a missing lock file is said once and the install is still derived", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "composer.json"), "{}");
    const lines: string[] = [];
    const ran: string[] = [];
    await runReleaseBuild({
      build: { kind: "native" },
      workingDir: dir,
      nativeRuntime: RUNTIME,
      phpCliExists: () => Promise.resolve(true),
      runCommand: (command) => {
        ran.push(command);
        return Promise.resolve();
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(ran, [PHP_DEPENDENCY_INSTALL_COMMAND]);
    assert(
      lines.includes(
        "composer.lock is missing: dependencies are resolved fresh on every build",
      ),
    );
  });
});

test("nothing is derived without composer.json, for a link of that name, or when the author runs it", async () => {
  await withDir(async (dir) => {
    const run = async (build: { installCommand?: string }) => {
      const ran: string[] = [];
      await runReleaseBuild({
        build: { kind: "native", ...build },
        workingDir: dir,
        nativeRuntime: RUNTIME,
        phpCliExists: () => Promise.resolve(true),
        runCommand: (command) => {
          ran.push(command);
          return Promise.resolve();
        },
      });
      return ran;
    };
    assertEquals(await run({}), []);
    await Deno.symlink("/etc/passwd", join(dir, "composer.json"));
    assertEquals(await run({}), []);
    await Deno.remove(join(dir, "composer.json"));
    await Deno.writeTextFile(join(dir, "composer.json"), "{}");
    assertEquals(
      await run({ installCommand: "composer install --no-dev" }),
      ["composer install --no-dev"],
    );
  });
});

test("a series with no command-line PHP stops the build with the way out", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "composer.json"), "{}");
    const error = await assertRejects(() =>
      runReleaseBuild({
        build: { kind: "native" },
        workingDir: dir,
        nativeRuntime: RUNTIME,
        serviceName: "web",
        phpCliExists: () => Promise.resolve(false),
        runCommand: () => Promise.resolve(),
      })
    );
    assertEquals(
      (error as Error).message,
      "site web: PHP 8.4 has no command-line PHP on this server, so its PHP dependencies cannot be installed. Use the FastCGI or PHP-FPM mode for this site.",
    );
  });
});

test("a failed PHP install adds one line after the failure, in either runner", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "composer.json"), "{}");
    const lines: string[] = [];
    await assertRejects(() =>
      runReleaseBuild({
        build: { kind: "native" },
        workingDir: dir,
        nativeRuntime: RUNTIME,
        phpCliExists: () => Promise.resolve(true),
        runCommand: () => Promise.reject(new Error("exit 2")),
        onOutput: (_stream, line) => lines.push(line),
      })
    );
    const hint =
      "PHP dependency install failed. A missing PHP extension can be turned on in the site's PHP settings; packages from private repositories are not supported yet.";
    assertEquals(lines.at(-1), hint);

    const sandboxLines: string[] = [];
    await assertRejects(() =>
      runReleaseBuild({
        build: { kind: "native" },
        workingDir: dir,
        nativeRuntime: RUNTIME,
        phpCliExists: () => Promise.resolve(true),
        sandbox: {
          work: WORK,
          cwd: "source",
          run: () =>
            Promise.reject(
              new Error("tp-build-runner: step 1 of 1 failed (exit 2)"),
            ),
        },
        onOutput: (_stream, line) => sandboxLines.push(line),
      })
    );
    assertEquals(sandboxLines.at(-1), hint);

    // A later step failing is not the PHP install's fault.
    const later: string[] = [];
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    await assertRejects(() =>
      runReleaseBuild({
        build: { kind: "native", buildCommand: "npm run build" },
        workingDir: dir,
        nativeRuntime: RUNTIME,
        phpCliExists: () => Promise.resolve(true),
        sandbox: {
          work: WORK,
          cwd: "source",
          run: () =>
            Promise.reject(
              new Error("tp-build-runner: step 3 of 3 failed (exit 1)"),
            ),
        },
        onOutput: (_stream, line) => later.push(line),
      })
    );
    assertEquals(later.includes(hint), false);
  });
});
