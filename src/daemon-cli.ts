import { type BuildInfo, getBuildInfo } from "./build-info.ts";
import { sanitizeForLog } from "./logger.ts";
import { runBootstrapOrchestration } from "./orchestration/bootstrap-once.ts";
import { InstallerPresentedFailure } from "./orchestration/install-presenter-context.ts";
import {
  runInstaller,
  type RunInstallerOptions,
} from "./orchestration/setup.ts";

export type DaemonCliIo = {
  args?: string[];
  exit?: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
  getBuildInfo?: () => BuildInfo;
  runBootstrapOrchestration?: () => Promise<void>;
  runInstaller?: (opts: RunInstallerOptions) => Promise<void>;
};

export type InstallerCliFlags = {
  instanceUrl?: string;
  start: boolean;
  instanceCa?: string;
  tunnelToken?: string;
  varsFile?: string;
};

function resolveIo(io: DaemonCliIo = {}): Required<
  Pick<DaemonCliIo, "args" | "exit" | "log" | "error">
> {
  return {
    args: io.args ?? Deno.args,
    exit: io.exit ?? ((code: number) => {
      Deno.exit(code);
    }),
    log: io.log ?? ((message: string) => {
      console.log(message);
    }),
    error: io.error ?? ((message: string) => {
      console.error(message);
    }),
  };
}

/**
 * Handle one-shot CLI verbs (`version`, bootstrap, installer). Returns after
 * those paths `Deno.exit`. Fall-through means the caller should start the
 * long-running daemon.
 */
export async function maybeRunDaemonCli(io: DaemonCliIo = {}): Promise<void> {
  const { args, exit, log, error } = resolveIo(io);
  if (args[0] === "--version" || args[0] === "version") {
    const info = (io.getBuildInfo ?? getBuildInfo)();
    log(
      `turbopaneld ${info.commit} (${info.channel}, ${info.buildId}, ${info.builtAt})`,
    );
    exit(0);
    return;
  }

  if (args[0] === "bootstrap-orchestration") {
    try {
      await (io.runBootstrapOrchestration ?? runBootstrapOrchestration)();
    } catch (err) {
      if (!(err instanceof InstallerPresentedFailure)) {
        error(`[bootstrap] ${sanitizeForLog(err)}`);
      }
      exit(1);
      return;
    }
    exit(0);
    return;
  }

  if (args[0] !== "run-installer") {
    return;
  }
  await runInstallerCli(args.slice(1), io);
}

function requireFlagValue(
  flag: string,
  value: string | undefined,
  io: DaemonCliIo,
): string {
  const { exit, error } = resolveIo(io);
  if (!value) {
    error(`[installer] ${flag} requires a value`);
    exit(1);
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

export function parseInstallerFlags(
  args: string[],
  io: DaemonCliIo = {},
): InstallerCliFlags {
  const { exit, error } = resolveIo(io);
  const flags: InstallerCliFlags = { start: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--instance-url":
        flags.instanceUrl = requireFlagValue(arg, args[++i], io);
        break;
      case "--start": {
        const value = requireFlagValue(arg, args[++i], io);
        if (value !== "true" && value !== "false") {
          error("[installer] --start requires true or false");
          exit(1);
          throw new TypeError("--start requires true or false");
        }
        flags.start = value === "true";
        break;
      }
      case "--instance-ca":
        flags.instanceCa = requireFlagValue(arg, args[++i], io);
        break;
      case "--tunnel-token":
        flags.tunnelToken = requireFlagValue(arg, args[++i], io);
        break;
      case "--vars-file":
        flags.varsFile = requireFlagValue(arg, args[++i], io);
        break;
      default:
        error(`[installer] unknown flag: ${sanitizeForLog(arg)}`);
        exit(1);
        throw new TypeError(`unknown installer flag: ${arg}`);
    }
  }
  return flags;
}

async function runInstallerCli(
  args: string[],
  io: DaemonCliIo = {},
): Promise<void> {
  const { exit, error } = resolveIo(io);
  const flags = parseInstallerFlags(args, io);
  if (!flags.instanceUrl && !flags.varsFile) {
    error("[installer] --instance-url or --vars-file is required");
    exit(1);
    return;
  }

  try {
    await (io.runInstaller ?? runInstaller)(flags);
  } catch (err) {
    if (!(err instanceof InstallerPresentedFailure)) {
      error(`[installer] ${sanitizeForLog(err)}`);
    }
    exit(1);
    return;
  }
  exit(0);
}
