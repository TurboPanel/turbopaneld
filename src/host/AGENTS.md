# Host facts & command handlers (`src/host`) — AGENTS.md

Daemon repo context: `../../AGENTS.md`. Host OS / time sync / docker /
machine-key / runtime inventory probes attached on hello and refreshed by
change-detected heartbeats.

- **Host OS** — `src/host/os-release.ts` (process-cached; attached once on hello).
- **Time sync** — `src/host/time-sync.ts` (cache-light `timedatectl show`,
  with `timedatectl status` + `/etc/timezone` fallbacks, plus `timesyncd.conf`
  read; carried on hello and change-detected heartbeats with `ips` from
  `src/server-addresses.ts`).
- **Addresses** — `src/server-addresses.ts` (`collectServerIps`): non-virtual
  interface addresses, classified public/private per family. Pass
  `readDefaultRouteInterfaces()` (parsed from `/proc/net/route` and
  `/proc/net/ipv6_route`) and the addresses on the default-route NIC are marked
  `preferred`, so a multi-homed host advertises the address a peer would
  actually reach it on. **These are load-bearing, not decorative:** whenever the
  daemon reaches the control plane through a reverse proxy, a Cloudflare Tunnel,
  or a forwarded port, the peer address the control plane sees is the proxy's,
  and this list is what it shows instead (`../turbopanel/AGENTS.md` → Caddy →
  Server addresses).
- **Docker** — `src/host/docker.ts` (cache-light `docker --version` +
  `docker compose version`; `server.metadata.docker` is omitted when the CLI
  is not installed; carried on hello and change-detected heartbeats).
- **Commands** — `server.hostname.set`, `server.reboot`, `server.timezone.set`,
  `server.ntp.set` (and deploy/lifecycle/stop/ping) via `src/instance/commands/`.
  `environment.lifecycle` is non-destructive `compose start|stop|restart`
  (volumes, deployment dir, and hosting Caddy sites untouched). Timezone
  / NTP apply through Ansible role `time-sync` + playbook `time-sync-apply.yml`
  (`runTimeSyncApply`); contracts in `contracts.ts` must match the instance
  canonical `server.timezone.set` / `server.ntp.set` shapes. **`server.fabric.reconcile`**
  (TurboFabric) is the org WireGuard mesh on interface `tp0`. Six-state path
  contract (`direct_lan` / `direct_public` / `direct_nat` / `gateway` /
  `relay` / `unreachable`) is documented at
  https://turbopanel.io/docs/architecture/turbofabric-path-model — no daemon
  behavior change in this slice. `{ enabled: false }`
  tears down `tp0`, routed bridges, `TP-FORWARD`, keys, and local state — not a
  no-op. The daemon owns apply (no Ansible round-trip): it persists the private
  key at `<daemonStateDir>/network/wireguard/private.key` (mode `0600`, via
  `fabricNetworkDir`), writes mode-0600 `tp0.conf` (PSK plaintext inlined, temp
  `psk/` files deleted after apply), `wg syncconf`, enables `wg-quick@tp0` for
  reboot durability, writes `/etc/sysctl.d/99-turbopanel-fabric.conf`, creates
  listed Docker routed-bridge networks, and hangs a `TP-FORWARD` chain off
  `DOCKER-USER`. Reconcile is authoritative over `state.json.networks`: bridges
  present in the previous state but absent from the incoming payload are
  removed (best-effort; missing / active-endpoint errors are logged). Durable
  `tp0.conf` stays in `wg-quick` format (`Address`);
  `wg syncconf` is fed a stripped `wg setconf` config. Daemon start restores
  from `state.json` and re-installs `TP-FORWARD`, **reusing PSK plaintext from
  durable `tp0.conf`** (do not rewrite peers with an empty PSK map).   `TP-FORWARD`
  ACCEPTs same-subnet bridge traffic and bidirectional forwarding between local
  `networks[].subnet` and remote peer prefixes (non-`/32` allowed IPs).   Gateway
  `advertisedCidrs` now defaults to the datacenter's IPv4 subnets; a
  **non-empty** stored `advertisedCidrs` is an operator override used
  verbatim. IPv6 is excluded because `TP-FORWARD` is installed with
  `iptables` only in `src/instance/commands/fabric.ts` (routed bridges use
  `com.docker.network.bridge.gateway_mode_ipv4=routed`; no `ip6tables` path)
  — operators may still add IPv6 ranges explicitly. The
  Docker monitor also reinstalls that jump when dockerd becomes reachable again
  after a restart (dockerd can rebuild `DOCKER-USER`). `wireguard-tools` stays in
  `daemon-prereqs`. Default fabric MTU is **1420** on `tp0` and every routed
  bridge (payload-overridable). **Preflight** verifies `wg` / `ip` / `iptables`
  / `docker` (presence *and* invocability, direct or `sudo -n`) before mutating
  anything and fails with an actionable message rather than `wg genkey failed`.
  **`environment.deploy`** may carry
  `sites[]` for host-native nginx/Apache/OpenLiteSpeed sites
  (compose `serviceKind: site`); engines are vendored under
  `/opt/turbopanel/vendor/{nginx,apache,openlitespeed}`. nginx/Apache PHP is the
  one exception to vendoring: php-fpm comes from the sury Debian repo, run under
  `turbopanel-php-fpm.service` against TurboPanel's own config — see
  `src/deploy/AGENTS.md` and `orchestration/AGENTS.md`.
  **Runtime inventory** rides the presence snapshot (`src/host/runtimes.ts` →
  `idle-presence.ts`), not a command: `COMMAND_TYPES` is a downward rail with no
  request/response shape, while presence is already change-detected and sent on
  hello and on change. It reports installed PHP series (from
  `/usr/sbin/php-fpm<series>`, the binary a master actually needs), their
  extensions (from `mods-available`, a readdir rather than a fork per series),
  and vendored tenant Node / lsphp series — each area omitted entirely when
  empty, the same discipline `docker` follows. A vendored series is only
  reported once its `current` symlink resolves, so a half-vendored tree is never
  advertised as runnable. The control plane stores it in `server.metadata.runtimes`
  and gates on it at prepare: an unsupported series is a hard error before
  queueing, a supported-but-absent one is a warning because the deploy installs
  it, and **no report at all means unknown, never absent**.
  The deploy payload may also carry **`fabricNetworks[]`** (`{ name, subnet,
  gateway?, mtu? }`) which the daemon ensures as routed bridges **before**
  `compose up`; `environment.stop` carries `fabricNetworks: string[]` (names)
  and removes those bridges + prunes them from `state.json`.
  Secret values never land in durable `compose.yaml`: the daemon writes
  Compose standalone secret files under `/run/turbopanel/deployments/…/secrets/`
  and a non-secret `.env` next to `compose.yaml`. After JWT, it rehydrates
  those `/run` files (`POST /api/daemon/v1/deployments/secrets/rehydrate` then
  `/secrets/decrypt`) and `compose up -d`.   `environment.deploy` `storageMaterial[]`
  is copy-aware (`locationId` is the frozen wire field for a storage copy): host paths are
  `<stateDir>/storage/<orgId>/<storageId>/<locationId>/data`. Overlay mounts come
  from each entry's `mounts[]`. TurboFabric `server.fabric.reconcile`
  `networks[]` entries carry optional `mtu` / `gateway`; the enabled payload
  carries top-level `mtu` plus per-peer `presharedKeyEnvelope` / `keepalive`;
  the **result** carries observed `peers[]` (`publicKey`, optional kernel
  `endpoint`, handshake-derived `health` `healthy`/`stale`/`never`,
  `lastHandshakeAt`, `transferRx/Tx`) so the UI can show a half-converged mesh.
  Path probes are kernel-only (`wg set … endpoint` + `wg show dump`); the daemon
  never opens a userspace STUN socket. A probe succeeds only on a handshake
  newer than both the pre-probe value and the probe start; failed probes restore
  the durable endpoint and keepalive from `state.json` then `tp0.conf` (clearing
  keepalive when the durable peer has none). `wg set` failures exclude that
  candidate from the returned observations. The Postgres table
  is `subnet` (renamed from `bridge`) — the **compose-bridge** subnet
  (`tpn_*` routed bridge per host), not a datacenter routing-domain subnet.

