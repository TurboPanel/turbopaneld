import {
  getActiveInstallPresenter,
} from "../orchestration/install-presenter-context.ts";
import {
  relabelComponent,
  sanitizeStatusLine,
  shouldDropPresenterLogLine,
} from "../orchestration/presentation.ts";

const encoder = new TextEncoder();

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const PRESENTER_ROUTED_COMPONENTS = new Set([
  "orchestration",
  "ansible",
  "ansible-galaxy",
  "ansible-core",
  "galaxy",
  "uv",
  "python",
]);

function shouldRouteLogThroughPresenter(component: string): boolean {
  if (!getActiveInstallPresenter()) return false;
  if (PRESENTER_ROUTED_COMPONENTS.has(component)) return true;
  return relabelComponent(component) === "orchestration" ||
    relabelComponent(component) === "runtime";
}

function routeLogThroughPresenter(
  level: LogLevel,
  message: string,
): boolean {
  const presenter = getActiveInstallPresenter();
  if (!presenter) return false;

  if (level === "DEBUG") {
    return true;
  }

  const sanitized = sanitizeStatusLine(message);
  if (!sanitized) {
    return true;
  }

  presenter.pushDetail(message);

  if (!shouldDropPresenterLogLine(message)) {
    presenter.pushStatus(message);
  }

  return true;
}

const ESC = 0x1b;
const BEL = 0x07;

/** Index just past a CSI sequence (`ESC [ params intermediates final`) starting at `start` (the `[`). */
function endOfCsi(text: string, start: number): number {
  let i = start + 1;
  while (
    i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x3f
  ) i++;
  while (
    i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f
  ) i++;
  const final = text.charCodeAt(i);
  return final >= 0x40 && final <= 0x7e ? i + 1 : i;
}

/** Index just past an OSC/DCS/SOS/PM/APC string (ends at BEL or `ESC \`; unterminated eats the rest). */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === BEL) return i + 1;
    if (code === ESC) return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i;
  }
  return text.length;
}

/** Index just past the escape sequence whose ESC is at `esc`. */
function endOfEscape(text: string, esc: number): number {
  const next = text.charCodeAt(esc + 1);
  if (next === 0x5b) return endOfCsi(text, esc + 1);
  if (
    next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e ||
    next === 0x5f
  ) {
    return endOfString(text, esc + 1);
  }
  return next >= 0x40 && next <= 0x5f ? esc + 2 : esc + 1;
}

/** C0 (except tab/CR/LF, handled by the caller), DEL and C1 controls. */
function isLoneControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Remove terminal escape sequences (ANSI CSI/OSC/...) outright and replace any
 * other control character with `_`, so transcripts cannot repaint, retitle or
 * beep a reader's terminal. Newline, CR and tab pass through untouched (the
 * caller maps them).
 */
export function stripTerminalControls(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC) {
      i = endOfEscape(text, i);
    } else {
      out += isLoneControl(code) ? "_" : text[i];
      i++;
    }
  }
  return out;
}

/** Chained replace pattern Sonar S5145 recognizes for log-injection sanitization. */
export function stripLogInjection(text: string): string {
  return stripTerminalControls(text)
    .replaceAll("\n", "_")
    .replaceAll("\r", "_")
    .replaceAll("\t", "_");
}

/**
 * `unknown` (typically a caught throw) rendered as text.
 *
 * Deliberately not `String(value)`: a thrown plain object stringifies to
 * `[object Object]`, which loses the only detail the catch site had. One
 * definition so every call site renders the same shape.
 */
export function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value.toString();
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    // circular or otherwise unserializable
  }
  return "[unserializable]";
}

export function sanitizeForLog(value: unknown): string {
  return stripLogInjection(errorText(value));
}

function formatParts(parts: unknown[]): string {
  return parts.map(sanitizeForLog).join(" ");
}

function splitMessageLines(message: string): string[] {
  const normalized = message.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length > 0 ? lines : [""];
}

function formatStructuredLine(
  level: LogLevel,
  component: string,
  message: string,
): string {
  return `${new Date().toISOString()} ${level} ${component}  ${message}\n`;
}

export function log(
  level: LogLevel,
  component: string,
  ...parts: unknown[]
): void {
  const message = formatParts(parts);

  if (shouldRouteLogThroughPresenter(component)) {
    routeLogThroughPresenter(level, message);
    return;
  }

  const out = level === "INFO" || level === "DEBUG" ? Deno.stdout : Deno.stderr;

  for (const line of splitMessageLines(message)) {
    out.writeSync(encoder.encode(formatStructuredLine(level, component, line)));
  }
}

export function logInfo(component: string, ...parts: unknown[]): void {
  log("INFO", component, ...parts);
}

export function logDebug(component: string, ...parts: unknown[]): void {
  log("DEBUG", component, ...parts);
}

export function logWarn(component: string, ...parts: unknown[]): void {
  log("WARN", component, ...parts);
}

export function logError(component: string, ...parts: unknown[]): void {
  log("ERROR", component, ...parts);
}
