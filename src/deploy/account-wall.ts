/**
 * Reload the Hosting Account wall (`tp-host php-loopback-sync`, which runs
 * `lib/tp-php-loopback`) from the daemon.
 *
 * The wall refuses site accounts the host's loopback and every container
 * network. A container network that appears later is already refused on the
 * way out through its bridge, but its gateway is a host address that only the
 * sync learns, so a deploy that creates a network (compose `up`) must reload
 * the wall before it reports success, and the daemon reloads it at its start
 * and whenever Docker comes back. The sync is cheap and idempotent: one
 * atomic nft transaction rebuilt from what is on the host now.
 */
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import type { RunFn } from "./ensure-principal.ts";

/** Reload the wall; throws with the helper's own message when it fails. */
export async function syncAccountWallOrThrow(run: RunFn): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs(["-n", "php-loopback-sync"]),
  );
  if (!result.success) {
    throw new Error(
      `account wall could not be reloaded: ${
        result.stderr || "tp-host php-loopback-sync failed"
      }`,
    );
  }
}

/**
 * Reload the wall without ever throwing (daemon start, Docker returning): a
 * failure is passed to `warn` and the rules stay as they were.
 */
export async function syncAccountWallQuietly(
  run: RunFn,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await syncAccountWallOrThrow(run);
  } catch (err) {
    warn(err instanceof Error ? err.message : "account wall reload failed");
  }
}
