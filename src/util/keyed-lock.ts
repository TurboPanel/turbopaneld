/**
 * One-at-a-time execution per key, in this process. A second caller with the
 * same key waits for the first to finish (success or failure); different keys
 * run side by side.
 */

const tails = new Map<string, Promise<void>>();

export async function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** The key the deploy, lifecycle and stop handlers share for one environment. */
export function environmentLockKey(environmentId: string): string {
  return `environment:${environmentId}`;
}
