/**
 * Step reporter for one `environment.deploy`: holds the step plan, marks
 * steps running / done / failed / skipped with timestamps, keeps the live
 * `detail` line of the running step, and sends the whole payload to the
 * control plane as a `command-progress` cell message after every change.
 *
 * Delivery is best effort (fire-and-forget over the open socket, like
 * `update-progress`); a lost message is harmless because the next one carries
 * the whole payload again. `detail` changes alone go out at most once every
 * {@link DEPLOY_PROGRESS_DETAIL_INTERVAL_MS}; the next transition carries the
 * latest text, so nothing is scheduled and no timer can leak.
 */
import {
  COMMAND_PROGRESS_MAX_BYTES,
  COMMAND_PROGRESS_MAX_DETAIL_CHARS,
  COMMAND_PROGRESS_MAX_ID_CHARS,
  COMMAND_PROGRESS_MAX_LABEL_CHARS,
  COMMAND_PROGRESS_MAX_STEPS,
  type CommandProgress,
  type CommandProgressMessage,
  type CommandProgressStep,
  type DaemonMessage,
} from "../contracts/cell-messages.ts";
import {
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
} from "../logs/contracts.ts";
import type {
  AnsibleEvent,
  AnsibleEventHandler,
  AnsibleTaskResultEvent,
  AnsibleTaskStartEvent,
} from "../orchestration/ansible-events.ts";
import { ansibleFailureLine } from "../orchestration/ansible-failure.ts";

export const DEPLOY_PROGRESS_DETAIL_INTERVAL_MS = 2000;

/** A planned step: id + label + whether the host already has it. */
export type PlannedDeployStep = Pick<CommandProgressStep, "id" | "label"> & {
  state: "ready" | "pending";
};

export type DeployProgressOutcome = "succeeded" | "failed" | "cancelled";

export type DeployStepReporter = {
  /** Replace the plan and send it. Steps beyond the wire cap are dropped. */
  plan(steps: readonly PlannedDeployStep[]): void;
  /**
   * Mark steps running (`current` is the first). A `ready` or already finished
   * step is left alone, so wrapping an idempotent `ensureX` twice is safe.
   */
  start(ids: string | readonly string[]): void;
  done(ids: string | readonly string[]): void;
  fail(ids: string | readonly string[]): void;
  /** Live ticker text of a running step; throttled on the wire. */
  detail(id: string, text: string): void;
  /**
   * Follow a transcript phase: `fetch` / `build` / `compose-up` / `health`
   * start their step (finishing the one running before). Other phases are
   * left to the explicit calls.
   */
  phase(phase: string): void;
  /**
   * Final payload before the outcome: a running step becomes `done`,
   * `failed` or `skipped` (cancel) and every `pending` step `skipped`.
   */
  finish(outcome: DeployProgressOutcome): void;
  /** The payload as it would be sent now. */
  snapshot(): CommandProgress;
  /** False for the no-op reporter: nothing is planned or probed for it. */
  readonly enabled: boolean;
};

export type DeployStepReporterOptions = {
  /** Correlation id of the dispatch (`command-dispatch.id`). */
  id: string;
  commandId: string;
  /** Returns false when the socket is not open; the payload is just dropped. */
  send: (message: CommandProgressMessage) => boolean;
  /** Test seam — wall clock. */
  now?: () => Date;
};

/** Transcript phases that are also steps of the plan. */
const PHASE_STEPS: Readonly<Record<string, string>> = {
  [COMMAND_LOG_PHASES.FETCH]: "fetch",
  [COMMAND_LOG_PHASES.BUILD]: "build",
  [COMMAND_LOG_PHASES.COMPOSE_UP]: "start",
  [COMMAND_LOG_PHASES.HEALTH]: "health",
};

/** What the running step becomes when the deploy ends. */
const RUNNING_AT_FINISH: Readonly<
  Record<DeployProgressOutcome, "done" | "failed" | "skipped">
> = {
  succeeded: "done",
  failed: "failed",
  cancelled: "skipped",
};

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function idList(ids: string | readonly string[]): readonly string[] {
  return typeof ids === "string" ? [ids] : ids;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Keep the payload inside the wire caps: step count, id / label / detail
 * lengths, then the whole serialised size — first by dropping `detail` from
 * every step but the running one, then every `detail`, then the finished
 * steps' timestamps. Exported for the size-cap test.
 */
export function clampCommandProgress(
  progress: CommandProgress,
): CommandProgress {
  const steps = progress.steps.slice(0, COMMAND_PROGRESS_MAX_STEPS).map(
    (step) => ({
      ...step,
      id: clip(step.id, COMMAND_PROGRESS_MAX_ID_CHARS),
      label: clip(step.label, COMMAND_PROGRESS_MAX_LABEL_CHARS),
      ...(step.detail === undefined
        ? {}
        : { detail: clip(step.detail, COMMAND_PROGRESS_MAX_DETAIL_CHARS) }),
    }),
  );
  const current = steps.some((step) => step.id === progress.current)
    ? progress.current
    : null;
  const clamped: CommandProgress = { ...progress, steps, current };
  const trims: Array<(step: CommandProgressStep) => CommandProgressStep> = [
    (step) => step.state === "running" ? step : { ...step, detail: undefined },
    (step) => ({ ...step, detail: undefined }),
    (step) =>
      step.state === "running"
        ? step
        : { ...step, startedAt: undefined, finishedAt: undefined },
  ];
  for (const trim of trims) {
    if (encodedBytes(clamped) <= COMMAND_PROGRESS_MAX_BYTES) break;
    clamped.steps = clamped.steps.map(trim);
  }
  return clamped;
}

/** `JSON.stringify` drops `undefined` fields; strip them so snapshots compare. */
function definedStep(step: CommandProgressStep): CommandProgressStep {
  return JSON.parse(JSON.stringify(step)) as CommandProgressStep;
}

class DeployStepReporterImpl implements DeployStepReporter {
  readonly enabled = true;
  readonly #id: string;
  readonly #commandId: string;
  readonly #send: (message: CommandProgressMessage) => boolean;
  readonly #now: () => Date;
  #steps: CommandProgressStep[] = [];
  #current: string | null = null;
  #lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(options: DeployStepReporterOptions) {
    this.#id = options.id;
    this.#commandId = options.commandId;
    this.#send = options.send;
    this.#now = options.now ?? (() => new Date());
  }

  plan(steps: readonly PlannedDeployStep[]): void {
    this.#steps = steps.slice(0, COMMAND_PROGRESS_MAX_STEPS).map((step) => ({
      id: step.id,
      label: step.label,
      state: step.state,
    }));
    this.#current = null;
    this.#sendNow();
  }

  start(ids: string | readonly string[]): void {
    const started = idList(ids).filter((id) => {
      const step = this.#find(id);
      return step !== undefined && step.state === "pending";
    });
    if (started.length === 0) return;
    const at = this.#now().toISOString();
    // One thing runs at a time: whatever was running before has finished.
    for (const step of this.#steps) {
      if (step.state === "running" && !started.includes(step.id)) {
        this.#close(step, "done", at);
      }
    }
    for (const id of started) {
      const step = this.#find(id);
      if (!step) continue;
      step.state = "running";
      step.startedAt = at;
      delete step.finishedAt;
    }
    this.#current = started[0];
    this.#sendNow();
  }

  done(ids: string | readonly string[]): void {
    this.#finishSteps(ids, "done");
  }

  fail(ids: string | readonly string[]): void {
    this.#finishSteps(ids, "failed");
  }

  detail(id: string, text: string): void {
    const step = this.#find(id);
    if (!step || step.state !== "running") return;
    const trimmed = text.trim();
    if (trimmed.length === 0 || step.detail === trimmed) return;
    step.detail = clip(trimmed, COMMAND_PROGRESS_MAX_DETAIL_CHARS);
    const now = this.#now().getTime();
    if (now - this.#lastSentAt >= DEPLOY_PROGRESS_DETAIL_INTERVAL_MS) {
      this.#sendNow();
    }
  }

  phase(phase: string): void {
    const id = PHASE_STEPS[phase];
    if (id === undefined) return;
    const step = this.#find(id);
    if (!step) return;
    // A phase that comes round again (one fetch per release, the native-app
    // health before the container one) reopens its step.
    if (step.state === "done") step.state = "pending";
    this.start(id);
  }

  finish(outcome: DeployProgressOutcome): void {
    const at = this.#now().toISOString();
    const running = RUNNING_AT_FINISH[outcome];
    let changed = false;
    for (const step of this.#steps) {
      if (step.state === "running") {
        this.#close(step, running, at);
        changed = true;
      } else if (step.state === "pending" && outcome !== "succeeded") {
        step.state = "skipped";
        changed = true;
      }
    }
    this.#current = null;
    if (changed) this.#sendNow();
  }

  snapshot(): CommandProgress {
    return clampCommandProgress({
      version: 1,
      steps: this.#steps.map(definedStep),
      current: this.#current,
      updatedAt: this.#now().toISOString(),
    });
  }

  #find(id: string): CommandProgressStep | undefined {
    return this.#steps.find((step) => step.id === id);
  }

  #close(
    step: CommandProgressStep,
    state: "done" | "failed" | "skipped",
    at: string,
  ): void {
    step.state = state;
    step.finishedAt = at;
    delete step.detail;
    if (this.#current === step.id) this.#current = null;
  }

  #finishSteps(
    ids: string | readonly string[],
    state: "done" | "failed",
  ): void {
    const at = this.#now().toISOString();
    let changed = false;
    for (const id of idList(ids)) {
      const step = this.#find(id);
      if (!step || step.state !== "running") continue;
      this.#close(step, state, at);
      changed = true;
    }
    if (changed) this.#sendNow();
  }

  #sendNow(): void {
    const at = this.#now();
    this.#lastSentAt = at.getTime();
    try {
      this.#send({
        type: "command-progress",
        id: this.#id,
        commandId: this.#commandId,
        at: at.toISOString(),
        progress: this.snapshot(),
      });
    } catch {
      // Progress is best effort; the outcome message stays authoritative.
    }
  }
}

export function createDeployStepReporter(
  options: DeployStepReporterOptions,
): DeployStepReporter {
  return new DeployStepReporterImpl(options);
}

/**
 * Reporter for callers without a command socket (tests, CLI, other command
 * handlers): every method is a no-op and `enabled` is false, so the deploy
 * neither plans nor probes.
 */
export function createNoopDeployStepReporter(): DeployStepReporter {
  return {
    enabled: false,
    plan() {},
    start() {},
    done() {},
    fail() {},
    detail() {},
    phase() {},
    finish() {},
    snapshot: () => ({
      version: 1,
      steps: [],
      current: null,
      updatedAt: new Date(0).toISOString(),
    }),
  };
}

/**
 * Playbook events of one install step: every task start is one transcript
 * line and the step's ticker text; a failure carries its message. Raw
 * playbook stdout never reaches the transcript. Works with the no-op reporter
 * too, so the transcript lines do not depend on a command socket.
 */
export function createPlaybookEventHandler(
  sink: CommandOutputSink,
  progress: Pick<DeployStepReporter, "detail">,
  stepId: string,
): AnsibleEventHandler {
  return (event: AnsibleEvent) => {
    switch (event._event) {
      case "v2_playbook_on_task_start": {
        const name = (event as AnsibleTaskStartEvent).task.name;
        sink.onLine("stdout", name);
        progress.detail(stepId, name);
        break;
      }
      case "v2_runner_on_failed":
      case "v2_runner_on_unreachable": {
        const line = ansibleFailureLine(event as AnsibleTaskResultEvent);
        if (line === null) break;
        sink.onLine("stderr", line);
        progress.detail(stepId, line);
        break;
      }
      default:
        break;
    }
  };
}

/**
 * Send one fire-and-forget cell message on an open socket — the same guard
 * `update-progress` uses. False when the socket is not open.
 */
export function sendOverOpenSocket(
  ws: Pick<WebSocket, "readyState" | "send">,
  message: DaemonMessage,
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}
