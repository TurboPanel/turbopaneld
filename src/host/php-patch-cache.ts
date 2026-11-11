/**
 * What the PHP patch pass last learned, held for the presence snapshot.
 *
 * `collectPresenceSnapshot` runs on every idle tick and must stay cheap, so it
 * reads this cache and nothing else: no file, no process. The pass
 * (`deploy/site/php-patch-restart.ts`) fills it.
 */

export type PhpPatchRestartError = {
  series: string;
  environmentId?: string;
  composeServiceName?: string;
  message: string;
  at: string;
};

export type PhpPatchSite = {
  environmentId: string;
  composeServiceName: string;
  series: string;
  version?: string;
  outdated?: true;
};

export type PhpPatchSnapshot = {
  /** Installed patch version by series (`{ "8.4": "8.4.27" }`). */
  versions: Record<string, string>;
  /** Per-site runtimes with the version each runs; at most 256. */
  sites: PhpPatchSite[];
  restartError?: PhpPatchRestartError;
};

let snapshot: PhpPatchSnapshot = { versions: {}, sites: [] };

/** The last result of a pass, synchronously. */
export function phpPatchSnapshot(): PhpPatchSnapshot {
  return snapshot;
}

export function setPhpPatchSnapshot(next: PhpPatchSnapshot): void {
  snapshot = next;
}
