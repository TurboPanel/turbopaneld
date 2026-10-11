/**
 * Small text helpers for error messages that must keep the **cause**.
 *
 * Tools print the cause last (the failing step, then the reason), so every
 * clip here keeps the end of the text and drops the start.
 */

/** Longest single cause line an error message carries. */
export const MAX_ERROR_LINE_CHARS = 300;

/** The last `count` non-empty lines of `text`, oldest first. */
export function lastNonEmptyLines(text: string, count: number): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(
    -count,
  );
}

/** Collapse all whitespace (newlines, tabs, runs of spaces) to single spaces. */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/** Keep the last `max` characters of `text`, marking the cut with a leading ellipsis. */
export function clipKeepingEnd(
  text: string,
  max: number = MAX_ERROR_LINE_CHARS,
): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max + 1)}`;
}
