/** Production readers for {@link HostTextCollector}; host-free tests inject their own. */
import { readHostRuntimes } from "../../host/runtimes.ts";
import { getLastObservedTimeSync } from "../../host/time-sync.ts";
import { HostTextCollector, type HostTextIo } from "./host-text.ts";
import { readProcFile } from "./proc-read.ts";

const RUN_TIMEOUT_MS = 30_000;
const WHOLE_DISK_RE = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+)$/;

async function run(cmd: string, args: string[]) {
  try {
    const { code, stdout } = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
      // Scoped --allow-run cannot inherit LD_* / DYLD_* (Deno 2.9).
      clearEnv: true,
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    }).output();
    return { code, stdout: new TextDecoder().decode(stdout) };
  } catch {
    return null;
  }
}

async function listNames(path: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
    return names;
  } catch {
    const out = await run("ls", ["-1", path]);
    return out?.code === 0 ? out.stdout.split("\n").filter(Boolean) : [];
  }
}

export function defaultHostTextIo(pageSizeBytes: number): HostTextIo {
  return {
    readFile: readProcFile,
    listPids: () => listNames("/proc"),
    run,
    clockSynced: () => {
      try {
        return getLastObservedTimeSync()?.ntpSynced;
      } catch {
        return undefined;
      }
    },
    phpVersions: () => {
      try {
        return readHostRuntimes()?.php?.series ?? [];
      } catch {
        return [];
      }
    },
    blockDisks: async () =>
      (await listNames("/sys/block")).filter((n) => WHOLE_DISK_RE.test(n)),
    now: () => Date.now(),
    pageSizeBytes,
  };
}

export function defaultHostTextCollector(
  pageSizeBytes: number,
): HostTextCollector {
  return new HostTextCollector(defaultHostTextIo(pageSizeBytes));
}
