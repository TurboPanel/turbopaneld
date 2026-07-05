import {
  getActiveInstallPresenter,
} from "./orchestration/install-presenter-context.ts";
import {
  relabelComponent,
  sanitizeStatusLine,
  shouldDropPresenterLogLine,
} from "./orchestration/presentation.ts";

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

/** Chained replace pattern Sonar S5145 recognizes for log-injection sanitization. */
export function stripLogInjection(text: string): string {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("\t", "_");
}

export function sanitizeForLog(value: unknown): string {
  if (value instanceof Error) return stripLogInjection(value.message);
  if (typeof value === "string") return stripLogInjection(value);
  try {
    return stripLogInjection(JSON.stringify(value) ?? String(value));
  } catch {
    return stripLogInjection(String(value));
  }
}

function formatParts(parts: unknown[]): string {
  return parts.map(String).join(" ");
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
