/**
 * The SMB mount helper (`mount.cifs`, package `cifs-utils`) a deploy with
 * network share volumes needs on the host (`network-shares-v1`).
 *
 * The install goes through the same root path as the other host packages: the
 * `smb-tools-setup.yml` playbook, run by `tp-orchestrate`. It is idempotent
 * (nothing runs when the helper is present) and only Debian-family hosts are
 * supported; any other distro is refused with a plain message.
 */

import { parseOsReleaseText } from "../host/os-release.ts";

export const SMB_TOOLS_PACKAGE = "cifs-utils";
export const SMB_TOOLS_LOG_LINE = "Installing SMB tools (cifs-utils)";

const MOUNT_CIFS_PATHS = ["/sbin/mount.cifs", "/usr/sbin/mount.cifs"];

export type SmbToolsDecision = "present" | "install" | "unsupported";

/** Pure decision: nothing to do, apt install, or not supported here. */
export function decideSmbTools(
  helperPresent: boolean,
  osRelease: Record<string, string>,
): SmbToolsDecision {
  if (helperPresent) return "present";
  const families = `${osRelease.ID ?? ""} ${osRelease.ID_LIKE ?? ""}`
    .toLowerCase().split(/\s+/);
  return families.includes("debian") || families.includes("ubuntu")
    ? "install"
    : "unsupported";
}

export type SmbToolsDeps = {
  helperPresent?: () => Promise<boolean>;
  readOsRelease?: () => Promise<string>;
  /** Runs the install playbook; rejects when it fails. */
  runSetup?: () => Promise<void>;
  log?: (line: string) => void;
};

async function helperPresentDefault(): Promise<boolean> {
  for (const path of MOUNT_CIFS_PATHS) {
    try {
      if ((await Deno.stat(path)).isFile) return true;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return false;
}

async function readOsReleaseDefault(): Promise<string> {
  try {
    return await Deno.readTextFile("/etc/os-release");
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

/**
 * Make sure `mount.cifs` exists before compose up. Throws a plain error when
 * the host is not supported or the install fails.
 */
export async function ensureSmbTools(deps: SmbToolsDeps = {}): Promise<void> {
  const present = await (deps.helperPresent ?? helperPresentDefault)();
  const osText = present
    ? ""
    : await (deps.readOsRelease ?? readOsReleaseDefault)();
  const decision = decideSmbTools(present, parseOsReleaseText(osText));
  if (decision === "present") return;
  if (decision === "unsupported") {
    throw new Error(
      `Network shares are not supported on this server's operating system: installing ${SMB_TOOLS_PACKAGE} is only automated on Debian and Ubuntu. Install ${SMB_TOOLS_PACKAGE} by hand or remove the network share volumes.`,
    );
  }
  deps.log?.(SMB_TOOLS_LOG_LINE);
  if (deps.runSetup === undefined) {
    throw new Error("no SMB tools installer is configured");
  }
  try {
    await deps.runSetup();
  } catch (err) {
    throw new Error(
      `Installing SMB tools (${SMB_TOOLS_PACKAGE}) failed, so the network share volumes cannot be mounted: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
