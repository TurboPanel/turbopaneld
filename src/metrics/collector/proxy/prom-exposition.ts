/**
 * Minimal Prometheus text-exposition parser + loopback fetch helper shared by
 * the Caddy and ProxySQL traffic scrapers. Deliberately not a general-purpose
 * OpenMetrics parser — just enough to read `# HELP`/`# TYPE`-annotated
 * `name{labels} value` lines from a trusted, same-host loopback source.
 */

export type PromSample = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

const SAMPLE_LINE = /^([a-zA-Z_:][\w:]*)(\{(.*)\})?\s+(\S+)$/;

function isLabelNameStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isLabelNameChar(ch: string): boolean {
  return isLabelNameStart(ch) || (ch >= "0" && ch <= "9");
}

/**
 * Scan a double-quoted label value whose opening quote sits at `start`.
 * Only `\"` and `\\` are unescaped; any other backslash pair is kept
 * verbatim. Returns `undefined` when no closing quote is found.
 */
function scanQuotedValue(
  blob: string,
  start: number,
): { value: string; end: number } | undefined {
  const parts: string[] = [];
  let runStart = start + 1;
  let i = runStart;
  while (i < blob.length) {
    const ch = blob[i];
    if (ch === '"') {
      parts.push(blob.slice(runStart, i));
      return { value: parts.join(""), end: i + 1 };
    }
    if (ch !== "\\") {
      i += 1;
      continue;
    }
    if (i + 1 >= blob.length) return undefined;
    const escaped = blob[i + 1]!;
    parts.push(
      blob.slice(runStart, i),
      escaped === '"' || escaped === "\\" ? escaped : ch + escaped,
    );
    i += 2;
    runStart = i;
  }
  return undefined;
}

/**
 * Single-pass `name="value"` pair scanner. Hand-rolled instead of a regex so
 * the run time stays linear in the blob length on malformed input (Sonar
 * typescript:S5852). Pairs may be separated by arbitrary junk, and a value
 * runs greedily to the first unescaped `"`.
 */
function parseLabels(blob: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < blob.length) {
    if (!isLabelNameStart(blob[i]!)) {
      i += 1;
      continue;
    }
    const nameStart = i;
    while (i < blob.length && isLabelNameChar(blob[i]!)) i += 1;
    // No pair can start inside the name run: every suffix meets the same
    // terminator, so skipping the whole run keeps the scan linear.
    if (blob[i] !== "=" || blob[i + 1] !== '"') continue;
    const scanned = scanQuotedValue(blob, i + 1);
    // An unterminated value means no later pair can close either: a later
    // opening quote directly follows `=`, so it would have closed this one.
    if (!scanned) break;
    labels[blob.slice(nameStart, i)] = scanned.value;
    i = scanned.end;
  }
  return labels;
}

/** Parse Prometheus text exposition into flat samples; malformed lines are skipped. */
export function parsePrometheusExposition(text: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = SAMPLE_LINE.exec(line);
    if (!match) continue;
    const value = Number(match[4]);
    if (!Number.isFinite(value)) continue;
    samples.push({
      name: match[1]!,
      labels: match[3] ? parseLabels(match[3]) : {},
      value,
    });
  }
  return samples;
}

/** Sum every sample matching `name` (and optional `predicate` over its labels). */
export function sumSamples(
  samples: readonly PromSample[],
  name: string,
  predicate?: (labels: Record<string, string>) => boolean,
): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.name !== name) continue;
    if (predicate && !predicate(sample.labels)) continue;
    total += sample.value;
  }
  return total;
}

/** Count samples matching `name` and `predicate` — for status-enum gauges, not sums. */
export function countSamples(
  samples: readonly PromSample[],
  name: string,
  predicate: (labels: Record<string, string>, value: number) => boolean,
): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.name !== name) continue;
    if (predicate(sample.labels, sample.value)) total += 1;
  }
  return total;
}

/**
 * Whether at least one sample's name is in `names` — gates a scrape as
 * belonging to the expected source rather than an empty body or an
 * unrelated service answering on the same loopback port.
 */
export function containsAnyMetricName(
  samples: readonly PromSample[],
  names: readonly string[],
): boolean {
  const nameSet = new Set(names);
  return samples.some((sample) => nameSet.has(sample.name));
}

const FETCH_TIMEOUT_MS = 3_000;

/**
 * `GET http://<addr><path>` with a short timeout; `undefined` on any
 * network failure, non-2xx status, or timeout. Never throws.
 */
export async function fetchLoopbackText(
  addr: string,
  path: string,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${addr}${path}`, {
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
