/**
 * Test-only helpers — do not import from production code.
 *
 * A throwaway development root for the `src/dev-host/` suites: one bare-free
 * "origin" repository per checkout (branch `trunk`) and a clone of it under
 * `<root>/<folder>`, plus a fake {@link RunCommand} that runs the real `git`
 * (isolated from the developer's configuration) and records every other
 * program instead of running it. Nothing here touches the real checkouts,
 * `/etc/turbopanel` or `/var/lib/turbopanel`.
 */
import { join } from "@std/path";
import {
  type CommandResult,
  type RunCommand,
  runCommand,
} from "../dev-host/commands.ts";
import { createTempGitRepo, type TempGitRepo } from "./temp-git-repo.ts";

/** Git variables that detach git from the developer's configuration. */
export const ISOLATED_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "TurboPanel Test",
  GIT_AUTHOR_EMAIL: "test@turbopanel.invalid",
  GIT_COMMITTER_NAME: "TurboPanel Test",
  GIT_COMMITTER_EMAIL: "test@turbopanel.invalid",
};

export type DevRootFixture = {
  /** The development root holding the clones. */
  root: string;
  /** The state folder used as `TURBOPANEL_DAEMON_STATE_DIR`. */
  stateDir: string;
  /** Origin repository per checkout folder. */
  origins: Record<string, TempGitRepo>;
  /** Run git in a clone (throws on failure, returns trimmed stdout). */
  git: (folder: string, ...args: string[]) => Promise<string>;
  cleanup: () => Promise<void>;
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", cwd, ...args], {
    env: ISOLATED_GIT_ENV,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Create origins (branch `trunk`) and clones for each folder. */
export async function createDevRoot(
  folders: Record<string, Record<string, string>>,
): Promise<DevRootFixture> {
  const base = await Deno.makeTempDir({ prefix: "turbopaneld-devhost-" });
  const root = join(base, "turbopanel");
  const stateDir = join(base, "state");
  await Deno.mkdir(root, { recursive: true });
  await Deno.mkdir(stateDir, { recursive: true });
  const origins: Record<string, TempGitRepo> = {};
  try {
    for (const [folder, files] of Object.entries(folders)) {
      const origin = await createTempGitRepo(files);
      await origin.git("branch", "-m", "trunk");
      origins[folder] = origin;
      await git(base, ["clone", "-q", origin.path, join(root, folder)]);
    }
  } catch (err) {
    for (const origin of Object.values(origins)) await origin.cleanup();
    await Deno.remove(base, { recursive: true });
    throw err;
  }
  return {
    root,
    stateDir,
    origins,
    git: (folder, ...args) => git(join(root, folder), args),
    cleanup: async () => {
      for (const origin of Object.values(origins)) await origin.cleanup();
      await Deno.remove(base, { recursive: true });
    },
  };
}

export type RecordedCall = {
  program: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type FakeRunOptions = {
  /** Answer for a non-git program; default exit 0 with no output. */
  answer?: (program: string, args: string[]) => CommandResult | undefined;
};

/**
 * A runner that executes `git` for real (isolated) and records every other
 * program without running it.
 */
export function fakeRun(
  calls: RecordedCall[],
  options: FakeRunOptions = {},
): RunCommand {
  return async (program, args, runOptions = {}) => {
    calls.push({ program, args, cwd: runOptions.cwd, env: runOptions.env });
    if (program === "git") {
      return await runCommand(program, args, {
        ...runOptions,
        env: { ...runOptions.env, ...ISOLATED_GIT_ENV },
      });
    }
    return options.answer?.(program, args) ??
      { code: 0, stdout: "", stderr: "" };
  };
}

/** `systemctl show --timestamp=unix` text for the given units. */
export function systemctlShowText(
  units: Record<string, { active: boolean; startedAtSec: number | null }>,
): string {
  return Object.entries(units).map(([unit, state]) =>
    [
      `ExecMainStartTimestamp=${
        state.startedAtSec === null ? "" : `@${state.startedAtSec}`
      }`,
      `Id=${unit}.service`,
      `ActiveState=${state.active ? "active" : "inactive"}`,
    ].join("\n")
  ).join("\n\n");
}

/**
 * An answer for `systemctl show` that reports every named unit active since
 * `startedAtSec`; undefined for any other command.
 */
export function unitsActiveSince(
  startedAtSec: number,
): (program: string, args: string[]) => CommandResult | undefined {
  return (program, args) => {
    if (program !== "systemctl" || args[0] !== "show") return undefined;
    const units: Record<string, { active: boolean; startedAtSec: number }> = {};
    for (const arg of args) {
      if (arg.endsWith(".service")) {
        units[arg.slice(0, -".service".length)] = {
          active: true,
          startedAtSec,
        };
      }
    }
    return { code: 0, stdout: systemctlShowText(units), stderr: "" };
  };
}
