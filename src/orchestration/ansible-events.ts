import { logDebug, logError, logInfo } from "../logger.ts";
import { runStreamingLines } from "./exec.ts";

/** ISO-8601 timestamp emitted by ansible.posix.jsonl. */
export type AnsibleEventTimestamp = string;

export interface AnsibleDuration {
  start: string;
  end?: string;
}

export interface AnsiblePlayInfo {
  name: string;
  id: string;
  path: string;
  duration: AnsibleDuration;
}

export interface AnsibleTaskInfo {
  name: string;
  id: string;
  path: string;
  duration: AnsibleDuration;
}

/** Per-host task result payload (shape varies by module). */
export type AnsibleHostResult = Record<string, unknown> & {
  action?: string;
  changed?: boolean;
  failed?: boolean;
  skipped?: boolean;
  unreachable?: boolean;
  msg?: string;
};

export interface AnsiblePlaybookStats {
  [host: string]: Record<string, number>;
}

/** Base fields present on every JSONL line from ansible.posix.jsonl. */
export interface AnsibleEventBase {
  _event: string;
  _timestamp: AnsibleEventTimestamp;
}

export interface AnsiblePlayStartEvent extends AnsibleEventBase {
  _event: "v2_playbook_on_play_start";
  play: AnsiblePlayInfo;
  tasks: unknown[];
}

export interface AnsibleTaskStartEvent extends AnsibleEventBase {
  _event:
    | "v2_playbook_on_task_start"
    | "v2_playbook_on_handler_task_start"
    | "v2_runner_on_start";
  task: AnsibleTaskInfo;
  hosts: Record<string, AnsibleHostResult>;
}

export interface AnsibleTaskResultEvent extends AnsibleEventBase {
  _event:
    | "v2_runner_on_ok"
    | "v2_runner_on_failed"
    | "v2_runner_on_unreachable"
    | "v2_runner_on_skipped";
  task: AnsibleTaskInfo;
  hosts: Record<string, AnsibleHostResult>;
}

export interface AnsiblePlayStatsEvent extends AnsibleEventBase {
  _event: "v2_playbook_on_stats";
  stats: AnsiblePlaybookStats;
  custom_stats: Record<string, unknown>;
  global_custom_stats: Record<string, unknown>;
}

/** Forward-compatible fallback for callback events not yet modeled. */
export interface AnsibleUnknownEvent extends AnsibleEventBase {
  [key: string]: unknown;
}

/**
 * Serializable Ansible playbook event union parsed from ansible.posix.jsonl stdout.
 *
 * **Streaming seam:** downstream consumers (dev console, future HTTP/WebSocket control
 * surfaces) should import this module and subscribe via `onEvent` / `runPlaybookStreaming`.
 * Payloads are JSON-serializable and stable enough to relay over APIs or WS without
 * re-parsing raw ansible stdout.
 */
export type AnsibleEvent =
  | AnsiblePlayStartEvent
  | AnsibleTaskStartEvent
  | AnsibleTaskResultEvent
  | AnsiblePlayStatsEvent
  | AnsibleUnknownEvent;

export type AnsibleEventHandler = (event: AnsibleEvent) => void;

/** Parse one JSONL stdout line from ansible.posix.jsonl; returns null for blank/non-JSON lines. */
export function parseAnsibleJsonlLine(line: string): AnsibleEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record._event !== "string" || typeof record._timestamp !== "string"
    ) {
      return null;
    }
    return record as AnsibleEvent;
  } catch {
    return null;
  }
}

export const ANSIBLE_SUMMARY_MAX_LENGTH = 500;

export function formatPlaybookRecap(stats: AnsiblePlaybookStats): string {
  let ok = 0;
  let changed = 0;
  let failed = 0;
  let unreachable = 0;

  for (const hostStats of Object.values(stats)) {
    ok += hostStats.ok ?? 0;
    changed += hostStats.changed ?? 0;
    failed += hostStats.failed ?? 0;
    unreachable += hostStats.unreachable ?? 0;
  }

  return `ok=${ok} changed=${changed} failed=${failed} unreachable=${unreachable}`;
}

/** Strip control characters and cap length for safe command-outcome relay. */
export function sanitizeAnsibleSummaryText(text: string): string {
  const stripped = text
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\t", " ")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.length > ANSIBLE_SUMMARY_MAX_LENGTH
    ? collapsed.slice(0, ANSIBLE_SUMMARY_MAX_LENGTH)
    : collapsed;
}

/** Collects a short recap plus the first failure from ansible.posix.jsonl events. */
export class AnsibleRunSummaryCollector {
  #recap: string | null = null;
  #firstFailure: string | null = null;

  handleEvent(event: AnsibleEvent): void {
    switch (event._event) {
      case "v2_playbook_on_stats": {
        const statsEvent = event as AnsiblePlayStatsEvent;
        this.#recap = formatPlaybookRecap(statsEvent.stats);
        break;
      }
      case "v2_runner_on_failed":
      case "v2_runner_on_unreachable": {
        if (this.#firstFailure) break;
        const failedEvent = event as AnsibleTaskResultEvent;
        const firstHost = Object.values(failedEvent.hosts)[0];
        const msg = typeof firstHost?.msg === "string"
          ? firstHost.msg
          : "unknown error";
        const taskName = failedEvent.task.name ?? "task";
        this.#firstFailure = `${taskName}: ${msg}`;
        break;
      }
    }
  }

  build(): string {
    const parts: string[] = [];
    if (this.#recap) parts.push(this.#recap);
    if (this.#firstFailure) parts.push(this.#firstFailure);
    return sanitizeAnsibleSummaryText(parts.join("; "));
  }
}

/** Map a parsed ansible.posix.jsonl event to structured daemon log lines. */
export function logAnsibleEvent(event: AnsibleEvent): void {
  switch (event._event) {
    case "v2_playbook_on_play_start": {
      const playEvent = event as AnsiblePlayStartEvent;
      logInfo("ansible", "[play] " + playEvent.play.name);
      break;
    }
    case "v2_playbook_on_task_start": {
      const taskEvent = event as AnsibleTaskStartEvent;
      logDebug("ansible", "[task] " + taskEvent.task.name);
      break;
    }
    case "v2_runner_on_ok": {
      const okEvent = event as AnsibleTaskResultEvent;
      const anyChanged = Object.values(okEvent.hosts).some((host) =>
        host.changed === true
      );
      if (anyChanged) {
        logInfo("ansible", "[changed] " + okEvent.task.name);
      } else {
        logDebug("ansible", "[ok] " + okEvent.task.name);
      }
      break;
    }
    case "v2_runner_on_skipped": {
      const skippedEvent = event as AnsibleTaskResultEvent;
      logDebug("ansible", "[skipped] " + skippedEvent.task.name);
      break;
    }
    case "v2_runner_on_failed":
    case "v2_runner_on_unreachable": {
      const failedEvent = event as AnsibleTaskResultEvent;
      const firstHost = Object.values(failedEvent.hosts)[0];
      const firstMsg = firstHost?.msg ?? "unknown error";
      logError(
        "ansible",
        "[failed] " + failedEvent.task.name + ": " + firstMsg,
      );
      break;
    }
    case "v2_playbook_on_stats": {
      const statsEvent = event as AnsiblePlayStatsEvent;
      logInfo("ansible", "[recap] " + formatPlaybookRecap(statsEvent.stats));
      break;
    }
  }
}

export interface PlaybookStreamingOptions {
  cwd?: string;
  env?: Record<string, string>;
  onEvent?: AnsibleEventHandler;
  /** When true, parsed events and raw stdout/stderr are not logged (TUI consumers). */
  quiet?: boolean;
}

/**
 * Run ansible-playbook with stdout parsed as JSONL task events.
 *
 * Parsed events are logged via `logAnsibleEvent()` unless `quiet` is set; unparseable
 * stdout lines and all stderr lines are routed through the structured logger under the
 * `ansible` component (also suppressed when `quiet`).
 */
export async function runPlaybookStreaming(
  ansiblePlaybookBin: string,
  args: string[],
  options: PlaybookStreamingOptions,
): Promise<void> {
  const quiet = options.quiet === true;
  const result = await runStreamingLines(ansiblePlaybookBin, args, {
    cwd: options.cwd,
    env: options.env,
    onStdoutLine: (line) => {
      const event = parseAnsibleJsonlLine(line);
      if (event) {
        if (!quiet) logAnsibleEvent(event);
        if (options.onEvent) options.onEvent(event);
      } else if (!quiet && line.trim().length > 0) {
        logInfo("ansible", line);
      }
    },
    onStderrLine: (line) => {
      if (!quiet && line.trim().length > 0) logInfo("ansible", line);
    },
  });

  if (!result.success) {
    throw new Error(
      `ansible-playbook failed (exit ${result.code}): ${ansiblePlaybookBin} ${
        args.join(" ")
      }`,
    );
  }
}
