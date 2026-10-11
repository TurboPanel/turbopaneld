/**
 * Says **why** an `ansible-playbook` run failed.
 *
 * The process exit code alone ("exit 2") tells the owner nothing. The cause is
 * in the failed task's result (what ansible reported for the host) or, before
 * any task ran, on stderr (a bad playbook, a missing binary). This module
 * keeps the last real cause seen during a run so the thrown error can name it.
 *
 * The playbook argument list is deliberately never part of the message: it can
 * carry `-e` variables.
 */

import { redactUrlSecrets } from "../util/redact-url-secrets.ts";
import {
  clipKeepingEnd,
  lastNonEmptyLines,
  oneLine,
} from "../util/error-line.ts";
import type {
  AnsibleEvent,
  AnsibleHostResult,
  AnsibleTaskResultEvent,
} from "./ansible-events.ts";

/** `msg` values ansible uses when the real reason is on the host's stderr. */
const GENERIC_MESSAGE = /^(non-zero return code|MODULE FAILURE|Module failed)/i;

/** How many stderr lines are remembered for runs that fail before any task. */
const STDERR_MEMORY_LINES = 3;

function lastLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return lastNonEmptyLines(value, 1)[0]?.trim() ?? null;
}

function messageOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = oneLine(value);
  return flat.length > 0 ? flat : null;
}

/** First failed loop item's own reason (`results[]` of a looped task). */
function loopItemDetail(host: AnsibleHostResult): string | null {
  const items = host.results;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as AnsibleHostResult;
    if (record.failed !== true && record.unreachable !== true) continue;
    const found = hostDetail(record, false);
    if (found) return found;
  }
  return null;
}

function hostDetail(
  host: AnsibleHostResult,
  includeItems: boolean,
): string | null {
  const msg = messageOf(host.msg);
  if (msg && !GENERIC_MESSAGE.test(msg)) return msg;
  const fromStreams = lastLine(host.stderr) ?? lastLine(host.module_stderr);
  if (fromStreams) return fromStreams;
  const fromItems = includeItems ? loopItemDetail(host) : null;
  return fromItems ?? msg;
}

/** The host entry that failed (or could not be reached), else the first one. */
function failingHost(
  hosts: Record<string, AnsibleHostResult>,
): AnsibleHostResult | undefined {
  const all = Object.values(hosts);
  return all.find((host) =>
    host.failed === true || host.unreachable === true
  ) ??
    all[0];
}

function isIgnored(host: AnsibleHostResult | undefined): boolean {
  return host?.ignore_errors === true || host?._ansible_ignore_errors === true;
}

/**
 * One plain line for a failed or unreachable task result: the task name and the
 * most specific reason ansible gave. `null` when the task was told to ignore its
 * errors (it is not why the run failed).
 */
export function ansibleFailureLine(
  event: AnsibleTaskResultEvent,
): string | null {
  const host = failingHost(event.hosts ?? {});
  if (isIgnored(host)) return null;
  const detail = (host ? hostDetail(host, true) : null) ?? "unknown error";
  const taskName = event.task?.name ?? "task";
  return clipKeepingEnd(redactUrlSecrets(`${taskName}: ${detail}`));
}

/** Remembers the last real cause seen while a playbook runs. */
export class AnsibleFailureTracker {
  #taskFailure: string | null = null;
  readonly #stderr: string[] = [];

  handleEvent(event: AnsibleEvent): void {
    if (
      event._event !== "v2_runner_on_failed" &&
      event._event !== "v2_runner_on_unreachable"
    ) return;
    const line = ansibleFailureLine(event as AnsibleTaskResultEvent);
    if (line) this.#taskFailure = line;
  }

  handleStderrLine(line: string): void {
    const text = oneLine(line);
    if (text.length === 0) return;
    this.#stderr.push(text);
    if (this.#stderr.length > STDERR_MEMORY_LINES) this.#stderr.shift();
  }

  /** The cause to put at the end of the error message, or `null` when none was seen. */
  describe(): string | null {
    if (this.#taskFailure) return this.#taskFailure;
    const lastStderr = this.#stderr.at(-1);
    return lastStderr ? clipKeepingEnd(redactUrlSecrets(lastStderr)) : null;
  }
}

/** `"<what> failed (exit N): <cause>"`, or without the cause when none was seen. */
export function playbookFailureMessage(
  what: string,
  exitCode: number,
  tracker: AnsibleFailureTracker,
): string {
  const head = `${what} failed (exit ${exitCode})`;
  const cause = tracker.describe();
  return cause ? `${head}: ${cause}` : head;
}
