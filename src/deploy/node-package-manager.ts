/**
 * Normalize operator- or UI-supplied Node package-manager invocations for
 * environments where only Corepack is on PATH (native-app release builds).
 */
export function normalizeNodePackageManagerCommand(command: string): string {
  const trimmed = command.trimStart();
  if (trimmed.startsWith("corepack ")) return command;
  if (/^pnpm(?:\s|$)/.test(trimmed)) {
    return `corepack ${trimmed}`;
  }
  if (/^yarn(?:\s|$)/.test(trimmed)) {
    return `corepack ${trimmed}`;
  }
  return command;
}

/** Bare `pnpm|yarn|npm start` — no extra args. */
const PACKAGE_MANAGER_START_RE =
  /^(?:corepack\s+)?(?:pnpm|yarn|npm)\s+start\s*$/;

/**
 * Resolve the shell command for a native app's systemd `ExecStart`.
 *
 * Bare package-manager `start` scripts run through the vendored Node binary's
 * `--run` so runtime never invokes Corepack (it would try to cache under
 * `$HOME/.cache`, which is not writable under the unit's hardening). Any other
 * pnpm/yarn invocation still goes through Corepack with `COREPACK_HOME` pointed
 * at the app's writable `shared/` tree.
 */
export function resolveNativeAppRuntimeStartCommand(
  command: string,
  nodeBinary: string,
): string {
  const trimmed = command.trim();
  if (PACKAGE_MANAGER_START_RE.test(trimmed)) {
    return `${nodeBinary} --run start`;
  }
  return normalizeNodePackageManagerCommand(trimmed);
}
