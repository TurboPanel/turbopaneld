import { type BuildInfo, getBuildInfo } from "../build-info.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { runBootstrapOrchestration } from "../orchestration/bootstrap-once.ts";
import { InstallerPresentedFailure } from "../orchestration/install-presenter-context.ts";
import {
  runInstaller,
  type RunInstallerOptions,
} from "../orchestration/setup.ts";
import {
  INSTALLER_PLAYBOOKS,
  type InstallerPlaybook,
} from "../orchestration/assets.ts";
import { resolveUpdateChannelConfig } from "../update/config.ts";
import { DAEMON_VERSION } from "../version.ts";
import {
  runScheduledBackup,
  type ScheduledBackupOutcome,
} from "../backups/runner.ts";

export type DaemonCliIo = {
  args?: string[];
  exit?: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
  getBuildInfo?: () => BuildInfo;
  resolveUpdateChannelConfig?: typeof resolveUpdateChannelConfig;
  runBootstrapOrchestration?: () => Promise<void>;
  runInstaller?: (opts: RunInstallerOptions) => Promise<void>;
  runScheduledBackup?: (policyId: string) => Promise<ScheduledBackupOutcome>;
};

export type InstallerCliFlags = {
  instanceUrl?: string;
  start: boolean;
  instanceCa?: string;
  tunnelToken?: string;
  varsFile?: string;
  playbook?: InstallerPlaybook;
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
 * Handle one-shot CLI verbs (`version`, bootstrap, installer, `backup-run`).
 * Returns after those paths `Deno.exit`. Fall-through means the caller should
 * start the long-running daemon.
 */
export async function maybeRunDaemonCli(io: DaemonCliIo = {}): Promise<void> {
  const { args, exit, log, error } = resolveIo(io);
  if (args[0] === "--version" || args[0] === "version") {
    const info = (io.getBuildInfo ?? getBuildInfo)();
    // Channel is a placement fact (which channel this daemon is configured
    // to follow), not a build fact — read live, never baked into BuildInfo.
    const { channel } = (io.resolveUpdateChannelConfig ??
      resolveUpdateChannelConfig)();
    // Format consumed by tp-update-guard / run.sh:
    // `turbopaneld v<semver> <commit> (<channel>, <buildId>, <builtAt>)`
    log(
      `turbopaneld v${DAEMON_VERSION} ${info.commit} (${channel}, ${info.buildId}, ${info.builtAt})`,
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

  if (args[0] === "backup-run") {
    await runBackupRunCli(args.slice(1), io);
    return;
  }

  if (args[0] !== "run-installer") {
    return;
  }
  await runInstallerCli(args.slice(1), io);
}

/**
 * Exit codes for `backup-run <policyId>`: 0 the backup succeeded, 1 it ran and
 * failed (a result was spooled), 2 bad usage or policy id, 3 the host holds no
 * enabled policy with that id (nothing ran, nothing spooled).
 */
export const BACKUP_RUN_EXIT = {
  succeeded: 0,
  failed: 1,
  usage: 2,
  noPolicy: 3,
} as const;

async function runBackupRunCli(
  args: string[],
  io: DaemonCliIo = {},
): Promise<void> {
  const { exit, log, error } = resolveIo(io);
  if (args.length !== 1) {
    error("[backup-run] usage: backup-run <policyId>");
    exit(BACKUP_RUN_EXIT.usage);
    return;
  }
  let outcome: ScheduledBackupOutcome;
  try {
    outcome = await (io.runScheduledBackup ?? runScheduledBackup)(args[0]);
  } catch (err) {
    error(`[backup-run] ${sanitizeForLog(err)}`);
    exit(BACKUP_RUN_EXIT.failed);
    return;
  }
  if (outcome.kind !== "ran") {
    error(`[backup-run] ${outcome.message}`);
    exit(
      outcome.kind === "no-policy"
        ? BACKUP_RUN_EXIT.noPolicy
        : BACKUP_RUN_EXIT.usage,
    );
    return;
  }
  const { result, resultPath } = outcome;
  if (result.status === "succeeded") {
    log(
      `[backup-run] policy ${result.policyId}: ${result.backupId} (${result.sizeBytes} bytes); result ${resultPath}`,
    );
    exit(BACKUP_RUN_EXIT.succeeded);
    return;
  }
  error(
    `[backup-run] policy ${result.policyId} failed: ${result.error}; result ${resultPath}`,
  );
  exit(BACKUP_RUN_EXIT.failed);
}

function isInstallerPlaybook(value: string): value is InstallerPlaybook {
  return Object.hasOwn(INSTALLER_PLAYBOOKS, value);
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
      case "--playbook": {
        // Allowlisted: the two shipped installers, by bare name — never a
        // path, so a vars file or flag can't point the daemon at arbitrary
        // YAML on the host.
        const value = requireFlagValue(arg, args[++i], io);
        if (!isInstallerPlaybook(value)) {
          error(
            `[installer] --playbook must be one of: ${
              Object.keys(INSTALLER_PLAYBOOKS).join(", ")
            }`,
          );
          exit(1);
          throw new TypeError("--playbook not allowlisted");
        }
        flags.playbook = value;
        break;
      }
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
