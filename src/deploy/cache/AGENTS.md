# Project caches (`src/deploy/cache/`) — AGENTS.md

A project cache is a native Valkey process the host runs as one Hosting Account,
one process per cache row of the control plane. Wire feature `project-cache-v1`
(the last entry of `DAEMON_WIRE_FEATURES`). Root context: `../AGENTS.md`.

| File | What |
| --- | --- |
| `limits.ts` | Leaf constants shared with the command contracts: memory range (16-65536 MiB), the listen band (18080-18999), caps, `CACHE_RUNTIMES` (`{ valkey: { "8.1": "8.1.11" } }`) |
| `runtime.ts` | Paths (binary, unit, data, config, socket, host index, staged config) |
| `unit.ts` | `renderCacheUnit`, `cacheMemoryMaxBytes` (`maxmemory` × 2 MiB + 32 MiB, because the default snapshot forks) |
| `config.ts` | `renderCacheConfig`, the login (`app`, default user off) and its ACL rules |
| `apply.ts` | `applyEnvironmentCaches`, `removeEnvironmentCaches`, the host index |
| `install-runtime.ts` | Runs `cache-runtime-apply.yml` when the pinned binary is missing |
| `deploy-step.ts` | The deploy and destroy entry points (caches and helper ports together) |

## Rules

- **The pins move together.** `CACHE_RUNTIMES`, `valkey_runtime_version` and its
  two digests in `orchestration/roles/valkey-runtime/defaults/main.yml`, and the
  release `tp-host` finds in the unit's `ExecStart=`. A test keeps the first two
  equal.
- **`tp-host` rebuilds both texts.** `tp_cache_unit_text` and `tp_cache_conf_text`
  in `orchestration/scripts/tp-host` are the same text as `unit.ts` and
  `config.ts`; `tp-host` reads the few values that vary and refuses any byte of
  difference. Change a renderer and `tp-host` in one commit;
  `src/permissions/tp-host-cache.test.ts` feeds the renderers through it and
  refuses every one-line change.
- **Engine defaults.** The config has no `save`, `appendonly` or
  `maxmemory-policy` line, and the login cannot `CONFIG`. Durability is the
  app's business.
- **Data folder is `<home>/cache/<id>`**, not `caches`: `cache` is one of the
  names no environment may take (`RESERVED_SCOPE_NAMES`), so it never collides
  with an environment's folder. `<home>/cache` is `root:root 0755`, the id folder
  `<account>:<account> 0700`. Removal of data runs as the account
  (`tp-host cache-remove … --data`).
- **Three states per wire field.** `caches` absent leaves the host alone, empty
  clears it, a list sets it. A cache that left the list loses its unit and
  config and keeps its data (a warning says so); data goes only with
  `deleteData` (`cache.apply`) or when a destroy sent `removeVolumes`.
- **Restart only on change.** The host index
  (`<state>/caches/<environment id>.json`) holds the config's SHA-256; a cache
  restarts when its unit bytes or config hash differ. Old entries without a hash
  count as changed.
- **Ports are guarded first.** A port cache's `Environment=PORT=` is what
  `lib/tp-php-loopback` reads; the walls are rebuilt (`syncAccountWalls`) before
  the process starts. Caches bind `127.0.0.1` only.
- **A cache fails alone.** In a deploy it is a warning and a per-cache result; the
  sites still deploy. Helper ports are different: if the walls cannot be rebuilt
  the deploy fails.
- **Accounts.** A cache whose Linux account is not on the host is `pending`
  (`cache.apply` only; a deploy ensures the accounts first). The slice is written
  only when `accountLimits` is sent, never rewritten to empty limits.
- No secret in the unit text; only the password's SHA-256 is in the `0640` config.
