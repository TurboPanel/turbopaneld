import { isInstallPresenterActive } from "./install-presenter-context.ts";

/**
 * Installer-facing presentation helpers: relabel vendor components, scrub leaked
 * tool names from status text, drop firehose detail, and summarize Ansible recaps.
 *
 * Pure functions only — no Deno IO — so callers (presenter, event/log funnels) can
 * import and unit-test without side effects.
 */

/** Maps internal log/event component names to neutral installer-facing labels. */
export const COMPONENT_VOCABULARY: Readonly<Record<string, string>> = {
  ansible: "orchestration",
  "ansible-galaxy": "orchestration",
  "ansible-core": "orchestration",
  galaxy: "orchestration",
  uv: "runtime",
  python: "runtime",
};

const NEUTRAL_COMPONENTS = new Set(["orchestration", "installer"]);

/** Relabel a structured log/event component to a neutral term. */
export function relabelComponent(component: string): string {
  if (NEUTRAL_COMPONENTS.has(component)) {
    return component;
  }
  return COMPONENT_VOCABULARY[component] ?? component;
}

/**
 * Relabel vendor components only while the installer presenter is active.
 * Preserves original component names in daemon.log during normal converge.
 */
export function logComponent(component: string): string {
  return isInstallPresenterActive() ? relabelComponent(component) : component;
}

/** Case-insensitive whole-word token replacements for free-text status lines. */
const STATUS_TOKEN_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\brabbit\s+mq\b/gi, "queue"],
  [/\brabbitmq\b/gi, "queue"],
  [/\bansible-galaxy\b/gi, "orchestration"],
  [/\bansible-core\b/gi, "orchestration"],
  [/\bansible\b/gi, "orchestration"],
  [/\bredis\b/gi, "cache"],
  [/\bcpython\b/gi, "runtime"],
  [/\bgalaxy\b/gi, "orchestration"],
  [/\bpython\b/gi, "runtime"],
  [/\buv\b/gi, "runtime"],
];

function sanitizeStatusFragment(text: string): string {
  let result = text;
  for (const [pattern, replacement] of STATUS_TOKEN_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Scrub leaked vendor/tool names from a display status line. */
export function sanitizeStatusLine(text: string): string {
  const parts: string[] = [];
  const pathPattern = /\/[^\s]+/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pathPattern)) {
    const start = match.index!;
    if (start > lastIndex) {
      parts.push(sanitizeStatusFragment(text.slice(lastIndex, start)));
    }
    parts.push(match[0]);
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(sanitizeStatusFragment(text.slice(lastIndex)));
  }

  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Sanitize status text only while the installer presenter is active. */
export function presentStatusLine(text: string): string {
  return isInstallPresenterActive() ? sanitizeStatusLine(text) : text;
}

const DROP_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*\+\s+[^=\s]+==\S+\s*$/,
  /^(?:Resolved|Prepared|Installed)\s+\d+\s+packages/i,
  /^Using CPython/i,
  /^Using runtime/i,
  /^Creating virtual environment/i,
  /^Activate with:/i,
  /^Using Python \S+ environment at:/i,
  /^Using runtime \S+ environment at:/i,
  /^Downloading \S+ to \/\S*tmp/i,
  /^Process install dependency map/i,
  /^Starting(?: \S+)+ install process/i,
];

function isBareTempOrVendorPathEcho(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) {
    return false;
  }
  return (
    /\/tmp(?:\/|$)/.test(trimmed) ||
    /\/vendor(?:\/|$)/.test(trimmed)
  );
}

/** Return true when a raw status line is installer noise and should not be shown. */
export function shouldDropStatusLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  if (isBareTempOrVendorPathEcho(trimmed)) {
    return true;
  }
  return DROP_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** High-level orchestration logInfo lines that should not appear under step headers. */
const PRESENTER_ORCHESTRATION_DROP_PATTERNS: readonly RegExp[] = [
  /^creating venv at /i,
  /^installing packages from /i,
  /^downloading .+ from /i,
  /^ensuring Python .+ is installed/i,
  /^ensuring runtime .+ is installed/i,
  /^installing galaxy (?:roles|collections) from /i,
  /^installing orchestration (?:roles|collections) from /i,
  /^ansible already installed/i,
  /^orchestration already installed/i,
  /^galaxy content up to date/i,
  /^orchestration content up to date/i,
  /^uv .+ already installed/i,
  /^runtime .+ already installed/i,
  /^uv .+ found, replacing with pinned /i,
  /^runtime .+ found, replacing with pinned /i,
  /^uv archive checksum verified/i,
  /^runtime archive checksum verified/i,
  /^uv .+ installed at /i,
  /^runtime .+ installed at /i,
  /^Python .+ ready at /i,
  /^runtime .+ ready at /i,
  /^ansible installed$/i,
  /^orchestration installed$/i,
  /^galaxy (?:roles|collections) ready$/i,
  /^orchestration (?:roles|collections) ready$/i,
  /^bootstrap inputs unchanged/i,
];

/** Stricter drop filter for orchestration log lines routed into the installer presenter. */
export function shouldDropPresenterLogLine(text: string): boolean {
  if (shouldDropStatusLine(text)) {
    return true;
  }
  const trimmed = text.trim();
  return PRESENTER_ORCHESTRATION_DROP_PATTERNS.some((pattern) =>
    pattern.test(trimmed)
  );
}

const RECAP_STATS_PATTERN =
  /\bok=(\d+)\b.*?\bchanged=(\d+)\b.*?\bfailed=(\d+)\b(?:.*?\bunreachable=(\d+)\b)?/;

/** Turn an Ansible recap string into a neutral one-liner for installers. */
export function summarizeRecap(recap: string): string {
  const trimmed = recap.trim();
  const statsPart = trimmed.split(";")[0]!.trim();
  const match = RECAP_STATS_PATTERN.exec(statsPart);
  if (!match) {
    return sanitizeStatusLine(trimmed);
  }

  const ok = Number(match[1]);
  const changed = Number(match[2]);
  const failed = Number(match[3]);
  const unreachable = match[4] ? Number(match[4]) : 0;
  const failures = failed + unreachable;

  if (failures > 0) {
    const failureLabel = failures === 1 ? "failure" : "failures";
    return `orchestration failed (${failures} ${failureLabel}, ${ok} steps, ${changed} changes)`;
  }

  return `orchestration applied (${ok} steps, ${changed} changes)`;
}
