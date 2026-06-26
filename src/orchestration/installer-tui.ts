import { getBuildInfo } from "../build-info.ts";
import type {
  AnsibleEvent,
  AnsiblePlayStartEvent,
  AnsiblePlayStatsEvent,
  AnsibleTaskResultEvent,
  AnsibleTaskStartEvent,
} from "./ansible-events.ts";

const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DOT_FRAMES = [".", "o", "O", "o"];

interface TaskRow {
  id: string;
  label: string;
  depth: number;
  status: "running" | "ok" | "changed" | "failed" | "skipped";
}

type TaskView = {
  visibleTasks: TaskRow[];
  hiddenCount: number;
  followIndex: number;
};

function parseTaskName(full: string): { role: string | null; task: string } {
  const match = full.match(/^\s*([^:]+)\s*:\s*(.+)$/);
  if (match) {
    return { role: match[1].trim(), task: match[2].trim() };
  }
  return { role: null, task: full.trim() };
}

function taskLabel(full: string): string {
  const { role, task } = parseTaskName(full);
  return role ? `${role} › ${task}` : task;
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
  return messages.join("; ");
}

function buildRecap(stats: Record<string, Record<string, number>>): string {
  let ok = 0;
  let changed = 0;
  let failed = 0;
  for (const hostStats of Object.values(stats)) {
    ok += hostStats.ok ?? 0;
    changed += hostStats.changed ?? 0;
    failed += hostStats.failures ?? hostStats.failed ?? 0;
  }
  return `ok=${ok} changed=${changed} failed=${failed}`;
}

function upsertTask(tasks: TaskRow[], row: TaskRow): void {
  const index = tasks.findIndex((task) => task.id === row.id);
  if (index < 0) {
    tasks.push(row);
  } else {
    tasks[index] = row;
  }
}

function completeRunning(
  tasks: TaskRow[],
  finalStatus: TaskRow["status"],
): void {
  for (const task of tasks) {
    if (task.status === "running") {
      task.status = finalStatus;
    }
  }
}

function pinnedIndices(tasks: TaskRow[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const status = tasks[index]!.status;
    if (status === "running" || status === "failed") {
      indices.push(index);
    }
  }
  return indices;
}

function buildTaskView(tasks: TaskRow[], maxRows: number): TaskView {
  if (tasks.length === 0) {
    return { visibleTasks: [], hiddenCount: 0, followIndex: 0 };
  }

  const budget = Math.max(1, maxRows);
  const needsHidden = tasks.length > budget;
  const windowRows = needsHidden ? Math.max(1, budget - 1) : budget;

  const pinned = pinnedIndices(tasks);
  const focusIndex = pinned.length > 0
    ? pinned[pinned.length - 1]!
    : tasks.length - 1;

  let start = Math.max(0, focusIndex - windowRows + 1);
  let end = start + windowRows;

  if (pinned.length > 0) {
    start = Math.min(start, pinned[0]!);
    end = Math.max(end, pinned[pinned.length - 1]! + 1);
  }

  if (end - start > windowRows) {
    start = Math.max(0, end - windowRows);
  }
  if (end > tasks.length) {
    end = tasks.length;
    start = Math.max(0, end - windowRows);
  }

  const visibleTasks = tasks.slice(start, end);
  const followIndex = Math.min(
    Math.max(0, focusIndex - start),
    Math.max(0, visibleTasks.length - 1),
  );

  return {
    visibleTasks,
    hiddenCount: start,
    followIndex,
  };
}

function spinnerFrames(depth: number): string[] {
  return depth >= 2 ? DOT_FRAMES : BRAILLE_FRAMES;
}

function truncateLabel(label: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (label.length <= maxLen) return label;
  if (maxLen <= 1) return "…";
  return `${label.slice(0, maxLen - 1)}…`;
}

export class InstallerTUI {
  tasks: TaskRow[] = [];
  recap: string | null = null;
  error: string | null = null;
  spinnerFrame = 0;
  intervalId: ReturnType<typeof setInterval> | null = null;
  readonly enc = new TextEncoder();
  #sigintHandler: (() => void) | null = null;

  start(): void {
    Deno.stdout.writeSync(this.enc.encode(HIDE_CURSOR));

    this.#sigintHandler = () => {
      this.finish(false, "Interrupted");
      Deno.exit(130);
    };
    Deno.addSignalListener("SIGINT", this.#sigintHandler);

    this.emitStep("Preparing installation…", "running", "step:prepare");
    this.render();

    this.intervalId = setInterval(() => {
      this.spinnerFrame++;
      this.render();
    }, 100);
  }

  render(): void {
    let columns = 80;
    let rows = 24;
    try {
      const size = Deno.consoleSize();
      columns = size.columns;
      rows = size.rows;
    } catch {
      // fallback defaults
    }

    const build = getBuildInfo();
    const maxTaskRows = Math.max(1, rows - 10);
    const view = buildTaskView(this.tasks, maxTaskRows);

    const lines: string[] = [];
    lines.push(CLEAR + HIDE_CURSOR);
    lines.push("");
    lines.push("  ╭─────────────────────────────────────────╮");
    lines.push("  │  ⚡ TurboPanel  ·  Daemon Installer     │");
    const versionInner = `  v${build.commit} · ${build.channel}`;
    lines.push(`  │${versionInner.padEnd(41)} │`);
    lines.push("  ╰─────────────────────────────────────────╯");
    lines.push("");

    if (view.hiddenCount > 0) {
      lines.push(`  ${DIM}↑ ${view.hiddenCount} earlier step(s) hidden${RESET}`);
    }

    for (const task of view.visibleTasks) {
      const indent = "  ".repeat(task.depth);
      const prefix = "  " + indent;
      const maxLabelLen = columns - prefix.length - 3;
      const label = truncateLabel(task.label, maxLabelLen);

      let glyph: string;
      switch (task.status) {
        case "running": {
          const frames = spinnerFrames(task.depth);
          const frame = frames[this.spinnerFrame % frames.length]!;
          const color = task.depth >= 2 ? YELLOW : CYAN;
          glyph = `${color}${frame}${RESET}`;
          break;
        }
        case "ok":
          glyph = `${GREEN}✓${RESET}`;
          break;
        case "changed":
          glyph = `${YELLOW}~${RESET}`;
          break;
        case "failed":
          glyph = `${RED}✗${RESET}`;
          break;
        case "skipped":
          glyph = `${DIM}–${RESET}`;
          break;
      }

      lines.push(`${prefix}${glyph} ${label}`);
    }

    const ruleWidth = Math.min(columns - 4, 41);
    lines.push("");
    lines.push(`  ${"─".repeat(ruleWidth)}`);

    const lastRunning = [...this.tasks].reverse().find((t) =>
      t.status === "running"
    );

    if (this.error) {
      lines.push(`  ${RED}${BOLD}✗ Error${RESET} ${this.error}`);
    } else if (this.recap) {
      lines.push(`  ${DIM}${this.recap}${RESET}`);
    } else if (lastRunning) {
      lines.push(`  ▸ ${lastRunning.label}`);
    }

    lines.push("");

    Deno.stdout.writeSync(this.enc.encode(lines.join("\n")));
  }

  onEvent(event: AnsibleEvent): void {
    switch (event._event) {
      case "v2_playbook_on_play_start": {
        const playEvent = event as AnsiblePlayStartEvent;
        const name = playEvent.play.name.trim() || "play";
        const playId = `play:${playEvent.play.id}`;
        for (const task of this.tasks) {
          if (task.depth === 1 && task.status === "running") {
            task.status = "ok";
          }
        }
        upsertTask(this.tasks, {
          id: playId,
          label: name,
          status: "running",
          depth: 1,
        });
        break;
      }

      case "v2_playbook_on_task_start":
      case "v2_playbook_on_handler_task_start":
      case "v2_runner_on_start": {
        const taskEvent = event as AnsibleTaskStartEvent;
        const rawName = taskEvent.task.name ?? "task";
        const id = `task:${taskEvent.task.id}`;
        upsertTask(this.tasks, {
          id,
          label: taskLabel(rawName),
          status: "running",
          depth: 2,
        });
        break;
      }

      case "v2_runner_on_ok": {
        const okEvent = event as AnsibleTaskResultEvent;
        const rawName = okEvent.task.name ?? "task";
        const id = `task:${okEvent.task.id}`;
        const hostResult = Object.values(okEvent.hosts)[0];
        const changed = hostResult?.changed === true;
        upsertTask(this.tasks, {
          id,
          label: taskLabel(rawName),
          status: changed ? "changed" : "ok",
          depth: 2,
        });
        break;
      }

      case "v2_runner_on_skipped": {
        const skippedEvent = event as AnsibleTaskResultEvent;
        const rawName = skippedEvent.task.name ?? "task";
        const id = `task:${skippedEvent.task.id}`;
        upsertTask(this.tasks, {
          id,
          label: taskLabel(rawName),
          status: "skipped",
          depth: 2,
        });
        break;
      }

      case "v2_runner_on_failed":
      case "v2_runner_on_unreachable": {
        const failedEvent = event as AnsibleTaskResultEvent;
        const rawName = failedEvent.task.name ?? "task";
        const id = `task:${failedEvent.task.id}`;
        upsertTask(this.tasks, {
          id,
          label: taskLabel(rawName),
          status: "failed",
          depth: 2,
        });
        this.error = hostMessages(
          failedEvent.hosts as Record<string, Record<string, unknown>>,
        ) || "task failed";
        break;
      }

      case "v2_playbook_on_stats": {
        const statsEvent = event as AnsiblePlayStatsEvent;
        let failed = 0;
        for (const hostStats of Object.values(statsEvent.stats)) {
          failed += hostStats.failures ?? hostStats.failed ?? 0;
        }
        const finalStatus: TaskRow["status"] = failed > 0 ? "failed" : "ok";
        completeRunning(this.tasks, finalStatus);
        this.recap = buildRecap(statsEvent.stats);
        break;
      }
    }
  }

  emitStep(
    label: string,
    status: TaskRow["status"],
    id?: string,
  ): void {
    const stepId = id ?? `step:${label}`;
    if (status === "running") {
      for (const task of this.tasks) {
        if (
          task.depth === 0 && task.status === "running" && task.id !== stepId
        ) {
          task.status = "ok";
        }
      }
    }
    upsertTask(this.tasks, { id: stepId, label, status, depth: 0 });
  }

  finish(ok: boolean, message: string): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (ok) {
      completeRunning(this.tasks, "ok");
      if (!this.recap) {
        this.recap = message;
      }
    } else {
      completeRunning(this.tasks, "failed");
      this.error = message;
    }

    this.render();
    Deno.stdout.writeSync(this.enc.encode(SHOW_CURSOR));

    if (this.#sigintHandler) {
      Deno.removeSignalListener("SIGINT", this.#sigintHandler);
      this.#sigintHandler = null;
    }
  }
}

export function createInstallerTui(): InstallerTUI | null {
  if (!Deno.stdout.isTerminal()) {
    return null;
  }
  return new InstallerTUI();
}
