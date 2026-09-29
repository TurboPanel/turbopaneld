/**
 * Run async steps one at a time, in order — for work where each step must
 * finish before the next starts (ordered writes, dependent reads, rate limits,
 * stop-at-first-failure). Written as promise chains, not `for … await`, so the
 * ordering is explicit at the call site instead of hiding in a loop. Work that
 * is genuinely independent should use `Promise.all` instead.
 *
 * Each helper stops at the first rejection: later steps are never started,
 * exactly like a `for` loop that awaits each step.
 */

/** Await `step(item, index)` for each item, in order. */
export function forEachSequential<T>(
  items: Iterable<T>,
  step: (item: T, index: number) => unknown,
): Promise<void> {
  return [...items].reduce<Promise<void>>(
    (chain, item, index) =>
      chain.then(async () => {
        await step(item, index);
      }),
    Promise.resolve(),
  );
}

/** Like `Array.map`, but each `step` starts after the previous one settled. */
export function mapSequential<T, R>(
  items: Iterable<T>,
  step: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  return [...items].reduce<Promise<R[]>>(
    (chain, item, index) =>
      chain.then(async (results) => {
        results.push(await step(item, index));
        return results;
      }),
    Promise.resolve([]),
  );
}

/**
 * The first result that is neither `undefined` nor `null`, trying the items in order and
 * never starting a step once one has produced a result (an early `return` /
 * `break` out of a `for … await` loop). A step that resolves `null` counts as
 * "no result yet", the same as `undefined`, so the next item is tried.
 */
export function firstSequential<T, R>(
  items: Iterable<T>,
  step: (item: T, index: number) => Promise<R | undefined> | R | undefined,
): Promise<R | undefined> {
  return [...items].reduce<Promise<R | undefined>>(
    (chain, item, index) => chain.then((found) => found ?? step(item, index)),
    Promise.resolve(undefined),
  );
}

/**
 * Run `step` again and again, one run at a time, for as long as it resolves
 * `true` — a poll / retry / reconnect loop (`while (…) { await … }`) without
 * the `await` in a loop. It stops when `step` resolves `false` (the `break` /
 * `return`) or rejects (the `throw`, which rejects the result).
 *
 * Unlike a recursive `async` function, each run is chained with a plain
 * callback rather than by returning the next run's promise, so a loop that
 * lives for the whole process (a reconnect loop) does not accumulate one
 * pending promise per turn.
 */
export function repeatSequential(
  step: () => Promise<boolean>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const next = (): void => {
      // The executor turns a synchronous throw from `step` into a rejection.
      new Promise<boolean>((turnDone) => turnDone(step())).then((again) => {
        if (again) next();
        else resolve();
      }, reject);
    };
    next();
  });
}
