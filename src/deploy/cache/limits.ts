/**
 * The wire limits of a project cache. A leaf module (no imports) so the command
 * contracts can use it. `tp-host` holds the same numbers (`TP_CACHE_MEM_MIN_MB`,
 * `TP_CACHE_MEM_MAX_MB`, `TP_LISTEN_PORT_MIN/MAX`); a test keeps them equal.
 * The API allows a smaller range (16-4096 MiB); the wire and the column allow up
 * to 65536.
 */

/** Memory limit of a cache, in MiB. */
export const MIN_CACHE_MEMORY_MB = 16;
export const MAX_CACHE_MEMORY_MB = 65536;

/** The listen band a cache port and a helper port come from. */
export const CACHE_PORT_MIN = 18080;
export const CACHE_PORT_MAX = 18999;

/** Most caches one deploy or one `cache.apply` carries. */
export const MAX_CACHES_PER_COMMAND = 16;
/** Most helper container ports one deploy carries. */
export const MAX_HELPER_REACH_PER_DEPLOY = 32;

/** Engine series offered on the wire, mapped to the pinned patch release. */
export const CACHE_RUNTIMES: Readonly<
  Record<"valkey", Readonly<Record<string, string>>>
> = { valkey: { "8.1": "8.1.11" } };
