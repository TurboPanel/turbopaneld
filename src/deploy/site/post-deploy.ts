/**
 * A site's post-deploy commands: migrations, cache warm-up.
 *
 * They run as one `Type=oneshot` unit under the site's own account, in the new
 * release's folder, with the site's variables, either before the release takes
 * traffic (the default) or right after the switch. The deploy decides whether
 * they worked from what systemd says about the unit (the result of
 * `systemctl start`), never from the journal: the commands' own output lands
 * in the same journal and could print anything. The journal is read only to
 * show that output in the deploy transcript.
 *
 * The unit has no `[Install]`: it runs only when the daemon starts it.
 */

import { join } from "node:path";
import { safeConfigToken } from "../../contracts/config-values.ts";
import type { EnvironmentDeploySitePostDeploy } from "../../contracts/commands-contracts.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { quoteExecArg } from "../cron/unit.ts";
import type { RunFn } from "../ensure-principal.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import {
  installedUnitNames,
  installUnit,
  systemctl,
} from "../systemd-unit-set.ts";
import { forEachSequential } from "../../util/sequential.ts";
import {
  JOURNAL_PREFIX_RE,
  readUnitJournal,
  siteLifecycleHeadLines,
  siteLifecycleTailLines,
  type SiteLifecycleUnitBase,
} from "./lifecycle-unit.ts";
import { StructuredCommandError } from "../../commands/structured-error.ts";

export const POST_DEPLOY_UNIT_PREFIX = "turbopanel-deploycmd-";

/** The first thing the unit prints, so the log reader knows where this run starts. */
export const POST_DEPLOY_BEGIN_MARKER = "turbopanel-post-deploy-begin";

export const DEFAULT_POST_DEPLOY_TIMEOUT_SECONDS = 900;

/** Code of the failure that leaves the new release live (`after-switch`). */
export const POST_DEPLOY_FAILED_AFTER_SWITCH =
  "post_deploy_failed_after_switch";

/** `turbopanel-deploycmd-<environmentId>-<service>` — no extension. */
export function postDeployUnitName(
  environmentId: string,
  composeServiceName: string,
): string {
  return `${POST_DEPLOY_UNIT_PREFIX}${environmentId}-${
    safeConfigToken("post-deploy composeServiceName", composeServiceName)
  }`;
}

export function postDeployUnitPath(
  environmentId: string,
  composeServiceName: string,
  unitDir: string = SYSTEMD_UNIT_DIR,
): string {
  return join(
    unitDir,
    `${postDeployUnitName(environmentId, composeServiceName)}.service`,
  );
}

export type PostDeployUnitOpts = SiteLifecycleUnitBase & {
  environmentId: string;
  composeServiceName: string;
  /** The release the commands run in. */
  releaseId: string;
  postDeploy: EnvironmentDeploySitePostDeploy;
};

export function postDeployUnitContent(opts: PostDeployUnitOpts): string {
  const unit = postDeployUnitName(opts.environmentId, opts.composeServiceName);
  return [
    "# Managed by TurboPanel — regenerated on deploy; edits are overwritten.",
    "[Unit]",
    `Description=TurboPanel post-deploy commands (${
      safeConfigToken("post-deploy composeServiceName", opts.composeServiceName)
    })`,
    `X-TurboPanel-Environment=${opts.environmentId}`,
    "",
    "[Service]",
    "Type=oneshot",
    ...siteLifecycleHeadLines(opts),
    `ExecStart=${
      ["/bin/echo", POST_DEPLOY_BEGIN_MARKER, opts.releaseId]
        .map(quoteExecArg).join(" ")
    }`,
    ...opts.postDeploy.commands.map((command) =>
      `ExecStart=${command.map(quoteExecArg).join(" ")}`
    ),
    `TimeoutStartSec=${
      opts.postDeploy.timeoutSeconds ?? DEFAULT_POST_DEPLOY_TIMEOUT_SECONDS
    }`,
    ...siteLifecycleTailLines(opts, unit),
    "",
  ].join("\n");
}

const SYSTEMD_END_RE = /^\S+ \S+ systemd\[\d+\]: (Finished|Failed)/;

/**
 * The commands' output from the last run of the unit: the lines after the last
 * begin marker, each without the journal's `<time> <host> <name>[pid]: ` prefix.
 * `finished` is true once systemd's own closing line for the run is there,
 * which can lag a moment behind `systemctl start` returning.
 */
export function lastRunOutput(
  journal: string,
  releaseId: string,
): { lines: string[]; finished: boolean } {
  const all = journal.split("\n").map((line) => line.replaceAll("\r", ""));
  const marker = `${POST_DEPLOY_BEGIN_MARKER} ${releaseId}`;
  let start = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    const line = all[i] ?? "";
    if (
      JOURNAL_PREFIX_RE.test(line) &&
      line.replace(JOURNAL_PREFIX_RE, "") === marker
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) return { lines: [], finished: false };
  const lines: string[] = [];
  let finished = false;
  for (const line of all.slice(start + 1)) {
    if (SYSTEMD_END_RE.test(line)) {
      finished = true;
      continue;
    }
    if (line.length === 0) continue;
    // systemd's own start and stop lines are not the commands' output.
    const ident = JOURNAL_PREFIX_RE.exec(line)?.[1];
    if (ident === "systemd") continue;
    lines.push(line.replace(JOURNAL_PREFIX_RE, ""));
  }
  return { lines, finished };
}

/** Journal read attempts and the wait between them (systemd's closing line can lag). */
export const POST_DEPLOY_JOURNAL_ATTEMPTS = 10;
export const POST_DEPLOY_JOURNAL_WAIT_MS = 300;

export type PostDeployIo = {
  run: RunFn;
  /** Where each output line goes (the deploy transcript). */
  onLine: (stream: "stdout" | "stderr", line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  systemdUnitDir?: string;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readRunOutput(
  io: PostDeployIo,
  unit: string,
  releaseId: string,
  attempt = 1,
): Promise<string[]> {
  const text = await readUnitJournal(io.run, `${unit}.service`, 2000);
  const read = lastRunOutput(text, releaseId);
  if (read.finished || attempt >= POST_DEPLOY_JOURNAL_ATTEMPTS) {
    return read.lines;
  }
  await (io.sleep ?? defaultSleep)(POST_DEPLOY_JOURNAL_WAIT_MS);
  return await readRunOutput(io, unit, releaseId, attempt + 1);
}

/**
 * Install the unit, start it, and show its output. Returns whether the
 * commands succeeded (the unit finished without failing); the caller decides
 * what a failure means for its timing.
 */
export async function runPostDeployUnit(
  io: PostDeployIo,
  opts: PostDeployUnitOpts,
): Promise<boolean> {
  const unit = postDeployUnitName(opts.environmentId, opts.composeServiceName);
  const unitDir = io.systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  const changed = await installUnit(
    io.run,
    join(unitDir, `${unit}.service`),
    postDeployUnitContent(opts),
    "tp-deploycmd-",
  );
  if (changed) {
    const reload = await systemctl(io.run, ["daemon-reload"]);
    if (!reload.success) {
      throw new Error(reload.stderr || "systemctl daemon-reload failed");
    }
    // The loopback rules are rebuilt from the unit files on disk.
    const sync = await io.run(
      "sudo",
      hostSudoArgs(["-n", "php-loopback-sync"]),
    );
    if (!sync.success) {
      throw new Error(sync.stderr || "PHP loopback rules could not be loaded");
    }
  }
  // A unit left failed by the last deploy must start cleanly.
  await systemctl(io.run, ["reset-failed", `${unit}.service`]);
  const started = await systemctl(io.run, ["start", `${unit}.service`]);
  const lines = await readRunOutput(io, unit, opts.releaseId);
  for (const line of lines) io.onLine("stdout", line);
  return started.success;
}

/** Remove the post-deploy units of services no longer named (`keep`), all when empty. */
export async function removePostDeployUnits(
  io: Pick<PostDeployIo, "run" | "systemdUnitDir">,
  environmentId: string,
  keepServices: readonly string[],
): Promise<number> {
  const unitDir = io.systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  const keep = new Set(
    keepServices.map((service) => postDeployUnitName(environmentId, service)),
  );
  const stale = (await installedUnitNames(
    io.run,
    unitDir,
    `${POST_DEPLOY_UNIT_PREFIX}${environmentId}-`,
    ".service",
  )).filter((unit) => !keep.has(unit));
  await forEachSequential(stale, async (unit) => {
    await io.run(
      "sudo",
      hostSudoArgs(["-n", "rm", "-f", "--", join(unitDir, `${unit}.service`)]),
    );
  });
  if (stale.length > 0) {
    await systemctl(io.run, ["daemon-reload"]);
    await io.run("sudo", hostSudoArgs(["-n", "php-loopback-sync"]));
  }
  return stale.length;
}

export type PostDeployFailedAfterSwitchDetails = {
  composeServiceName: string;
  failedReleaseId: string;
  previousReleaseId: string | null;
};

/**
 * The failure of an `after-switch` run: the new release is already live. Carries
 * the code and the two release ids in process; the command outcome does not
 * carry details today (a failed outcome sends no result), so only the sentence
 * leaves the daemon.
 */
export class PostDeployFailedAfterSwitchError extends StructuredCommandError {
  constructor(details: PostDeployFailedAfterSwitchDetails) {
    super(
      `Post-deploy commands for site ${details.composeServiceName} failed after the new release went live. Roll back to the previous release from the deploy page if the site is not working.`,
      POST_DEPLOY_FAILED_AFTER_SWITCH,
      details,
    );
    this.name = "PostDeployFailedAfterSwitchError";
  }
}

/** Sentence of a `before-traffic` failure: nothing was switched. */
export function postDeployBeforeTrafficFailure(
  composeServiceName: string,
): Error {
  return new Error(
    `Post-deploy commands for site ${composeServiceName} failed, so the new release was not switched in. The release that was serving keeps serving.`,
  );
}
