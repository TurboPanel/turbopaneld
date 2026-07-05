import {
  sanitizeStatusLine,
  shouldDropPresenterLogLine,
} from "./presentation.ts";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[90m";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Visible rolling status lines under the active step header. */
const STATUS_WINDOW_SIZE = 5;

/** Buffered sanitized lines revealed only on failure. */
const DETAIL_TAIL_MAX = 80;

export interface PushStatusOptions {
  /** Show even when {@link shouldDropPresenterLogLine} would drop the line. */
  force?: boolean;
}

export class InstallPresenter {
  readonly #enc = new TextEncoder();
  readonly #isTTY: boolean;

  #stepLabel: string | null = null;
  #spinnerFrame = 0;
  #intervalId: ReturnType<typeof setInterval> | null = null;
  #sigintHandler: (() => void) | null = null;
  #renderedLines = 0;
  #statusWindow: string[] = [];
  readonly #detailTail: string[] = [];
  #lastPipedLine: string | null = null;
  #active = false;

  constructor(isTTY: boolean = Deno.stdout.isTerminal()) {
    this.#isTTY = isTTY;
  }

  beginStep(label: string): void {
    this.#stopSpinner();
    this.#stepLabel = label;
    this.#statusWindow = [];
    this.#detailTail.length = 0;
    this.#renderedLines = 0;
    this.#lastPipedLine = null;
    this.#active = true;

    if (this.#isTTY) {
      Deno.stdout.writeSync(this.#enc.encode(HIDE_CURSOR));
      this.#installSigintHandler();
      this.#startSpinner();
      this.#renderTTY();
      return;
    }

    this.#writeStdout(`${this.#formatStepLine(false)}\n`);
  }

  /** Append a sanitized line to the failure detail tail only (no status window). */
  pushDetail(rawLine: string): void {
    if (!this.#active) return;

    const sanitized = sanitizeStatusLine(rawLine);
    if (!sanitized) return;

    this.#appendDetailTail(sanitized);
  }

  pushStatus(rawLine: string, opts?: PushStatusOptions): void {
    if (!this.#active) return;

    const sanitized = sanitizeStatusLine(rawLine);
    if (!sanitized) return;

    this.#appendDetailTail(sanitized);

    const keep = opts?.force === true || !shouldDropPresenterLogLine(rawLine);
    if (!keep) return;

    this.#statusWindow.push(sanitized);
    if (this.#statusWindow.length > STATUS_WINDOW_SIZE) {
      this.#statusWindow.shift();
    }

    if (this.#isTTY) {
      this.#renderTTY();
      return;
    }

    if (sanitized === this.#lastPipedLine) return;
    this.#lastPipedLine = sanitized;
    this.#writeStdout(`  ${sanitized}\n`);
  }

  completeStep(ok: boolean, summary?: string): void {
    if (!this.#active) return;

    const label = this.#stepLabel ?? "step";
    const message = summary ?? (ok ? label : `${label} failed`);
    this.#finishRollingRegion();
    this.#writeOutcome(ok, message);
    this.#active = false;
  }

  fail(detail: string): void {
    const label = this.#stepLabel ?? "step";
    const message = sanitizeStatusLine(detail) || `${label} failed`;

    if (!this.#active) {
      this.#writeOutcome(false, message);
      return;
    }

    this.#finishRollingRegion();
    this.#writeOutcome(false, message);

    const tail = this.#detailTail.filter((line) => line.length > 0);
    if (tail.length === 0) return;

    const sink = this.#stderrSink();
    for (const line of tail) {
      sink.writeSync(this.#enc.encode(`  ${line}\n`));
    }
    this.#active = false;
  }

  /** Restore cursor and stop timers (safe to call multiple times). */
  dispose(): void {
    this.#stopSpinner();
    this.#removeSigintHandler();
    if (this.#isTTY) {
      Deno.stdout.writeSync(this.#enc.encode(SHOW_CURSOR));
    }
    this.#active = false;
  }

  #appendDetailTail(line: string): void {
    this.#detailTail.push(line);
    if (this.#detailTail.length > DETAIL_TAIL_MAX) {
      this.#detailTail.shift();
    }
  }

  #formatStepLine(animated: boolean): string {
    const label = this.#stepLabel ?? "";
    if (!this.#isTTY) {
      return `▸ ${label}`;
    }
    const frame = animated
      ? ` ${CYAN}${BRAILLE_FRAMES[this.#spinnerFrame % BRAILLE_FRAMES.length]!}${RESET}`
      : "";
    return `${CYAN}▸${RESET} ${label}${frame}`;
  }

  #buildTTYLines(): string[] {
    const lines = [this.#formatStepLine(true)];
    for (const status of this.#statusWindow) {
      lines.push(`${DIM}  ${status}${RESET}`);
    }
    return lines;
  }

  #renderTTY(): void {
    if (this.#renderedLines > 0) {
      for (let i = 0; i < this.#renderedLines; i++) {
        Deno.stdout.writeSync(this.#enc.encode("\x1b[1A\x1b[2K"));
      }
    }

    const lines = this.#buildTTYLines();
    Deno.stdout.writeSync(this.#enc.encode(`${lines.join("\n")}\n`));
    this.#renderedLines = lines.length;
  }

  #finishRollingRegion(): void {
    this.#stopSpinner();
    if (this.#isTTY && this.#renderedLines > 0) {
      for (let i = 0; i < this.#renderedLines; i++) {
        Deno.stdout.writeSync(this.#enc.encode("\x1b[1A\x1b[2K"));
      }
      this.#renderedLines = 0;
    }
    this.#removeSigintHandler();
    if (this.#isTTY) {
      Deno.stdout.writeSync(this.#enc.encode(SHOW_CURSOR));
    }
  }

  #writeOutcome(ok: boolean, message: string): void {
    if (ok) {
      if (this.#isTTY) {
        this.#writeStdout(`${GREEN}✓${RESET} ${message}\n`);
      } else {
        this.#writeStdout(`✓ ${message}\n`);
      }
      return;
    }

    const sink = this.#stderrSink();
    if (this.#isTTY) {
      sink.writeSync(this.#enc.encode(`${RED}✗${RESET} ${message}\n`));
    } else {
      sink.writeSync(this.#enc.encode(`✗ ${message}\n`));
    }
  }

  #writeStdout(text: string): void {
    Deno.stdout.writeSync(this.#enc.encode(text));
  }

  #stderrSink(): typeof Deno.stderr {
    return Deno.stderr;
  }

  #startSpinner(): void {
    this.#intervalId = setInterval(() => {
      this.#spinnerFrame += 1;
      if (this.#active && this.#isTTY) {
        this.#renderTTY();
      }
    }, 100);
  }

  #stopSpinner(): void {
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }

  #installSigintHandler(): void {
    if (this.#sigintHandler) return;
    this.#sigintHandler = () => {
      this.dispose();
      Deno.exit(130);
    };
    Deno.addSignalListener("SIGINT", this.#sigintHandler);
  }

  #removeSigintHandler(): void {
    if (!this.#sigintHandler) return;
    Deno.removeSignalListener("SIGINT", this.#sigintHandler);
    this.#sigintHandler = null;
  }
}
