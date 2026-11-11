/**
 * The memory limit a cache may carry on the wire, in MiB. `tp-host` holds the
 * same two numbers (`TP_CACHE_MEM_MIN_MB`, `TP_CACHE_MEM_MAX_MB`); a test keeps
 * them equal. The API allows less (16-4096); the column and the wire allow up
 * to 65536.
 */
export const MIN_CACHE_MEMORY_MB = 16;
export const MAX_CACHE_MEMORY_MB = 65536;
