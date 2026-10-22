/**
 * Step reporter for one `environment.deploy`: holds the step plan, marks
 * steps running / done / failed / skipped with timestamps, keeps the live
 * `detail` line of the running step, and sends the whole payload to the
 * control plane as a `command-progress` cell message after every change.
 *
 * Delivery is best effort (fire-and-forget over the open socket, like
 * `update-progress`); a lost message is harmless because the next one carries
 * the whole payload again. `detail` changes alone go out at most once every
 * {@link DEPLOY_PROGRESS_DETAIL_INTERVAL_MS}: a change inside the window is
 * stored and flushed by one trailing timer when the window ends (a long task
 * such as a package install must not run for minutes with no ticker), and any
 * transition clears that timer because it carries the latest text itself.
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
import { definedFields } from "../util/optional-fields.ts";

export const DEPLOY_PROGRESS_DETAIL_INTERVAL_MS = 2000;

/**
 * While a deploy waits for another build it says so again this often, so the
 * control plane can tell a deploy that is still queued here from one this
 * server lost (a restart empties the build line).
 */
export const DEPLOY_PROGRESS_WAITING_BEAT_MS = 60_000;

/**
 * While a deploy runs, the whole payload is sent again this often (when the
 * control plane advertises `command-recovery-v1`), so a quiet build is told
 * apart from a lost link.
 */
export const DEPLOY_PROGRESS_KEEPALIVE_MS = 30_000;

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
   * Whatever was running before is finished, unless `nested` is set: an
   * install that happens inside a phase step (the build tool mid-`build`)
   * keeps that step running and hands `current` back to it afterwards.
   */
  start(ids: string | readonly string[], options?: { nested?: boolean }): void;
  done(ids: string | readonly string[]): void;
  /**
   * The step(s) failed. A `ready` step whose ensure still failed is marked
   * failed too; a running step this one was nested in goes back to pending
   * (it never ran), so the final payload shows it skipped.
   */
  fail(ids: string | readonly string[]): void;
  /**
   * Live ticker text; throttled on the wire. When `id` is not the running
   * step (a grouped install whose first step was already `ready`) the text
   * goes to the step that is running.
   */
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
  /**
   * Tell the control plane whether the deploy is running (`true`: its run
   * deadline counts from now) or waiting for the host (`false`: another build
   * holds the build slot, nothing counts, and the state is repeated every
   * minute). Each resume after a wait starts a new run segment on the control
   * plane; time spent waiting is never counted. Sent at once, and a repeat of
   * the same state is dropped.
   */
  running(active: boolean): void;
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
  /** Test seams — the trailing detail flush timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called with every payload that is sent (the journal keeps the latest). */
  onSnapshot?: (progress: CommandProgress) => void;
  /** True when the running payload should be repeated as a keepalive. */
  keepalive?: () => boolean;
  keepaliveMs?: number;
};

/**
 * Transcript phases that are also steps of the plan. Promote and the deploy
 * hooks are part of starting the new version: they close `build` and keep
 * `start` going until the health check.
 */
const PHASE_STEPS: Readonly<Record<string, string>> = {
  [COMMAND_LOG_PHASES.FETCH]: "fetch",
  [COMMAND_LOG_PHASES.BUILD]: "build",
  [COMMAND_LOG_PHASES.RELEASE_PROMOTE]: "start",
  [COMMAND_LOG_PHASES.PRE_DEPLOY]: "start",
  [COMMAND_LOG_PHASES.COMPOSE_UP]: "start",
  [COMMAND_LOG_PHASES.POST_DEPLOY]: "start",
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

/** A copy without the `undefined` fields, so snapshots compare as sent. */
function definedStep(step: CommandProgressStep): CommandProgressStep {
  return definedFields({ ...step });
}

class DeployStepReporterImpl implements DeployStepReporter {
  readonly enabled = true;
  readonly #id: string;
  readonly #commandId: string;
  readonly #send: (message: CommandProgressMessage) => boolean;
  readonly #now: () => Date;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #steps: CommandProgressStep[] = [];
  #current: string | null = null;
  /** The phase step a nested install interrupted; `current` returns to it. */
  #resume: string | null = null;
  /** `undefined` until the first {@link running} call. */
  #runningSince: string | null | undefined = undefined;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #flushTimer: unknown = undefined;
  #beatTimer: unknown = undefined;
  #keepaliveTimer: unknown = undefined;
  readonly #onSnapshot: ((progress: CommandProgress) => void) | undefined;
  readonly #keepalive: (() => boolean) | undefined;
  readonly #keepaliveMs: number;

  constructor(options: DeployStepReporterOptions) {
    this.#id = options.id;
    this.#commandId = options.commandId;
    this.#send = options.send;
    this.#now = options.now ?? (() => new Date());
    this.#setTimer = options.setTimer ??
      ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ??
      ((handle) => clearTimeout(handle as number));
    this.#onSnapshot = options.onSnapshot;
    this.#keepalive = options.keepalive;
    this.#keepaliveMs = options.keepaliveMs ?? DEPLOY_PROGRESS_KEEPALIVE_MS;
  }

  plan(steps: readonly PlannedDeployStep[]): void {
    this.#steps = steps.slice(0, COMMAND_PROGRESS_MAX_STEPS).map((step) => ({
      id: step.id,
      label: step.label,
      state: step.state,
    }));
    this.#current = null;
    this.#resume = null;
    this.#sendNow();
  }

  start(
    ids: string | readonly string[],
    options: { nested?: boolean } = {},
  ): void {
    const started = idList(ids).filter((id) =>
      this.#find(id)?.state === "pending"
    );
    if (started.length === 0) return;
    const at = this.#now().toISOString();
    if (options.nested) {
      // The enclosing step keeps running; `current` comes back to it.
      if (this.#current !== null && !started.includes(this.#current)) {
        this.#resume = this.#current;
      }
    } else {
      // One thing runs at a time: whatever was running before has finished.
      for (const step of this.#steps) {
        if (step.state === "running" && !started.includes(step.id)) {
          this.#close(step, "done", at);
        }
      }
      this.#resume = null;
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
    const named = this.#find(id);
    const step = named?.state === "running" ? named : this.#running();
    if (!step) return;
    const trimmed = text.trim();
    if (trimmed.length === 0 || step.detail === trimmed) return;
    step.detail = clip(trimmed, COMMAND_PROGRESS_MAX_DETAIL_CHARS);
    const elapsed = this.#now().getTime() - this.#lastSentAt;
    if (elapsed >= DEPLOY_PROGRESS_DETAIL_INTERVAL_MS) {
      this.#sendNow();
    } else if (this.#flushTimer === undefined) {
      this.#flushTimer = this.#setTimer(() => {
        this.#flushTimer = undefined;
        if (this.#running()) this.#sendNow();
      }, DEPLOY_PROGRESS_DETAIL_INTERVAL_MS - elapsed);
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
    this.#stopWaitingBeat();
    this.#stopKeepalive();
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
    this.#resume = null;
    if (changed) this.#sendNow();
    else this.#cancelFlush();
  }

  running(active: boolean): void {
    if (
      active
        ? typeof this.#runningSince === "string"
        : this.#runningSince === null
    ) return;
    this.#runningSince = active ? this.#now().toISOString() : null;
    this.#startKeepalive();
    this.#sendNow();
    this.#stopWaitingBeat();
    if (!active) this.#startWaitingBeat();
  }

  #startKeepalive(): void {
    if (this.#keepalive === undefined || this.#keepaliveTimer !== undefined) {
      return;
    }
    this.#keepaliveTimer = this.#setTimer(() => {
      this.#keepaliveTimer = undefined;
      if (this.#runningSince !== null && this.#keepalive?.()) this.#sendNow();
      this.#startKeepalive();
    }, this.#keepaliveMs);
  }

  #stopKeepalive(): void {
    if (this.#keepaliveTimer === undefined) return;
    this.#clearTimer(this.#keepaliveTimer);
    this.#keepaliveTimer = undefined;
  }

  #startWaitingBeat(): void {
    this.#beatTimer = this.#setTimer(() => {
      this.#beatTimer = undefined;
      if (this.#runningSince !== null) return;
      this.#sendNow();
      this.#startWaitingBeat();
    }, DEPLOY_PROGRESS_WAITING_BEAT_MS);
  }

  #stopWaitingBeat(): void {
    if (this.#beatTimer === undefined) return;
    this.#clearTimer(this.#beatTimer);
    this.#beatTimer = undefined;
  }

  snapshot(): CommandProgress {
    return clampCommandProgress({
      version: 1,
      steps: this.#steps.map(definedStep),
      current: this.#current,
      updatedAt: this.#now().toISOString(),
      ...(this.#runningSince === undefined
        ? {}
        : { runningSince: this.#runningSince }),
    });
  }

  #find(id: string): CommandProgressStep | undefined {
    return this.#steps.find((step) => step.id === id);
  }

  /** The current step while it runs, else any running step. */
  #running(): CommandProgressStep | undefined {
    const current = this.#current === null
      ? undefined
      : this.#find(this.#current);
    if (current?.state === "running") return current;
    return this.#steps.find((step) => step.state === "running");
  }

  #close(
    step: CommandProgressStep,
    state: "done" | "failed" | "skipped",
    at: string,
  ): void {
    step.state = state;
    step.finishedAt = at;
    // A failure keeps its last line: it says which task broke.
    if (state !== "failed") delete step.detail;
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
      if (!step) continue;
      const failedWhileReady = state === "failed" && step.state === "ready";
      if (step.state !== "running" && !failedWhileReady) continue;
      this.#close(step, state, at);
      changed = true;
    }
    if (!changed) return;
    const resume = this.#resume === null ? undefined : this.#find(this.#resume);
    if (resume?.state === "running") {
      if (state === "failed") {
        // The enclosing step never ran: back to pending, skipped at finish.
        resume.state = "pending";
        delete resume.startedAt;
      } else if (this.#current === null) {
        this.#current = resume.id;
      }
    }
    if (this.#current === null) this.#resume = null;
    this.#sendNow();
  }

  #cancelFlush(): void {
    if (this.#flushTimer === undefined) return;
    this.#clearTimer(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  #sendNow(): void {
    this.#cancelFlush();
    const at = this.#now();
    this.#lastSentAt = at.getTime();
    const progress = this.snapshot();
    try {
      this.#onSnapshot?.(progress);
    } catch {
      // The journal copy is best effort too.
    }
    try {
      this.#send({
        type: "command-progress",
        id: this.#id,
        commandId: this.#commandId,
        at: at.toISOString(),
        progress,
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
    running() {},
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
        const raw = ansibleFailureLine(event as AnsibleTaskResultEvent);
        if (raw === null) break;
        // A module message can quote a value the deploy decrypted; the
        // transcript redacts on its own, the ticker goes out as-is.
        const line = sink.redactSummary(raw);
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
