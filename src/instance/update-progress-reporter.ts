import { dirname, join } from "@std/path";
import type {
  UpdateProgressMessage,
  UpdateProgressStage,
  UpdateProgressUnit,
} from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { resolveLayout } from "../paths/layout.ts";

const STAGE_MARKER_PREFIX = "::turbopanel-stage::";
const QUEUE_FILE = "progress-queue.jsonl";
const MAX_QUEUE_LINES = 64;
const MAX_QUEUE_BYTES = 256 * 1024;

export function parseTurbopanelStageLine(
  line: string,
): UpdateProgressStage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(STAGE_MARKER_PREFIX)) return null;
  const stage = trimmed.slice(STAGE_MARKER_PREFIX.length).trim();
  switch (stage) {
    case "preparing":
    case "downloading":
    case "installing":
    case "restarting":
    case "verifying":
    case "done":
    case "failed":
    case "rolled-back":
      return stage;
    default:
      return null;
  }
}

type PendingProgress = Omit<UpdateProgressMessage, "type" | "at">;

export type UpdateProgressPersist = {
  mkdir: (path: string) => Promise<void>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, data: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
};

export type UpdateProgressReporterOptions = {
  layout?: LayoutPaths;
  stateDir?: string;
  /** Correlated update / instance-update request id. */
  progressId?: string;
  upgradeId?: string;
  canSend?: () => boolean;
  send?: (message: UpdateProgressMessage) => boolean;
  persist?: UpdateProgressPersist;
};

const defaultPersist: UpdateProgressPersist = {
  mkdir: (path) => Deno.mkdir(path, { recursive: true }),
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: (path, data) => Deno.writeTextFile(path, data),
  remove: (path) => Deno.remove(path),
};

/**
 * Fire-and-forget upgrade progress. Queues on disk when the socket is down or
 * the peer does not advertise `update-progress-v1`.
 */
export class UpdateProgressReporter {
  readonly #queuePath: string;
  readonly #persist: UpdateProgressPersist;
  #progressId: string | undefined;
  #upgradeId: string | undefined;
  #canSend: () => boolean;
  #send: (message: UpdateProgressMessage) => boolean;
  readonly #memory: PendingProgress[] = [];
  #persistChain: Promise<void> = Promise.resolve();

  constructor(options: UpdateProgressReporterOptions = {}) {
    const layout = options.layout ?? resolveLayout();
    const stateDir = options.stateDir ?? layout.stateDir;
    this.#queuePath = join(stateDir, "update", QUEUE_FILE);
    this.#progressId = options.progressId;
    this.#upgradeId = options.upgradeId;
    this.#canSend = options.canSend ?? (() => false);
    this.#send = options.send ?? (() => false);
    this.#persist = options.persist ?? defaultPersist;
  }

  setContext(context: {
    progressId?: string;
    upgradeId?: string;
    canSend?: () => boolean;
    send?: (message: UpdateProgressMessage) => boolean;
  }): void {
    if (context.progressId !== undefined) this.#progressId = context.progressId;
    if (context.upgradeId !== undefined) this.#upgradeId = context.upgradeId;
    if (context.canSend) this.#canSend = context.canSend;
    if (context.send) this.#send = context.send;
  }

  reportStage(
    unit: UpdateProgressUnit,
    stage: UpdateProgressStage,
    options: {
      upgradeId?: string;
      detail?: string;
      errorCode?: string;
    } = {},
  ): void {
    const progressId = this.#progressId;
    if (!progressId) return;
    const payload: PendingProgress = {
      id: progressId,
      unit,
      stage,
      ...(options.upgradeId ?? this.#upgradeId
        ? { upgradeId: options.upgradeId ?? this.#upgradeId }
        : {}),
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    };
    this.#memory.push(payload);
    while (this.#memory.length > MAX_QUEUE_LINES) {
      this.#memory.shift();
    }
    const sent = this.#trySendPayload(payload);
    if (sent) {
      this.#dropFromMemory(payload);
      void this.#enqueuePersist(() => this.#rewriteDiskFromMemory());
    } else {
      void this.#enqueuePersist(() => this.#appendDisk(payload));
    }
  }

  async flush(): Promise<void> {
    await this.#persistChain;
  }

  async flushOnAttach(): Promise<void> {
    await this.flush();
    await this.#loadDiskIntoMemory();
    const pending = [...this.#memory];
    for (const payload of pending) {
      if (!this.#trySendPayload(payload)) return;
      this.#dropFromMemory(payload);
    }
    await this.#enqueuePersist(() => this.#rewriteDiskFromMemory());
  }

  #enqueuePersist(op: () => Promise<void>): Promise<void> {
    const next = this.#persistChain.then(op, op);
    this.#persistChain = next.then(() => undefined, () => undefined);
    return next;
  }

  #trySendPayload(payload: PendingProgress): boolean {
    if (!this.#canSend()) return false;
    const message: UpdateProgressMessage = {
      type: "update-progress",
      at: new Date().toISOString(),
      ...payload,
    };
    if (!this.#send(message)) return false;
    return true;
  }

  #dropFromMemory(payload: PendingProgress): void {
    const index = this.#memory.indexOf(payload);
    if (index >= 0) this.#memory.splice(index, 1);
  }

  async #appendDisk(payload: PendingProgress): Promise<void> {
    try {
      await this.#persist.mkdir(dirname(this.#queuePath));
      const line = `${JSON.stringify(payload)}\n`;
      const existing = await this.#persist.readTextFile(this.#queuePath).catch(
        () => "",
      );
      let combined = existing + line;
      if (combined.length > MAX_QUEUE_BYTES) {
        const lines = combined.split("\n").filter((l) => l.trim());
        combined = lines.slice(-MAX_QUEUE_LINES).join("\n") + "\n";
      }
      await this.#persist.writeTextFile(this.#queuePath, combined);
    } catch {
      // Progress is best-effort; update-result remains authoritative.
    }
  }

  async #loadDiskIntoMemory(): Promise<void> {
    try {
      const text = await this.#persist.readTextFile(this.#queuePath);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as PendingProgress;
          if (parsed.id && parsed.unit && parsed.stage) {
            const duplicate = this.#memory.some(
              (entry) =>
                entry.id === parsed.id &&
                entry.unit === parsed.unit &&
                entry.stage === parsed.stage &&
                entry.upgradeId === parsed.upgradeId,
            );
            if (!duplicate) this.#memory.push(parsed);
          }
        } catch {
          // Skip corrupt lines.
        }
      }
      while (this.#memory.length > MAX_QUEUE_LINES) {
        this.#memory.shift();
      }
    } catch {
      // No queue file yet.
    }
  }

  async #rewriteDiskFromMemory(): Promise<void> {
    if (this.#memory.length === 0) {
      try {
        await this.#persist.remove(this.#queuePath);
      } catch {
        // Already absent.
      }
      return;
    }
    const body = this.#memory.map((p) => JSON.stringify(p)).join("\n") + "\n";
    try {
      await this.#persist.mkdir(dirname(this.#queuePath));
      await this.#persist.writeTextFile(this.#queuePath, body);
    } catch {
      // Best-effort.
    }
  }
}
