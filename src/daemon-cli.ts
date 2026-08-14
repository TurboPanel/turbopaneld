import { getBuildInfo } from "./build-info.ts";
import { sanitizeForLog } from "./logger.ts";
import { runBootstrapOrchestration } from "./orchestration/bootstrap-once.ts";
import { InstallerPresentedFailure } from "./orchestration/install-presenter-context.ts";
import { runInstaller } from "./orchestration/setup.ts";

/**
 * Handle one-shot CLI verbs (`version`, bootstrap, installer). Returns after
 * those paths `Deno.exit`. Fall-through means the caller should start the
 * long-running daemon.
 */
export async function maybeRunDaemonCli(): Promise<void> {
  if (Deno.args[0] === "--version" || Deno.args[0] === "version") {
    const info = getBuildInfo();
    console.log(
      `turbopaneld ${info.commit} (${info.channel}, ${info.buildId}, ${info.builtAt})`,
    );
    Deno.exit(0);
  }

  if (Deno.args[0] === "bootstrap-orchestration") {
    try {
      await runBootstrapOrchestration();
    } catch (err) {
      if (!(err instanceof InstallerPresentedFailure)) {
        console.error(`[bootstrap] ${sanitizeForLog(err)}`);
      }
      Deno.exit(1);
    }
    Deno.exit(0);
  }

  if (Deno.args[0] !== "run-installer") {
    return;
  }
  await runInstallerCli(Deno.args.slice(1));
}

type InstallerCliFlags = {
  instanceUrl?: string;
  start: boolean;
  instanceCa?: string;
  tunnelToken?: string;
  varsFile?: string;
};

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value) {
    console.error(`[installer] ${flag} requires a value`);
    Deno.exit(1);
  }
  return value;
}

function parseInstallerFlags(args: string[]): InstallerCliFlags {
  const flags: InstallerCliFlags = { start: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--instance-url":
        flags.instanceUrl = requireFlagValue(arg, args[++i]);
        break;
      case "--start": {
        const value = requireFlagValue(arg, args[++i]);
        if (value !== "true" && value !== "false") {
          console.error("[installer] --start requires true or false");
          Deno.exit(1);
        }
        flags.start = value === "true";
        break;
      }
      case "--instance-ca":
        flags.instanceCa = requireFlagValue(arg, args[++i]);
        break;
      case "--tunnel-token":
        flags.tunnelToken = requireFlagValue(arg, args[++i]);
        break;
      case "--vars-file":
        flags.varsFile = requireFlagValue(arg, args[++i]);
        break;
      default:
        console.error(`[installer] unknown flag: ${sanitizeForLog(arg)}`);
        Deno.exit(1);
    }
  }
  return flags;
}

async function runInstallerCli(args: string[]): Promise<void> {
  const flags = parseInstallerFlags(args);
  if (!flags.instanceUrl && !flags.varsFile) {
    console.error("[installer] --instance-url or --vars-file is required");
    Deno.exit(1);
  }

  try {
    await runInstaller(flags);
  } catch (err) {
    if (!(err instanceof InstallerPresentedFailure)) {
      console.error(`[installer] ${sanitizeForLog(err)}`);
    }
    Deno.exit(1);
  }
  Deno.exit(0);
}
