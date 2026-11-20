/**
 * One daemon-side lock for everything that edits or judges the host firewall:
 * the managed-ruleset apply / confirm / remove / re-hang path (`apply.ts`,
 * `confirm.ts`) and the legacy managed public-listener installer
 * (`../managed/firewall.ts`). The installer decides whether the legacy
 * `TP-MGD-*` chain is redundant by reading the live `TP-FWD` rules; a ruleset
 * that is armed between the pending-marker check and that read would make
 * unconfirmed rules look like cover. Serialising the two closes that window.
 *
 * In-process only (a promise chain, like `withProxySqlLock`). The xtables lock
 * (`-w`) still covers single iptables calls against other processes; the
 * `turbopaneld firewall ...` break-glass CLI is a separate process and
 * re-checks the pending marker after its read instead.
 *
 * Not re-entrant: a function that holds the lock must not call another
 * exported function that takes it. Lock at the exported entry points only.
 */

let tail: Promise<unknown> = Promise.resolve();

export function withFirewallLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

/** Test hook. */
export function resetFirewallLockForTests(): void {
  tail = Promise.resolve();
}
