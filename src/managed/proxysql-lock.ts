/**
 * Serialises everything that brings the shared ProxySQL compose project up or
 * down: `managed.ingress.reconcile`, the `system.reconcile` self-heal and the
 * boot repair (`proxysql-boot-repair.ts`). Once any of the first two has run
 * since daemon start, the boot repair stands down: the control plane has
 * spoken, so its desired state wins over the compose file left on disk.
 */

let tail: Promise<unknown> = Promise.resolve();
let touched = false;

export function withProxySqlLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

/** Record that a reconcile took over the ProxySQL stack this daemon run. */
export function markProxySqlReconciled(): void {
  touched = true;
}

export function proxySqlReconciledSinceStart(): boolean {
  return touched;
}

/** Test hook. */
export function resetProxySqlLockForTests(): void {
  tail = Promise.resolve();
  touched = false;
}
