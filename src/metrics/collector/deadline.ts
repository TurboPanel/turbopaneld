/** Default per-source deadline inside one collect (statfs, scrapes, GPU, events, host text). */
export const SOURCE_DEADLINE_MS = 10_000;

/**
 * Resolve with `work`'s value, or with `fallback` once `ms` passes. The
 * abandoned work keeps running in the background (a blocked syscall cannot be
 * cancelled) but can no longer hold up the collect; its late result and any
 * late rejection are ignored. A rejection inside the deadline propagates.
 */
export function withDeadline<T>(
  work: Promise<T> | T,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
