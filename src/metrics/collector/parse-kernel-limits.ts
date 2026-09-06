/**
 * Kernel resource-limit gauges: allocated file handles
 * (`/proc/sys/fs/file-nr` / `file-max`) and conntrack table usage
 * (`/proc/sys/net/netfilter/nf_conntrack_count` / `nf_conntrack_max`). Both
 * are point-in-time gauges — no baseline tracking needed. Absence of a
 * source (conntrack module not loaded) resolves to `null`, never `0`: the
 * absence of conntrack support is not 0% utilization.
 */

function parseFirstInteger(text: string): number | null {
  const match = /-?\d+/.exec(text);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** First field of `/proc/sys/fs/file-nr` — currently allocated file handles. */
export function parseFileNr(text: string): number | null {
  const firstField = text.trim().split(/\s+/)[0];
  if (firstField === undefined) return null;
  return parseFirstInteger(firstField);
}

/** `/proc/sys/fs/file-max` — the single-integer file-handle ceiling. */
export function parseFileMax(text: string): number | null {
  return parseFirstInteger(text);
}

export function fileHandlesUsedPercent(
  fileNr: number | null,
  fileMax: number | null,
): number | null {
  if (fileNr === null || fileMax === null || fileMax <= 0) return null;
  const percent = (fileNr / fileMax) * 100;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}

/** `/proc/sys/net/netfilter/nf_conntrack_count` — the single-integer current entry count. */
export function parseConntrackCount(text: string): number | null {
  return parseFirstInteger(text);
}

/** `/proc/sys/net/netfilter/nf_conntrack_max` — the single-integer table ceiling. */
export function parseConntrackMax(text: string): number | null {
  return parseFirstInteger(text);
}

export function conntrackUsedPercent(
  count: number | null,
  max: number | null,
): number | null {
  if (count === null || max === null || max <= 0) return null;
  const percent = (count / max) * 100;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}
