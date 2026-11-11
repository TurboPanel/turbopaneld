/**
 * A host-free stand-in for `sudo -n <tool>` as the daemon's unit code calls it:
 * `cmp`, `install`, `ls` and `rm` act on a temporary unit folder, every other
 * tool (systemctl, journalctl, tp-host verbs) is recorded and answered by the
 * caller's `answer` function. Test-only.
 */

import { dirname, join } from "@std/path";
import type { RunFn, RunResult } from "../deploy/ensure-principal.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";

export type SystemdHostCall = { tool: string; args: string[] };

export type SystemdHost = {
  layout: LayoutPaths;
  unitDir: string;
  run: RunFn;
  calls: SystemdHostCall[];
  /** The recorded `systemctl` argument lists, in order. */
  systemctl: () => string[][];
  cleanup: () => Promise<void>;
};

export const hostOk = (stdout = ""): RunResult => ({
  success: true,
  stdout,
  stderr: "",
});

export const hostFail = (stderr: string, stdout = ""): RunResult => ({
  success: false,
  stdout,
  stderr,
});

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      Deno.readFile(a),
      Deno.readFile(b),
    ]);
    return left.length === right.length &&
      left.every((byte, index) => byte === right[index]);
  } catch {
    return false;
  }
}

export async function makeSystemdHost(
  /** Answer for a recorded tool; return `undefined` for the default (success). */
  answer: (call: SystemdHostCall) => RunResult | undefined = () => undefined,
): Promise<SystemdHost> {
  const root = await Deno.makeTempDir({ prefix: "tp-systemd-host-" });
  const unitDir = join(root, "etc/systemd/system");
  await Deno.mkdir(unitDir, { recursive: true });
  const layout = resolveLayout({
    TURBOPANEL_STATE_DIR: `${root}/state`,
    TURBOPANEL_CONFIG_DIR: `${root}/config`,
    TURBOPANEL_LOG_DIR: `${root}/log`,
    TURBOPANEL_RUN_DIR: `${root}/run`,
    TURBOPANEL_RUNTIMES_DIR: `${root}/runtimes`,
    TURBOPANEL_PRINCIPAL_HOME_ROOT: `${root}/srv/users`,
  }, { skipDiscovery: true, forceMode: "production" });
  const calls: SystemdHostCall[] = [];
  const run: RunFn = async (command, args) => {
    if (command !== "sudo") return hostOk();
    const rest = args[0] === "-n" ? args.slice(1) : args;
    // A verb only tp-host has arrives as `-- <path of tp-host> <verb> ...`; the
    // tool is the first word that is neither `--` nor a path.
    const index = rest.findIndex((word) =>
      word !== "--" && !word.startsWith("/")
    );
    const tool = rest[index] ?? "";
    const tail = rest.slice(index + 1);
    calls.push({ tool, args: tail });
    if (tool === "cmp") {
      return (await sameBytes(tail.at(-2) as string, tail.at(-1) as string))
        ? hostOk()
        : hostFail("files differ");
    }
    if (tool === "install") {
      const dest = tail.at(-1) as string;
      await Deno.mkdir(dirname(dest), { recursive: true });
      await Deno.copyFile(tail.at(-2) as string, dest);
      return hostOk();
    }
    if (tool === "ls") {
      try {
        const names: string[] = [];
        for await (const entry of Deno.readDir(tail.at(-1) as string)) {
          names.push(entry.name);
        }
        return hostOk(names.sort((a, b) => a.localeCompare(b)).join("\n"));
      } catch {
        return hostFail("No such file or directory");
      }
    }
    if (tool === "rm") {
      await Deno.remove(tail.at(-1) as string).catch(() => undefined);
      return hostOk();
    }
    return answer({ tool, args: tail }) ?? hostOk();
  };
  return {
    layout,
    unitDir,
    run,
    calls,
    systemctl: () =>
      calls.filter((call) => call.tool === "systemctl").map((call) =>
        call.args
      ),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}
