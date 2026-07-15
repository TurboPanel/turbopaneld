import type {
  AnsibleEvent,
  AnsiblePlayStartEvent,
  AnsiblePlayStatsEvent,
  AnsibleRawLineStream,
  AnsibleTaskResultEvent,
  AnsibleTaskStartEvent,
} from "./ansible-events.ts";
import { InstallPresenter } from "./install-presenter.ts";
import {
  relabelComponent,
  sanitizeStatusLine,
  summarizeRecap,
} from "./presentation.ts";

function parseTaskName(full: string): { role: string | null; task: string } {
  const colon = full.indexOf(":");
  if (colon === -1) {
    return { role: null, task: full.trim() };
  }
  const role = full.slice(0, colon).trim();
  const task = full.slice(colon + 1).trim();
  if (!role) {
    return { role: null, task: full.trim() };
  }
  return { role, task };
}

function taskLabel(full: string): string {
  const { role, task } = parseTaskName(full);
  const taskPart = sanitizeStatusLine(task);
  if (!role) return taskPart;
  const rolePart = sanitizeStatusLine(relabelComponent(role));
  return `${rolePart} › ${taskPart}`;
}

function hostMessages(
  hosts: Record<string, Record<string, unknown>>,
): string {
  const messages: string[] = [];
  for (const result of Object.values(hosts)) {
    const msg = result.msg;
    if (typeof msg === "string" && msg.length > 0) {
      messages.push(msg);
    }
  }
  return sanitizeStatusLine(messages.join("; "));
}

function buildRecap(stats: Record<string, Record<string, number>>): string {
  let ok = 0;
  let changed = 0;
  let failed = 0;
  let unreachable = 0;
  for (const hostStats of Object.values(stats)) {
    ok += hostStats.ok ?? 0;
    changed += hostStats.changed ?? 0;
    failed += hostStats.failures ?? hostStats.failed ?? 0;
    unreachable += hostStats.unreachable ?? 0;
  }
  return `ok=${ok} changed=${changed} failed=${failed} unreachable=${unreachable}`;
}

/** Maps ansible.posix.jsonl events into {@link InstallPresenter} status lines. */
export class InstallEventPresenter {
  readonly #presenter: InstallPresenter;
  #failureDetail: string | null = null;

  constructor(presenter: InstallPresenter) {
    this.#presenter = presenter;
  }

  get failureDetail(): string | null {
    return this.#failureDetail;
  }

  /** Reset per-step event state when {@link InstallPresenter.beginStep} starts a new step. */
  beginStep(): void {
    this.#failureDetail = null;
  }

  /** Capture quiet-mode stderr / unparseable stdout for presenter detail on failure. */
  onRawLine(stream: AnsibleRawLineStream, line: string): void {
    const sanitized = sanitizeStatusLine(line);
    if (!sanitized) return;

    this.#presenter.pushDetail(line);

    if (!this.#failureDetail) {
      this.#failureDetail = sanitized;
    }

    this.#presenter.pushStatus(line);
  }

  onEvent(event: AnsibleEvent): void {
    switch (event._event) {
      case "v2_playbook_on_play_start": {
        const playEvent = event as AnsiblePlayStartEvent;
        const name = playEvent.play.name.trim() || "play";
        this.#presenter.pushStatus(sanitizeStatusLine(name));
        break;
      }

      case "v2_playbook_on_task_start":
      case "v2_playbook_on_handler_task_start":
      case "v2_runner_on_start": {
        const taskEvent = event as AnsibleTaskStartEvent;
        const rawName = taskEvent.task.name ?? "task";
        this.#presenter.pushStatus(taskLabel(rawName));
        break;
      }

      case "v2_runner_on_ok": {
        const okEvent = event as AnsibleTaskResultEvent;
        const rawName = okEvent.task.name ?? "task";
        const hostResult = Object.values(okEvent.hosts)[0];
        if (hostResult?.changed === true) {
          this.#presenter.pushStatus(`~ ${taskLabel(rawName)}`);
        }
        break;
      }

      case "v2_runner_on_skipped": {
        const skippedEvent = event as AnsibleTaskResultEvent;
        const rawName = skippedEvent.task.name ?? "task";
        this.#presenter.pushStatus(`– ${taskLabel(rawName)}`);
        break;
      }

      case "v2_runner_on_failed":
      case "v2_runner_on_unreachable": {
        const failedEvent = event as AnsibleTaskResultEvent;
        const rawName = failedEvent.task.name ?? "task";
        const detail = hostMessages(
          failedEvent.hosts as Record<string, Record<string, unknown>>,
        ) || "task failed";
        const line = `${taskLabel(rawName)}: ${detail}`;
        this.#failureDetail = line;
        this.#presenter.pushStatus(line, { force: true });
        break;
      }

      case "v2_playbook_on_stats": {
        const statsEvent = event as AnsiblePlayStatsEvent;
        const recap = summarizeRecap(buildRecap(statsEvent.stats));
        this.#presenter.pushStatus(recap, { force: true });
        break;
      }
    }
  }
}

export { InstallPresenter } from "./install-presenter.ts";

export function createInstallPresenter(): InstallPresenter {
  return new InstallPresenter();
}
