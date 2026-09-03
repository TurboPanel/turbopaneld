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
const LABEL_PAIR = /([a-zA-Z_]\w*)="((?:[^"\\]|\\.)*)"/g;

function parseLabels(blob: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of blob.matchAll(LABEL_PAIR)) {
    labels[match[1]!] = match[2]!.replaceAll(String.raw`\"`, '"').replaceAll(
      String.raw`\\`,
      "\\",
    );
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
