/**
 * Read-only probes of a managed engine's data volume, run in a throwaway
 * container of the engine image. Shared by `bootstrapStandby` (before
 * `compose up`) and the lifecycle start guard (before `compose start`).
 */

import { helperLabelArgs } from "../../deploy/labels.ts";
import { sanitizeForLog } from "../../util/logger.ts";
import type {
  ManagedEngineContext,
  ManagedEngineProbeContext,
} from "./types.ts";

/** `-v name:target` pairs for every managed volume. */
export function volumeMountArgs(
  volumes: ManagedEngineProbeContext["volumes"],
): string[] {
  const args: string[] = [];
  for (const volume of volumes) {
    args.push("-v", `${volume.name}:${volume.target}`);
  }
  return args;
}

/**
 * `test <flag> <path>` inside the data volume. `test` exit codes alone
 * cannot distinguish "path absent" from "docker never ran" (e.g. socket
 * permission error) — echo an explicit marker and require the probe container
 * itself to succeed, so a docker failure aborts instead of being misread as an
 * uninitialized volume.
 */
export async function probeVolumePath(
  ctx: ManagedEngineProbeContext,
  flag: "-f" | "-d",
  path: string,
): Promise<boolean> {
  const probe = await ctx.runDocker([
    "run",
    "--rm",
    ...helperLabelArgs("volume-copy"),
    "--user",
    ctx.containerUser,
    ...volumeMountArgs(ctx.volumes),
    ctx.image,
    "sh",
    "-c",
    `test ${flag} ${path} && echo present || echo absent`,
  ]);
  if (!probe.success) {
    throw new Error(
      `standby data probe failed: ${
        sanitizeForLog(probe.stderr || probe.stdout || "unknown")
      }`,
    );
  }
  return probe.stdout.trim().endsWith("present");
}

/**
 * Classify a data volume: `uninitialized` (nothing written yet), `standby`
 * (data plus the engine's standby marker), or `not_standby` (data without
 * the marker — e.g. a demoted primary that must never start writable).
 */
export async function probeStandbyState(
  ctx: ManagedEngineProbeContext,
  paths: { data: { flag: "-f" | "-d"; path: string }; marker: string },
): Promise<"uninitialized" | "standby" | "not_standby"> {
  if (!(await probeVolumePath(ctx, paths.data.flag, paths.data.path))) {
    return "uninitialized";
  }
  return (await probeVolumePath(ctx, "-f", paths.marker))
    ? "standby"
    : "not_standby";
}

/** MySQL / MariaDB datadir — the first managed volume's mount target. */
export function mysqlFamilyDataRoot(
  volumes: ManagedEngineProbeContext["volumes"],
): string {
  return volumes[0]?.target ?? "/var/lib/mysql";
}

/**
 * MySQL / MariaDB: initialised when the datadir has been written (`mysql`
 * system schema); a standby carries the daemon's marker file.
 */
export function probeMysqlFamilyStandbyData(
  ctx: ManagedEngineProbeContext,
  marker: string,
): Promise<"uninitialized" | "standby" | "not_standby"> {
  const dataRoot = mysqlFamilyDataRoot(ctx.volumes);
  return probeStandbyState(ctx, {
    data: { flag: "-d", path: `${dataRoot}/mysql` },
    marker: `${dataRoot}/${marker}`,
  });
}

const SEED_ROOT_DEFAULTS_MARK = "__TP_ROOT_DEFAULTS__";

/**
 * Script lines that read the seed's stdin. Plain: one defaults file for the
 * primary. With `withRootPassword`: that file, the marker line, then a second
 * defaults file for the local root client (`$rootopt`).
 */
export function standbySeedStdinLines(withRootPassword: boolean): string[] {
  if (!withRootPassword) return ['cat > "$tmp"', "rootopt="];
  return [
    "rootcnf=$(mktemp)",
    'trap \'rm -f "$tmp" "$rootcnf"\' EXIT INT TERM HUP',
    'chmod 600 "$rootcnf"',
    `while IFS= read -r line; do [ "$line" = "${SEED_ROOT_DEFAULTS_MARK}" ] && break; ` +
    String.raw`printf '%s\n' "$line" >> "$tmp"; done`,
    'cat > "$rootcnf"',
    'rootopt="--defaults-extra-file=$rootcnf"',
  ];
}

/**
 * Run a standby seed. Volumes whose initdb never installed socket auth reject
 * a bare local root with 1045 "using password: NO" before anything is
 * imported; retry once with the platform root password in a 0600 file.
 */
export async function execStandbySeed(
  ctx: ManagedEngineContext,
  buildScript: (withRootPassword: boolean) => string,
  defaultsBody: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const first = await ctx.exec(["sh", "-c", buildScript(false)], defaultsBody);
  const text = `${first.stderr}\n${first.stdout}`;
  const denied = text.includes("Access denied") &&
    text.includes("using password: NO");
  if (first.success || !denied || !ctx.socketPassword) return first;
  return await ctx.exec(
    ["sh", "-c", buildScript(true)],
    `${defaultsBody}${SEED_ROOT_DEFAULTS_MARK}\n` +
      `[client]\nuser=${ctx.rootUsername}\npassword=${ctx.socketPassword}\n`,
  );
}
