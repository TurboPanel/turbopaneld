/**
 * Is this host the control plane's own host?
 *
 * The control plane's own tunnel token (`tunnel-token`) and its public URLs
 * (`public-urls-update`) are taken only here. The answer comes from
 * root-owned files, never from `daemon.env` or anything a message can change:
 * the root-owned control plane binary at `/opt/turbopanel/bin/turbopanel`
 * (the same test as `tp_colocated_host` in `tp-orchestrate`). A development
 * install (this daemon runs from its own source checkout) with
 * `TURBOPANEL_DEV_INSTANCE=1` runs the control plane from source beside it and
 * counts as well.
 */
import { join } from "@std/path";
import {
  detectInstallMode,
  type InstallMode,
  PROD_BIN_DIR_DEFAULT,
  readEnv,
} from "../paths/layout.ts";

/**
 * The installed control plane binary. The fixed install path on purpose:
 * `TURBOPANEL_BIN_DIR` / `TURBOPANEL_HOME` come from `daemon.env`, which does
 * not decide this.
 */
export const CONTROL_PLANE_BINARY_PATH = join(
  PROD_BIN_DIR_DEFAULT,
  "turbopanel",
);

export type ControlPlaneHostProbe = {
  /** `Deno.lstat`: a symlink is not a regular file, so it never counts. */
  lstat?: (path: string) => Promise<Pick<Deno.FileInfo, "isFile" | "uid">>;
  /** Process env, read only for `TURBOPANEL_DEV_INSTANCE`. */
  env?: Record<string, string | undefined>;
  /** Install mode decided by where this code runs from, never by env. */
  mode?: InstallMode;
  /** Binary to check (tests). */
  binaryPath?: string;
};

/** True when the root-owned control plane binary is installed on this host. */
export async function hasRootOwnedControlPlaneBinary(
  probe: ControlPlaneHostProbe = {},
): Promise<boolean> {
  const lstat = probe.lstat ?? Deno.lstat;
  try {
    const info = await lstat(probe.binaryPath ?? CONTROL_PLANE_BINARY_PATH);
    return info.isFile && info.uid === 0;
  } catch {
    return false;
  }
}

/** True on a development install that runs the control plane beside it. */
export function isDevelopmentControlPlaneHost(
  probe: ControlPlaneHostProbe = {},
): boolean {
  const mode = probe.mode ?? detectInstallMode({}, { skipDiscovery: true });
  if (mode !== "development") return false;
  // One named variable: production grants only `TURBOPANEL_*` env reads.
  const flag = probe.env
    ? probe.env.TURBOPANEL_DEV_INSTANCE
    : readEnv("TURBOPANEL_DEV_INSTANCE");
  return flag?.trim() === "1";
}

/** Whether this daemon runs on the control plane's own host. */
export async function isControlPlaneHost(
  probe: ControlPlaneHostProbe = {},
): Promise<boolean> {
  if (isDevelopmentControlPlaneHost(probe)) return true;
  return await hasRootOwnedControlPlaneBinary(probe);
}
