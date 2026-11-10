/**
 * Root's daemon build floor in run.sh: a signed manifest older than the build
 * root last installed is refused before anything is downloaded, whoever asked
 * for it (the daemon account included, through tp-orchestrate). The shell
 * comparison must agree with the daemon's own `isRollback`.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  extractShellFunction,
  RUN_SH_PATH,
} from "../testing/run-sh-manifest-verifier.ts";
import { isRollback, type TargetBuild } from "./freshness.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const FLOOR_FUNCTIONS = [
  "tp_semver_base",
  "tp_decimal_cmp",
  "tp_epoch_ms",
  "tp_daemon_build_older",
  "tp_floor_field",
  "tp_read_daemon_build_floor",
  "tp_check_daemon_build_floor",
  "tp_write_daemon_build_floor",
];

async function floorScript(): Promise<string> {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  return [
    "tp_print_styled_line() { printf '%s\\n' \"$2\"; }",
    ...FLOOR_FUNCTIONS.map((name) => extractShellFunction(source, name)),
  ].join("\n");
}

async function sh(
  body: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("sh", {
    args: ["-eu", "-c", `${await floorScript()}\n${body}`, "sh", ...args],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

type Build = { commit: string; version?: string; builtAt?: string };

// Each row: installed, target. Expected values come from isRollback.
const CORPUS: Array<[Build, Build]> = [
  [
    { commit: "a", version: "0.1.3", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", version: "0.1.2", builtAt: "2026-10-05T00:00:00Z" },
  ],
  [
    { commit: "a", version: "0.1.3", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", version: "0.1.4-rc.1", builtAt: "2026-01-01T00:00:00Z" },
  ],
  [
    { commit: "a", version: "0.1.3", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", version: "0.1.3-canary.5", builtAt: "2026-09-29T00:00:00Z" },
  ],
  [
    { commit: "a", version: "0.1.3", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", version: "v0.1.3", builtAt: "2026-10-01T00:00:00Z" },
  ],
  [
    { commit: "a", version: "0.1.3", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "a", version: "0.1.0", builtAt: "2020-01-01T00:00:00Z" },
  ],
  [
    { commit: "a", version: "0.2.0", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", version: "0.10.0", builtAt: "2026-01-01T00:00:00Z" },
  ],
  [
    { commit: "a", version: "1.0.0", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", version: "0.99.99", builtAt: "2027-01-01T00:00:00Z" },
  ],
  // The trunk drop carries no version: build times decide.
  [
    { commit: "a", builtAt: "2026-09-30T12:00:00.500Z" },
    { commit: "b", builtAt: "2026-09-30T12:00:00.250Z" },
  ],
  [
    { commit: "a", version: "0.1.3", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", builtAt: "2026-10-01T00:00:00Z" },
  ],
  [
    { commit: "a", version: "unstamped", builtAt: "unknown" },
    { commit: "b", version: "0.1.0", builtAt: "2020-01-01T00:00:00Z" },
  ],
  [
    { commit: "a", version: "0.1.3", builtAt: "2026-09-30T12:00:00Z" },
    { commit: "b", version: "0.1.3.4", builtAt: "2026-09-29T00:00:00Z" },
  ],
];

test("run.sh's build comparison agrees with isRollback", async () => {
  for (const [have, want] of CORPUS) {
    const expected = isRollback(have, want as TargetBuild);
    const out = await sh('tp_daemon_build_older "$@"', [
      have.commit,
      have.version ?? "",
      have.builtAt ?? "",
      want.commit,
      want.version ?? "",
      want.builtAt ?? "",
    ]);
    // 0 = older, 1 = not older, 2 = no evidence (not a rollback either).
    assertEquals(
      out.code === 0,
      expected,
      `${JSON.stringify(have)} -> ${JSON.stringify(want)}: ${out.stderr}`,
    );
    assertEquals([0, 1, 2].includes(out.code), true, out.stderr);
  }
});

async function withLib<T>(fn: (lib: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "tp-build-floor-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("an older signed release is refused against the recorded floor, a newer one is not", async () => {
  await withLib(async (lib) => {
    const record = join(lib, "installed-build");
    const write = await sh(
      'tp_write_daemon_build_floor "$1" abc1234 0.1.18 2026-11-01T00:00:00Z',
      [record],
    );
    assertEquals(write.code, 0, write.stderr);
    assertEquals(
      await Deno.readTextFile(record),
      "commit=abc1234\nversion=0.1.18\nbuiltAt=2026-11-01T00:00:00Z\n",
    );
    assertEquals((await Deno.stat(record)).mode! & 0o777, 0o644);

    const older = await sh(
      'tp_check_daemon_build_floor "$1" "$1.nobin" def5678 0.1.16 2026-10-01T00:00:00Z',
      [record],
    );
    assertEquals(older.code, 1);
    assertStringIncludes(older.stderr, "older than the installed build 0.1.18");
    assertStringIncludes(older.stderr, "--allow-downgrade");

    for (
      const target of [
        ["abc1234", "0.1.18", "2026-11-01T00:00:00Z"],
        ["fff0000", "0.1.19-rc.1", "2026-11-05T00:00:00Z"],
        ["fff0001", "0.1.18-canary.9", "2026-11-02T00:00:00Z"],
      ]
    ) {
      const ok = await sh(
        'tp_check_daemon_build_floor "$1" "$1.nobin" "$2" "$3" "$4"',
        [record, ...target],
      );
      assertEquals(ok.code, 0, `${target.join(" ")}: ${ok.stderr}`);
    }

    // A release manifest without a build time is not installed over a
    // known build.
    const noTime = await sh(
      'tp_check_daemon_build_floor "$1" "$1.nobin" fff0002 "" ""',
      [record],
    );
    assertEquals(noTime.code, 1);

    // The operator's own break-glass (root's flag or environment).
    const glass = await sh(
      'ALLOW_DOWNGRADE=true tp_check_daemon_build_floor "$1" "$1.nobin" def5678 0.1.16 2026-10-01T00:00:00Z',
      [record],
    );
    assertEquals(glass.code, 0, glass.stderr);
  });
});

test("a host without a record takes its floor from the installed binary", async () => {
  await withLib(async (lib) => {
    const bin = join(lib, "turbopaneld");
    await Deno.writeTextFile(
      bin,
      "#!/bin/sh\nprintf 'turbopaneld v0.1.18 abc1234 (release, build-9, 2026-11-01T00:00:00Z)\\n'\n",
    );
    await Deno.chmod(bin, 0o755);
    const read = await sh('tp_read_daemon_build_floor "$1" "$2"', [
      join(lib, "installed-build"),
      bin,
    ]);
    assertEquals(read.code, 0, read.stderr);
    assertEquals(read.stdout, "abc1234\t0.1.18\t2026-11-01T00:00:00Z");

    const older = await sh(
      'tp_check_daemon_build_floor "$1" "$2" def5678 0.1.16 2026-10-01T00:00:00Z',
      [join(lib, "installed-build"), bin],
    );
    assertEquals(older.code, 1);

    // No record and no runnable binary (a first install): nothing to compare.
    const fresh = await sh(
      'tp_check_daemon_build_floor "$1" "$2" def5678 0.1.16 2026-10-01T00:00:00Z',
      [join(lib, "installed-build"), join(lib, "missing")],
    );
    assertEquals(fresh.code, 0, fresh.stderr);
  });
});

test("the floor record only carries build-identity characters", async () => {
  await withLib(async (lib) => {
    const record = join(lib, "installed-build");
    const out = await sh(
      'tp_write_daemon_build_floor "$1" abc1234 "0.1.0\nevil=1" "x;y"',
      [record],
    );
    assertEquals(out.code, 0, out.stderr);
    assertEquals(
      await Deno.readTextFile(record),
      "commit=abc1234\nversion=\nbuiltAt=\n",
    );
    const bad = await sh('tp_write_daemon_build_floor "$1" "a b" 0.1.0 x', [
      join(lib, "other"),
    ]);
    assertEquals(bad.code, 0);
    assertEquals(
      await Deno.lstat(join(lib, "other")).then(() => true, () => false),
      false,
    );
  });
});

test("run.sh checks the floor before it downloads and records it after it installs", async () => {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  const fetch = source.indexOf("if ! tp_fetch_channel_manifest; then");
  const check = source.indexOf(
    'if ! tp_check_daemon_build_floor "$DAEMON_BUILD_FLOOR"',
  );
  const stop = source.indexOf("tp_stop_running_daemon_for_release_swap\n");
  const install = source.indexOf(
    "if ! tp_install_verified_binary_and_orchestration; then",
  );
  const record = source.indexOf(
    'if ! tp_write_daemon_build_floor "$DAEMON_BUILD_FLOOR"',
  );
  for (const at of [fetch, check, stop, install, record]) {
    assertEquals(at > 0, true);
  }
  assertEquals(fetch < check && check < stop, true);
  assertEquals(install < record, true);
  assertStringIncludes(
    source,
    'DAEMON_BUILD_FLOOR="$INSTALL_ROOT/lib/installed-build"',
  );
  // The break-glass survives the sudo re-exec as a flag, and daemon.env is
  // never a source for it.
  assertStringIncludes(
    source,
    '[ "$ALLOW_DOWNGRADE" = true ] && set -- "$@" --allow-downgrade',
  );
  assertEquals(
    /daemon\.env[^\n]*ALLOW_DOWNGRADE|ALLOW_DOWNGRADE[^\n]*ENV_FILE/.test(
      source,
    ),
    false,
  );
});

test("purge removes root's update records with the install tree", async () => {
  const purge = await Deno.readTextFile(
    join(RUN_SH_PATH, "..", "purge.sh"),
  );
  const owned = /^TP_OWNED_TREES="([^"]*)"/m.exec(purge)?.[1]?.split(" ");
  assertEquals(owned?.includes("/opt/turbopanel"), true);
  const source = await Deno.readTextFile(RUN_SH_PATH);
  assertStringIncludes(source, 'INSTALL_ROOT="/opt/turbopanel"');
  assertStringIncludes(source, '"$(tp_prod_home)/lib/update-guard-armed"');
});
