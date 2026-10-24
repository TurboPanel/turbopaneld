/**
 * The first start of a new managed server connects to the control plane while
 * its boot converge (`daemon-converge.yml`) is still running, so the panel sees
 * the host within seconds instead of after the whole converge. Commands from
 * the control plane must not run playbooks on top of that converge, so command
 * dispatch waits here until it has finished (whether it worked or not).
 */

let pending: Promise<void> | undefined;

/** Remember a running boot converge; its outcome (or failure) only releases waiters. */
export function trackBootConverge(run: Promise<boolean>): void {
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  pending = settled;
  void settled.then(() => {
    if (pending === settled) pending = undefined;
  });
}

/** Resolves at once when no boot converge is running, else when it has finished. */
export function bootConvergeSettled(): Promise<void> {
  return pending ?? Promise.resolve();
}

/** Test seam. */
export function resetBootConvergeForTests(): void {
  pending = undefined;
}
