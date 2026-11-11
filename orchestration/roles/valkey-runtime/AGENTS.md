# Valkey runtime role (`valkey-runtime`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

Vendors the Valkey server that project caches run (`src/deploy/cache/`), under
`vendor/valkey/<version>/bin/valkey-server`, with the upstream licence
(BSD-3-Clause) at `vendor/valkey/<version>/share/LICENSE` beside it, and a
`current` link. Run lazily by `playbooks/cache-runtime-apply.yml`
(`installCacheRuntime` in `src/deploy/cache/install-runtime.ts`) the first time a deploy or `cache.apply`
needs a cache on a host; never part of a converge. It does not touch the
`redis` role: the control plane's own Redis stays separate and is never shared.

- **Pinned, per architecture.** `valkey_runtime_version` and the SHA-256 of the
  upstream `jammy` tarball for `x86_64` and `arm64`. The `jammy` build needs
  glibc 2.34 or newer, so it runs on Debian 12 and 13 and Ubuntu 22.04 and
  24.04; the `noble` build does not run on Debian 12. A digest that differs
  refuses the install with a message naming the pin. The daemon's
  `CACHE_RUNTIMES` must name the same patch (a test keeps them equal).
- **Only the server and the licence** are taken from the tarball; nothing in it
  is executed. `THIRD_PARTY_NOTICES.md` is unchanged: it is generated from
  lockfiles and lists no vendored binaries.
- **Reachable by every Hosting Account.** `vendor/valkey` is `0750` with an
  `other:x` ACL (the `runtime-access` role), like the tenant Node and Deno trees,
  so a cache unit running as an account can exec the binary without listing what
  else is installed. Each version tree is `root:root 0755`.
- **`vm.overcommit_memory=1`** in `/etc/sysctl.d/99-turbopanel-cache.conf`, so the
  default snapshot fork does not fail under memory pressure. Host-wide, set only
  on a server that runs a cache (owner decision 2026-11-11). `purge.sh` removes
  every `99-turbopanel-*.conf`.
