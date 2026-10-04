/**
 * Two small helpers shared by the gate's files.
 *
 * Dependency-free on purpose (see http.ts).
 */

/**
 * Run `step` again and again, one run at a time, for as long as it resolves
 * `true`: a read / relay / accept loop (`while (…) { await … }`) without the
 * `await` in a loop. It stops when `step` resolves `false` (the `break` /
 * `return`) or rejects (the `throw`, which rejects the result).
 *
 * Each run is chained with a plain callback rather than by returning the next
 * run's promise, so a loop that lives as long as a stream (`docker events`,
 * a `logs -f`, an attach) does not accumulate one pending promise per turn.
 * Same shape as `repeatSequential` in the daemon's `src/util/sequential.ts`;
 * the gate cannot import from `src/`, so it carries its own copy.
 */
export function repeatSequential(
  step: () => Promise<boolean>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const next = (): void => {
      step().then((again) => {
        if (again) next();
        else resolve();
      }).catch(reject);
    };
    next();
  });
}

/** `name: message` for an Error; a fixed text for anything else (never `[object Object]`). */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return typeof err === "string" ? err : "non-error value thrown";
}
