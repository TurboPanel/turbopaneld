/**
 * Pure renderers for tenant cron units.
 *
 * Nothing here touches the host — `./apply.ts` owns every write, the same split
 * `native/unit.ts` uses and for the same reason: a unit file decides what runs
 * as whom, and that should be assertable without a host.
 *
 * **Why systemd timers rather than `/etc/cron.d`.** The timer's service sets
 * `User=`, so `ExecStart` reaches `execve` *after* systemd has dropped
 * privileges — which makes `/usr/bin/php8.4` succeed or fail purely on the
 * account's entitlement groups. Nothing in the generated unit grants anything.
 * It also reuses the per-principal slice, so a runaway job counts against the
 * same account ceiling its app does, and journald captures output for the log
 * viewer instead of a redirect the operator has to invent.
 */

import { principalHomePath } from "../../paths/layout.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { principalUnixGroupName } from "../ensure-principal.ts";
import { principalSliceName, SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import type { EnvironmentDeployCronJob } from "../../instance/commands/contracts.ts";

/**
 * Unit-name prefix, following the `turbopanel-*` convention so a generated
 * tenant unit can never collide with a distro one and
 * `systemctl list-units 'turbopanel-*'` still shows the whole platform.
 */
export const CRON_UNIT_PREFIX = "turbopanel-cron-";

/**
 * Spread window for jobs that would otherwise all fire on the same tick.
 *
 * A hundred WordPress sites on one box all scheduled every five minutes is the
 * normal case, not a pathological one — without this they queue up on the same
 * tick and the box spikes on a fixed cadence.
 */
export const CRON_RANDOMIZED_DELAY_SEC = 120;

export type CronUnitIdentity = {
  environmentId: string;
  composeServiceName: string;
  jobName: string;
};

/** `turbopanel-cron-<environmentId>-<service>-<job>` — no extension. */
export function cronUnitName(identity: CronUnitIdentity): string {
  return `${CRON_UNIT_PREFIX}${identity.environmentId}-${identity.composeServiceName}-${identity.jobName}`;
}

export function cronServicePath(
  identity: CronUnitIdentity,
  unitDir: string = SYSTEMD_UNIT_DIR,
): string {
  return `${unitDir}/${cronUnitName(identity)}.service`;
}

export function cronTimerPath(
  identity: CronUnitIdentity,
  unitDir: string = SYSTEMD_UNIT_DIR,
): string {
  return `${unitDir}/${cronUnitName(identity)}.timer`;
}

/**
 * Quote one `ExecStart` argument.
 *
 * systemd's own quoting, not a shell's: a double-quoted string with `\` and `"`
 * escaped. Every argument is quoted unconditionally rather than only when it
 * looks like it needs to be, so there is one code path and no judgement call
 * about which characters are "safe" here.
 *
 * The wire contract already refuses NUL, CR, and LF in an argument, so what is
 * left cannot terminate the directive.
 */
function quoteExecArg(arg: string): string {
  return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export type CronUnitOpts = {
  layout: LayoutPaths;
  environmentId: string;
  composeServiceName: string;
  job: EnvironmentDeployCronJob;
  /** Account the job runs as. There is no default — see `apply.ts`. */
  username: string;
  /** Directory the job runs in: a site's document root, an app's `current`. */
  workingDirectory: string;
};

/**
 * The `oneshot` service a timer triggers.
 *
 * `Type=oneshot` with no `[Install]` section: the unit is started by its timer
 * and by nothing else, so enabling it would be meaningless and `WantedBy` would
 * make it run once at boot as a side effect.
 */
export function cronServiceContent(opts: CronUnitOpts): string {
  const home = principalHomePath(opts.layout, opts.username);
  return [
    "# Managed by TurboPanel — regenerated on deploy; edits are overwritten.",
    "[Unit]",
    `Description=TurboPanel job ${opts.job.name} (${opts.composeServiceName})`,
    `X-TurboPanel-Environment=${opts.environmentId}`,
    "",
    "[Service]",
    "Type=oneshot",
    // The whole point. `ExecStart` runs after this drop, so the account's own
    // entitlement groups decide whether it may execute the interpreter at all.
    `User=${opts.username}`,
    `Group=${principalUnixGroupName(opts.username)}`,
    `Slice=${principalSliceName(opts.username)}`,
    `WorkingDirectory=${opts.workingDirectory}`,
    `Environment=HOME=${home}`,
    `ExecStart=${opts.job.command.map(quoteExecArg).join(" ")}`,
    // Output goes to the log viewer rather than a redirect the operator has to
    // invent — which is also why the command parser can refuse `>>`.
    "StandardOutput=journal",
    "StandardError=journal",
    `SyslogIdentifier=${
      cronUnitName({
        environmentId: opts.environmentId,
        composeServiceName: opts.composeServiceName,
        jobName: opts.job.name,
      })
    }`,
    // A job that hangs must not hold a slot forever; the timer would then never
    // fire again, and the failure would look like "cron stopped working".
    "TimeoutStartSec=900",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictSUIDSGID=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    // The tree it runs in. `ProtectHome` is deliberately NOT set: the working
    // directory is inside the principal's home, and a job that cannot read the
    // application it was written for is not a job.
    `ReadWritePaths=${home}`,
    "",
  ].join("\n");
}

/**
 * The timer.
 *
 * `Persistent=false` on purpose: a host that was down for a week must not
 * stampede every missed run on boot. Catching up on a missed billing job is a
 * decision for whoever wrote it, not a default.
 */
export function cronTimerContent(opts: CronUnitOpts): string {
  const unit = cronUnitName({
    environmentId: opts.environmentId,
    composeServiceName: opts.composeServiceName,
    jobName: opts.job.name,
  });
  return [
    "# Managed by TurboPanel — regenerated on deploy; edits are overwritten.",
    "[Unit]",
    `Description=TurboPanel schedule for ${opts.job.name} (${opts.composeServiceName})`,
    `X-TurboPanel-Environment=${opts.environmentId}`,
    "",
    "[Timer]",
    `Unit=${unit}.service`,
    `OnCalendar=${opts.job.schedule}`,
    `RandomizedDelaySec=${CRON_RANDOMIZED_DELAY_SEC}`,
    "Persistent=false",
    // Every tenant job resolves against the host's timezone rather than
    // whatever the account's environment says, so two accounts reading the same
    // "3am" mean the same instant.
    "AccuracySec=1s",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
