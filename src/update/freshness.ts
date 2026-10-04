/**
 * Manifest freshness: a validly signed manifest is not necessarily a *newer*
 * one. A signature proves who made a manifest, not when, so anyone able to
 * choose which manifest URL a daemon reads (a stale release asset, a CDN or
 * DNS tamper, a control plane that names an exact old build) could roll a
 * host back to an old build with a known hole. The daemon therefore compares
 * the manifest against the build it is running and refuses to move backwards.
 *
 * There is deliberately no expiry (`notAfter`) and no sequence field: a host
 * that sat offline for a month must still be able to update, and every
 * manifest already published would lack a new field. The build identity the
 * signed manifest already carries (`version`, `builtAt`) is the monotonic
 * counter. The rules mirror the control plane's `isDowngrade`
 * (turbopanel `src/features/upgrades/target.ts`) so both sides agree:
 *
 * - Same commit: not a downgrade (the host already runs that build).
 * - Base versions (`major.minor.patch`, pre-release label ignored) order
 *   builds across releases. A binary reports its plain base version whichever
 *   channel published it, while an rc / canary manifest carries a label, so
 *   plain semver would rank every canary of the installed base as older.
 * - Same base: build times decide (canary builds compare by `builtAt`).
 * - Anything unparsable or missing (a dev checkout's `unstamped` build, the
 *   trunk drop's absent `version`) is not a downgrade: no evidence, no refusal.
 *
 * Break-glass is host-side only: `TURBOPANEL_ALLOW_DOWNGRADE=1` in the
 * daemon's environment, or the operator re-running `run.sh --manifest-url`
 * by hand. Nothing a manifest or a WebSocket message carries can switch it on.
 */
import { compareSemver, parseSemver } from "../instance/version-wire.ts";
import { RollbackRefusedError } from "./errors.ts";

/** Env var an operator sets on the host to accept an older signed build. */
export const ALLOW_DOWNGRADE_ENV = "TURBOPANEL_ALLOW_DOWNGRADE";

/** What the running daemon knows about its own build. */
export interface InstalledBuild {
  commit: string;
  version?: string;
  builtAt?: string;
}

/** The identity fields of a verified manifest. */
export interface TargetBuild {
  commit: string;
  version?: string;
  builtAt: string;
}

function baseOnly(version: string | undefined) {
  const parsed = parseSemver(version);
  return parsed ? { ...parsed, prerelease: [] } : null;
}

function builtAtOlder(
  installedBuiltAt: string | undefined,
  targetBuiltAt: string,
): boolean {
  const installedAt = Date.parse(installedBuiltAt ?? "");
  const targetAt = Date.parse(targetBuiltAt);
  if (!Number.isFinite(installedAt) || !Number.isFinite(targetAt)) {
    return false;
  }
  return targetAt < installedAt;
}

/** True when installing `target` would move this host to an older build. */
export function isRollback(
  installed: InstalledBuild,
  target: TargetBuild,
): boolean {
  if (installed.commit === target.commit) return false;
  const have = baseOnly(installed.version);
  const want = baseOnly(target.version);
  if (have && want) {
    const base = compareSemver(want, have);
    if (base !== 0) return base < 0;
  }
  return builtAtOlder(installed.builtAt, target.builtAt);
}

/**
 * Throw {@link RollbackRefusedError} when `target` is older than the running
 * build, unless the operator broke glass in the host environment.
 */
export function assertNotRollback(
  installed: InstalledBuild,
  target: TargetBuild,
  env: Record<string, string | undefined>,
): void {
  if (env[ALLOW_DOWNGRADE_ENV]?.trim() === "1") return;
  if (!isRollback(installed, target)) return;
  const have = installed.version ?? installed.commit;
  const want = target.version ?? target.commit;
  throw new RollbackRefusedError(
    `signed manifest is older than the installed build (${want} built ${target.builtAt}` +
      ` vs ${have} built ${
        installed.builtAt ?? "unknown"
      }); refusing to roll back` +
      ` (set ${ALLOW_DOWNGRADE_ENV}=1 on the host to override)`,
  );
}
