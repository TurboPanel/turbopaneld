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
  readUnitJournal,
  siteLifecycleHeadLines,
  siteLifecycleTailLines,
  type SiteLifecycleUnitBase,
} from "./lifecycle-unit.ts";
import { StructuredCommandError } from "../../commands/structured-error.ts";

export const POST_DEPLOY_UNIT_PREFIX = "turbopanel-deploycmd-";

/** The first thing the unit prints, so the log reader knows where this run starts. */
export const POST_DEPLOY_BEGIN_MARKER = "turbopanel-post-deploy-begin";

/**
 * Printed before each command (`<marker> <n>`, counting from 1), so a failure
 * names the command that was running without reading any command's arguments.
 */
export const POST_DEPLOY_STEP_MARKER = "turbopanel-post-deploy-step";

export const DEFAULT_POST_DEPLOY_TIMEOUT_SECONDS = 900;

/** How much of a failing run's output the transcript keeps: the tail only. */
export const POST_DEPLOY_OUTPUT_MAX_LINES = 60;
export const POST_DEPLOY_OUTPUT_MAX_LINE_CHARS = 500;

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
    ...opts.postDeploy.commands.flatMap((command, index) => [
      `ExecStart=${
        ["/bin/echo", POST_DEPLOY_STEP_MARKER, String(index + 1)]
          .map(quoteExecArg).join(" ")
      }`,
      `ExecStart=${command.map(quoteExecArg).join(" ")}`,
    ]),
    `TimeoutStartSec=${
      opts.postDeploy.timeoutSeconds ?? DEFAULT_POST_DEPLOY_TIMEOUT_SECONDS
    }`,
    ...siteLifecycleTailLines(opts, unit),
    "",
  ].join("\n");
}

const SYSTEMD_END_RE = /^\S+ \S+ systemd\[\d+\]: \S*\s*(Finished|Failed)/;

/** `<time> <host> <name>[pid]: `, the pid being optional (a line the journal wrote without one). */
const LINE_PREFIX_RE = /^\S+ \S+ ([^\s[:]+)(?:\[\d+\])?: /;

/** What systemd said about the failed run, as far as the journal shows it. */
export type PostDeployFailure = {
  /** The program of the command that was running (path only, never its arguments). */
  command?: string;
  /** `exit status 1`, `signal SEGV` or `timed out`. */
  status?: string;
};

export type PostDeployRunOutput = {
  lines: string[];
  finished: boolean;
  failure: PostDeployFailure;
};

function failureStatus(line: string): string | undefined {
  const code = /code=(exited|killed|dumped), status=(\w+)(?:\/\w+)?/.exec(line);
  if (code?.[1] === "exited") return `exit status ${code[2]}`;
  if (code?.[1] !== undefined) return `signal ${code[2]}`;
  if (/result 'timeout'/i.test(line)) return "timed out";
  return undefined;
}

/**
 * The commands' output from the last run of the unit: the lines after the last
 * begin marker, each without the journal's `<time> <host> <name>[pid]: ` prefix.
 * `finished` is true once systemd's own closing line for the run is there,
 * which can lag a moment behind `systemctl start` returning. `failure` holds
 * what systemd's own lines and the step markers say about a failed run.
 */
export function lastRunOutput(
  journal: string,
  releaseId: string,
  commands: readonly (readonly string[])[] = [],
): PostDeployRunOutput {
  const all = journal.split("\n").map((line) => line.replaceAll("\r", ""));
  const marker = `${POST_DEPLOY_BEGIN_MARKER} ${releaseId}`;
  let start = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    const line = all[i] ?? "";
    if (
      LINE_PREFIX_RE.test(line) &&
      line.replace(LINE_PREFIX_RE, "") === marker
    ) {
      start = i;
      break;
    }
  }
  const failure: PostDeployFailure = {};
  if (start < 0) return { lines: [], finished: false, failure };
  const lines: string[] = [];
  let finished = false;
  let step = 0;
  for (const line of all.slice(start + 1)) {
    if (line.length === 0) continue;
    const ident = LINE_PREFIX_RE.exec(line)?.[1];
    if (ident === "systemd") {
      // systemd's own lines are not the commands' output.
      if (SYSTEMD_END_RE.test(line)) finished = true;
      const status = failureStatus(line);
      if (status !== undefined) failure.status ??= status;
      continue;
    }
    const text = line.replace(LINE_PREFIX_RE, "");
    const stepNumber = stepMarkerNumber(text);
    if (stepNumber !== undefined) {
      step = stepNumber;
      continue;
    }
    lines.push(text);
  }
  const program = step > 0 ? commands[step - 1]?.[0] : undefined;
  if (program !== undefined) failure.command = program;
  return { lines, finished, failure };
}

function stepMarkerNumber(text: string): number | undefined {
  const prefix = `${POST_DEPLOY_STEP_MARKER} `;
  if (!text.startsWith(prefix)) return undefined;
  const n = Number(text.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The tail of a failing run's output: bounded in lines and in line length. */
export function boundedOutputTail(lines: readonly string[]): string[] {
  const kept = lines.slice(-POST_DEPLOY_OUTPUT_MAX_LINES).map((line) =>
    line.length > POST_DEPLOY_OUTPUT_MAX_LINE_CHARS
      ? `${line.slice(0, POST_DEPLOY_OUTPUT_MAX_LINE_CHARS)}...`
      : line
  );
  const omitted = lines.length - kept.length;
  return omitted > 0
    ? [`... ${omitted} earlier output lines omitted ...`, ...kept]
    : kept;
}

/** True when the run told us which command failed or how. */
export function hasFailureDetail(failure: PostDeployFailure | undefined) {
  return failure?.command !== undefined || failure?.status !== undefined;
}

/** The sentence part naming a failure: `/usr/bin/php exited with exit status 1`. */
export function describePostDeployFailure(failure: PostDeployFailure): string {
  const command = failure.command ?? "a command";
  if (failure.status === undefined) return `${command} failed`;
  if (failure.status === "timed out") return `${command} timed out`;
  if (failure.status.startsWith("exit status ")) {
    return `${command} exited with ${failure.status}`;
  }
  return `${command} was stopped by ${failure.status}`;
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
  opts: PostDeployUnitOpts,
  attempt = 1,
): Promise<PostDeployRunOutput> {
  const text = await readUnitJournal(io.run, `${unit}.service`, 2000);
  const read = lastRunOutput(text, opts.releaseId, opts.postDeploy.commands);
  if (read.finished || attempt >= POST_DEPLOY_JOURNAL_ATTEMPTS) return read;
  await (io.sleep ?? defaultSleep)(POST_DEPLOY_JOURNAL_WAIT_MS);
  return await readRunOutput(io, unit, opts, attempt + 1);
}

export type PostDeployRunResult =
  | { ok: true }
  | { ok: false; failure: PostDeployFailure };

/**
 * Install the unit, start it, and show its output. Reports whether the
 * commands succeeded (the unit finished without failing) and, when they did
 * not, which command failed and how; the caller decides what a failure means
 * for its timing. A failing run's output is cut to its tail, and the transcript
 * always says what failed, even when the journal held no output.
 */
export async function runPostDeployUnit(
  io: PostDeployIo,
  opts: PostDeployUnitOpts,
): Promise<PostDeployRunResult> {
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
  const read = await readRunOutput(io, unit, opts);
  if (started.success) {
    for (const line of read.lines) io.onLine("stdout", line);
    return { ok: true };
  }
  const tail = boundedOutputTail(read.lines);
  for (const line of tail) io.onLine("stderr", line);
  if (tail.length === 0) {
    io.onLine("stderr", "no output was captured from the failed command");
  }
  io.onLine(
    "stderr",
    `post-deploy failed: ${describePostDeployFailure(read.failure)}`,
  );
  return { ok: false, failure: read.failure };
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
  failure?: PostDeployFailure;
};

/**
 * The failure of an `after-switch` run: the new release is already live. A
 * failed command outcome sends no `result` and no code, only the error text, so
 * the text starts with the stable code and a colon (`<code>: <sentence>`), the
 * same way `rolled_back: ` and `needs_attention: ` do. A panel that does not
 * know the prefix shows the sentence as it is. The sentence is kept short (a
 * long message loses its start) and names the failed program and its status,
 * never an argument or a variable.
 */
export class PostDeployFailedAfterSwitchError extends StructuredCommandError {
  constructor(details: PostDeployFailedAfterSwitchDetails) {
    const failed = details.failure !== undefined &&
        hasFailureDetail(details.failure)
      ? ` ${describePostDeployFailure(details.failure)}.`
      : "";
    super(
      `${POST_DEPLOY_FAILED_AFTER_SWITCH}: Post-deploy commands for site ${details.composeServiceName} failed after the new release ${details.failedReleaseId} went live.${failed} Roll back to the previous release${
        details.previousReleaseId === null
          ? ""
          : ` ${details.previousReleaseId}`
      } from the deploy page if the site is not working.`,
      POST_DEPLOY_FAILED_AFTER_SWITCH,
      details,
    );
    this.name = "PostDeployFailedAfterSwitchError";
  }
}

/** Sentence of a `before-traffic` failure: nothing was switched. */
export function postDeployBeforeTrafficFailure(
  composeServiceName: string,
  failure?: PostDeployFailure,
): Error {
  const failed = failure !== undefined && hasFailureDetail(failure)
    ? ` ${describePostDeployFailure(failure)}.`
    : "";
  return new Error(
    `Post-deploy commands for site ${composeServiceName} failed, so the new release was not switched in.${failed} The release that was serving keeps serving.`,
  );
}
