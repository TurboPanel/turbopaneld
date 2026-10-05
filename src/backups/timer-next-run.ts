/**
 * When a backup timer next fires, read from systemd without sudo.
 *
 * `systemctl show --timestamp=unix` is ignored by `show` (it prints the local
 * "Tue 2026-10-06 03:25:35 CDT" form on systemd 257), so the next run comes
 * from `systemctl list-timers --output=json`, whose `next` is microseconds
 * since the epoch. Shared by the reconcile handler and the result reporter.
 */

/** `systemctl` arguments that list one timer as JSON, scheduled or not. */
export function timerNextRunArgs(timer: string): string[] {
  return ["list-timers", "--all", "--output=json", "--no-pager", timer];
}

/**
 * The ISO time `timer` next fires, from `list-timers --output=json` output.
 * `undefined` when the timer is absent, not scheduled (`next` missing, null or
 * 0), or the text is not that JSON.
 */
export function parseTimerNextRun(
  stdout: string,
  timer: string,
): string | undefined {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as { unit?: unknown; next?: unknown };
    if (entry.unit !== timer) continue;
    if (typeof entry.next !== "number" || !(entry.next > 0)) return undefined;
    const at = new Date(Math.floor(entry.next / 1000));
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  }
  return undefined;
}
