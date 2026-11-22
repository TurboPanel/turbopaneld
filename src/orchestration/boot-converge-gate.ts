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

let running = 0;
let idle: (() => void)[] = [];

/** Run a command that got past the gate; a converge retry waits for it. */
export async function withCommandRunning<T>(
  work: () => Promise<T>,
): Promise<T> {
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    if (running === 0) {
      const waiting = idle;
      idle = [];
      for (const resolve of waiting) resolve();
    }
  }
}

/** Resolves when no command that got past the gate is still running. */
export function commandsDrained(): Promise<void> {
  if (running === 0) return Promise.resolve();
  return new Promise((resolve) => idle.push(resolve));
}

/** Test seam. */
export function resetBootConvergeForTests(): void {
  pending = undefined;
  running = 0;
  idle = [];
}
