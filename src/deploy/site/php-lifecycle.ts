/**
 * A site's native PHP follows an environment's lifecycle action, the way its
 * workers and native app units do, so a host without Docker can start, stop
 * and restart a PHP site.
 *
 * Two shapes exist (`php-patch-restart.ts` keeps a record of each):
 * - a per-site runtime, `turbopanel-php-<id>` (a socket unit in front of the
 *   service for FastCGI and lsphp, the service alone for php-fpm): started,
 *   stopped or restarted with the environment;
 * - a pool in the shared `turbopanel-php-fpm@<series>` master, which other
 *   environments use too: a restart reloads it (new workers pick up the
 *   site's files and pool), a start makes sure it runs, a stop leaves it alone.
 */

import { logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import { systemctl } from "../systemd-unit-set.ts";
import { phpFpmDriver } from "./engine-driver.ts";
import {
  readPhpRuntimeRecords,
  readPhpSharedSiteRecords,
} from "./php-patch-restart.ts";
import {
  sitePhpServiceName,
  sitePhpSocketActivated,
  sitePhpSocketName,
} from "./php-runtime.ts";
import type { SitePhpRuntimeMode } from "./php-runtime.ts";

export type PhpLifecycleAction = "start" | "stop" | "restart";

/** The units to act on for one per-site runtime, in the order to act. */
function runtimeUnitCalls(
  id: string,
  mode: string,
  action: PhpLifecycleAction,
): string[][] {
  const service = sitePhpServiceName(id);
  if (!sitePhpSocketActivated(mode as SitePhpRuntimeMode)) {
    return [[action, service]];
  }
  const socket = sitePhpSocketName(id);
  // The socket is what the web server connects to: it comes up first and goes
  // down last, and a restart only restarts the service behind it.
  if (action === "stop") return [["stop", service], ["stop", socket]];
  if (action === "start") return [["start", socket], ["start", service]];
  return [["start", socket], ["restart", service]];
}

/**
 * Apply `action` to the environment's native PHP. Every unit is tried; one
 * that fails is collected and thrown together at the end, so a restart never
 * reports success while a PHP runtime stayed on its old build.
 * Returns the units asked.
 */
export async function phpLifecycle(
  io: { run: RunFn; layout: LayoutPaths },
  environmentId: string,
  action: PhpLifecycleAction,
): Promise<string[]> {
  const asked: string[] = [];
  const failures: string[] = [];
  const call = async (args: string[], unit: string): Promise<void> => {
    const result = await systemctl(io.run, args);
    if (result.success) {
      asked.push(unit);
      return;
    }
    failures.push(`${args.join(" ")}: ${result.stderr || "failed"}`);
  };

  const runtimes = (await readPhpRuntimeRecords(io.layout)).filter((record) =>
    record.environmentId === environmentId
  );
  await forEachSequential(runtimes, async (record) => {
    await forEachSequential(
      runtimeUnitCalls(record.id, record.mode, action),
      (args) => call(args, args[1] ?? record.id),
    );
  });

  if (action !== "stop") {
    const series = new Set(
      (await readPhpSharedSiteRecords(io.layout))
        .filter((record) => record.environmentId === environmentId)
        .map((record) => record.series),
    );
    await forEachSequential([...series].toSorted(), async (value) => {
      const driver = phpFpmDriver(value);
      if (action === "start") {
        await call(["start", `${driver.unit}.service`], driver.unit);
        return;
      }
      try {
        await driver.reload(io.run, io.layout);
        asked.push(driver.unit);
      } catch (err) {
        failures.push(
          `reload ${driver.unit}: ${
            err instanceof Error ? err.message : Deno.inspect(err)
          }`,
        );
      }
    });
  }

  if (failures.length > 0) {
    logWarn(
      "deploy",
      `PHP ${action} failed env=${environmentId}: ${failures.join("; ")}`,
    );
    throw new Error(`PHP ${action} failed: ${failures.join("; ")}`);
  }
  return asked;
}
