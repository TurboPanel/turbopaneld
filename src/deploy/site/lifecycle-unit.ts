/**
 * The lines a site's post-deploy command unit and its worker units share.
 *
 * Both run as the site's own account, in the account's slice, with the site's
 * variables (`EnvironmentFile=`), the same sandbox as a scheduled job
 * (`principalHardeningLines`), and the walls a PHP unit has: no private
 * devices, the PHP address filter, and the loopback guard that loads the
 * per-account rules before anything starts (fail closed, so a first deploy and
 * a reboot are covered before the site's PHP unit exists). The deny and allow
 * strings come from the PHP unit's own constants and tp-host pins the same
 * text.
 */

import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { principalUnixGroupName, type RunFn } from "../ensure-principal.ts";
import {
  principalHardeningLines,
  principalReadWritePaths,
  principalSliceName,
  principalUnitEnvironment,
} from "../native/unit.ts";
import {
  SITE_PHP_IP_ALLOW,
  SITE_PHP_IP_DENY,
  sitePhpLoopbackGuard,
} from "./php-runtime.ts";

export type SiteLifecycleUnitBase = {
  layout: Pick<LayoutPaths, "principalHomeRoot" | "libDir">;
  username: string;
  workingDirectory: string;
  /** The site's root copy of its variables (`site-env-file.ts`). */
  environmentFile: string;
  /** The site's PHP series: a bare `php` then runs that series. */
  phpSeries: string;
  /** The site's tenant-writable folders; the account's home and tmp are added. */
  siteWritableDirs: readonly string[];
  /** Extra writable folders (each must be safe to name if absent). */
  extraWritablePaths?: readonly string[];
};

/** `User=` through the loopback guard: who runs it, where, with what variables. */
export function siteLifecycleHeadLines(base: SiteLifecycleUnitBase): string[] {
  return [
    `User=${base.username}`,
    `Group=${principalUnixGroupName(base.username)}`,
    `Slice=${principalSliceName(base.username)}`,
    `WorkingDirectory=${base.workingDirectory}`,
    ...principalUnitEnvironment(base.layout, base.username),
    `Environment=TURBOPANEL_PHP=${base.phpSeries}`,
    `EnvironmentFile=${base.environmentFile}`,
    // Root (`+`), before the process starts: loads the per-account loopback
    // rules. When it fails the unit does not start.
    `ExecStartPre=${sitePhpLoopbackGuard(base.layout.libDir)}`,
  ];
}

/** Journal output, the sandbox, the PHP address filter and the writable folders. */
export function siteLifecycleTailLines(
  base: SiteLifecycleUnitBase,
  syslogIdentifier: string,
): string[] {
  return [
    "StandardOutput=journal",
    "StandardError=journal",
    `SyslogIdentifier=${syslogIdentifier}`,
    ...principalHardeningLines(),
    "PrivateDevices=yes",
    `IPAddressDeny=${SITE_PHP_IP_DENY}`,
    `IPAddressAllow=${SITE_PHP_IP_ALLOW}`,
    principalReadWritePaths(base.layout, base.username, base.siteWritableDirs),
    // A leading `-` makes systemd skip a folder that is not there.
    ...(base.extraWritablePaths ?? []).map((path) => `ReadWritePaths=-${path}`),
  ];
}

/** The journal's `<time> <host> <name>[pid]: ` prefix. */
export const JOURNAL_PREFIX_RE = /^\S+ \S+ ([^\s[]+)\[\d+\]: /;

/**
 * The last `count` journal lines of one unit, as raw text. The journal verb
 * takes exactly this form for a site's command and worker units.
 */
export async function readUnitJournal(
  run: RunFn,
  unit: string,
  count: number,
): Promise<string> {
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "journalctl",
      `--unit=${unit}`,
      "-n",
      String(count),
      "--no-pager",
      "--output=short-iso",
    ]),
  );
  return result.stdout;
}
