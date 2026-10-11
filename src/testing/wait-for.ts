/**
 * Test-only helper: poll a condition instead of sleeping a fixed time.
 *
 * A fixed sleep is a guess about how slow the runner is; this returns the
 * moment the condition holds and fails with a clear message after `timeoutMs`.
 */
export async function waitFor(
  what: string,
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
