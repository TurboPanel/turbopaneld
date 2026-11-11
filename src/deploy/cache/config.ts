/**
 * The `valkey.conf` of one project cache.
 *
 * TurboPanel writes only the lines below; persistence and eviction stay at the
 * engine defaults, so there is no `save`, `appendonly` or `maxmemory-policy`
 * line. The one login is the named user `app` with the default user off; the
 * file holds only the SHA-256 of its password. `tp-host cache-config-install`
 * rebuilds this text from the few values that vary and refuses any difference
 * (`tp_cache_conf_text`); a test keeps the two equal.
 */

import type { LayoutPaths } from "../../paths/layout.ts";
import { cacheDataDir, cacheSocketPath } from "./runtime.ts";

/** The login name every cache has. */
export const CACHE_LOGIN = "app";

/** What the login may not run: it changes the server or its config, loads code, or reaches other hosts. */
export const CACHE_ACL_RULES =
  "~* &* +@all -config -debug -module -shutdown -replicaof -slaveof -sync -psync -failover -migrate -cluster -pfdebug -pfselftest -script|debug -acl +acl|whoami +acl|cat";

export type CacheConfigParams = {
  id: string;
  username: string;
  maxMemoryMb: number;
  /** Loopback port; set only for port access. */
  port?: number;
  /** Lower-case hex SHA-256 of the login password. */
  passwordSha256: string;
};

export function renderCacheConfig(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  params: CacheConfigParams,
): string {
  const lines = [
    "# Managed by TurboPanel; regenerated on every apply.",
    "supervised systemd",
    "daemonize no",
    'logfile ""',
    `dir ${cacheDataDir(layout, params.username, params.id)}`,
  ];
  if (params.port === undefined) {
    lines.push(
      "port 0",
      `unixsocket ${cacheSocketPath(params.id)}`,
      "unixsocketperm 600",
    );
  } else {
    lines.push(`port ${params.port}`, "bind 127.0.0.1");
  }
  lines.push(
    "maxclients 1000",
    `maxmemory ${params.maxMemoryMb}mb`,
    "sanitize-dump-payload yes",
    "enable-debug-command no",
    "enable-module-command no",
    "enable-protected-configs no",
    "user default off",
    `user ${CACHE_LOGIN} on #${params.passwordSha256} ${CACHE_ACL_RULES}`,
    "",
  );
  return lines.join("\n");
}
