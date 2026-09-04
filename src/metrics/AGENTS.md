# Host metrics (daemon collector) — AGENTS.md

Fire-and-forget host-metrics collection (async `/proc` + `statfs` reads, **no** per-interval subprocesses) and scheduling, sent via `POST /api/daemon/v1/metrics`. `HOST_METRIC_KEYS` is the schema v3 named logical contract, partitioned into `core`/`extended`/`sensors`/`traffic` `MetricPart`s (a sample's `parts` list declares which groups it carries this tick — `core`/`extended` are mandatory, `sensors`/`traffic` are conditional), mirrored (not build-coupled) with the instance — it carries no storage ordering.

Root context: `../../AGENTS.md`. Instance-side storage/query/caching: `../../../turbopanel/src/daemon/metrics/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Host metrics

Samples are sent via authenticated `POST /api/daemon/v1/metrics`
(`DaemonApiClient.sendHostMetrics`, `src/instance/api-client.ts`,
fire-and-forget). Protocol v1 request body:

```json
{ "type": "metrics", "version": 3, "at", "intervalSeconds", "sequence", "parts", "metrics", "dimensions" }
```

Contract mirrored (not build-coupled) in `src/metrics/contract.ts` ↔
`../turbopanel/src/daemon/metrics/contract.ts` (`METRICS_SCHEMA_VERSION = 3`). The
`HOST_METRIC_KEYS` list (`cpuUserPercent` … `proxysqlBackendsUp`) is a
**named logical allowlist** for the wire/API surface — physical storage
positions are backend-private on the instance side and never depend on this
list's order.

**Scheduling** (`src/metrics/scheduler.ts`): `MetricsScheduler` takes an
injected `MetricsSink` (`attach(send)`) rather than the raw `WebSocket` — the WS
keeps only commands/outbox + the cell ping. On attach (first registration and
every reconnect, including the co-located self-hosted daemon) the first sample
POSTs immediately so gauges (load / memory / disk / uptime) populate without
waiting. A primed second sample **2 s** later (`METRICS_PRIME_MS`) plus
deterministic per-`serverId` phase jitter ≤**5 s** (`METRICS_JITTER_MAX_MS`,
FNV‑1a) fills CPU / disk / net rates (two-snapshot deltas). Steady cadence is
then one sample ~every **60 s** (`METRICS_INTERVAL_MS`); jitter does not change
query resolution. Monotonic process-local `sequence` resets on daemon restart
(not persisted). Fire-and-forget, disposable — no acks, retries, or outbox.
Never blocks startup, connect, liveness, command dispatch, shutdown, or
reconnect. Factory/collect/send failures are rate-limited
(`METRICS_LOG_RATE_LIMIT_MS` = 5 min) and must not tear down the socket.
Overlapping ticks are dropped; the steady interval arms when the primed tick
fires (not after first-collect completion). Attach-scoped generation ignores
stale in-flight emits across detach/reconnect. Scheduler rebinding tracks
`#metricsSchedulerServerId` separately from `#tokenServerId` so jitter stays
tied to the authenticated server after identity recovery.

**Collector** (`src/metrics/collector/`): async reads only — **no subprocesses
per interval** (no `top`/`vmstat`/`iostat`/`free`/`df`/`ps`/`sar`; the Docker
data-root query goes over the Engine API Unix socket, is cached after success,
and bounds failure re-probes to `DOCKER_DATA_ROOT_RETRY_MS`). Per-domain
modules (`cpu.ts`, `memory.ts`, `filesystem.ts`, `block-devices.ts`,
`mounts.ts`, `network.ts`, `processes.ts`, `sensors/`) own raw parsing +
per-sample assembly;
`linux-collector.ts` orchestrates the raw snapshot, two-snapshot deltas, and
the field fill. Sources: `/proc/stat` (all 8 CPU percentages — no stored
`cpuUsagePercent`; the API derives `100 - cpuIdlePercent`), `/proc/loadavg`,
`/proc/meminfo` (raw bytes only, swap-absent hosts report `null` never `0`),
`/proc/uptime`, `/proc/diskstats` (throughput, IOPS, and `Δticks/Δops` read/
write latency), `/proc/net/dev`, `/proc/sys/kernel/osrelease`, process count
via `/proc` (`Deno.readDir`, with `ls -1` fallback — Deno 2 blocks direct
`/proc` **and `/sys`** directory listing under `--allow-read` the same way it
blocks `readTextFile`; `proc-read.ts` already `cat`s individual `/proc`/sysfs
files, and sensor discovery's `defaultSensorIo.listDir` uses the same `ls -1`
fallback so a compiled daemon can still see `coretemp` / RAPL / thermal
zones). **Three storage probes** via `node:fs/promises` `statfs` (no
`df`): system `/`, the hosting path (admin override from
`<daemonStateDir>/metrics/hardware-profile.json`, else `principalHomeRoot` —
`collector/hosting.ts`), and the Docker data root (Docker Engine API
`GET /info` `DockerRootDir` via `src/docker/client.ts`, `null` when Docker
is absent) — raw bytes normalized first (`totalBytes = blocks * bsize`,
`availableBytes = bavail * bsize`), no percent reduction. The hosting path
walks up to the nearest existing ancestor directory (bounded at `/`) before
being probed — `principalHomeRoot` is only created on first tenant
principal, and an admin override can name a not-yet-provisioned filesystem,
so `resolveHostingPath` never hands `statfs` a path guaranteed to fail.
**Network
classification** (`network.ts`): every interface is parsed, then classified
`loopback` / `container-bridge` (`veth*`/`docker*`/`br-*`/`virbr*`/`vnet*`/
`tap*`/`tun*`) / `fabric` (TurboFabric names, seeded `tp0`) / `uplink`;
uplink and fabric byte rates aggregate independently and are never combined,
and `veth` churn nulls only the container-bridge class. Alongside that
classification-keyed aggregation, two independent **name-keyed** rate series
(`nic1*`/`nic2*ReceiveBytesPerSecond`/`TransmitBytesPerSecond`,
`namedInterfaceRates` in `network.ts`) report the operator-assigned
`HardwareProfile.nic1`/`.nic2` interfaces (same hardware-profile round trip
as the sensor slots, `CollectorDeps.resolveNicSlots` →
`sensors/overrides.ts`) — an interface can be both part of the `uplink`
aggregate and individually reported as `nic1`; an unassigned or vanished
slot nulls only that slot, never the class aggregates, and never forces the
`"sensors"` part on by itself. **Sensor subsystem**
(`sensors/`): hwmon/thermal-zone temperatures, RAPL energy-delta CPU power,
hwmon `power1_average` GPU power, NVMe/`drivetemp` disk temperatures,
hwmon `fanN_input` tachometers (CPU/system/GPU-attributed by chip), and the
vendor GPU busy-percent gauge (NVIDIA GPU power and utilization stay
`null` — `nvidia-smi` would be a per-interval subprocess); admin overrides
resolved from the operator-pushed `HardwareProfile`
(`sensors/overrides.ts`, `<daemonStateDir>/metrics/hardware-profile.json`)
beat auto-detection. Resolved sensor identities (`chip:label`) are
daemon-internal only — persisted via the hardware-profile round trip to
Postgres, never re-added to the wire sample's `dimensions`; only
`dimensions.hardwareProfileGeneration` (the applied profile's generation
number) rides the sample. A sample declares the `"sensors"` `MetricPart`
only when at least one sensors-part field actually resolved (a VM with no
hwmon omits it entirely). CPU % and per-second rates use two-snapshot
deltas; first-sample rate metrics are **`null`** (never coerced to `0`),
and a boot-id change nulls rates, CPU, and power deltas — fan RPM and GPU
utilization are point-in-time gauges, not deltas, so the boot-id reset
never touches them. GPU selection is device-first (`selectGpuDevice`):
candidates group per hwmon device and one GPU feeds temperature, power,
utilization, and fan — a multi-GPU host never mixes two cards in one
sample. The `drivetemp` kernel module is opt-in
(`sensors/drivetemp.ts`, `HardwareProfile.drivetempEnabled`): a push over
`metrics-sensor-overrides-update` that flips it false/unset → true fires a
fire-and-forget `modprobe drivetemp` plus a `modules-load.d` drop-in for
reboot durability; later pushes with the flag already `true` are a no-op.
**Disk filter** (`block-devices.ts` + `mounts.ts`):
exclude device prefixes `loop`, `ram`, `zram`, `fd`, `dm-`, `md`, `dcssblk`,
`sr`, `nbd`; drop partition rows (`^p?\d+$` suffix) when the parent
whole-disk row survives; sectors = 512 B. When `/proc/mounts` resolves the
probed system/hosting/Docker paths to `/dev/<name>` sources, aggregation
narrows to those backing whole disks (unrelated extra disks neither pollute
totals nor null the interval on churn); the host-wide whole-disk filter is
the fallback when mount resolution is unavailable. Per-filesystem and
per-interface series are deferred to future event types. **Capabilities**
(`src/metrics/capabilities.ts`): `collectMetricsCapabilities` enumerates
sensor candidates, storage mounts (current system/hosting/docker selections
plus block-backed mount-table `candidates` for administrator hosting-path
selection — a `null` hosting/docker probe carries a `storageMounts.reasons`
entry (`"path_not_found"` / `"docker_absent"` / `"statfs_unsupported"`),
the same `reasons` pattern `sensors/discovery.ts` uses for an empty
`diskTemperature` category), and classified interfaces for the
`metrics-capabilities-request`/`-result` correlated round trip in
`src/instance/client.ts` (instance-side cell kind + client route arrive with
the live-metrics-leases phase). **Unsupported OS:**
`UnsupportedMetricsCollector` returns
`{ supported: false, reason: "unsupported_os:<os>" }` and keeps the daemon
running. **Traffic** (`collector/proxy/`): two independent loopback
Prometheus scrapes, `caddy.ts` (site Caddy — `orchestration/roles/site-caddy`,
**not** the hosting Caddy in `src/deploy/ingress.ts` — reachable at
`site_caddy_admin_addr`, `127.0.0.1:2039`; that role's `Caddyfile.j2` sets the
global `metrics` option, which exposes the result at `/metrics` on its own
admin listener (`servers { metrics }` alone only turns on per-server
instrumentation and leaves `/metrics` 404) — there is no supported way to
bind a second, metrics-only admin API) and `proxysql.ts` (managed ProxySQL —
`src/managed/proxysql.ts` — `admin-restapi_enabled`/`admin-restapi_port`
start an unauthenticated `GET /metrics` REST server, published to
`127.0.0.1:6070` only, same as the admin MySQL-protocol port). Each source
resolves independently to `null` on any network/parse failure — one absent
sidecar never blocks the other. Counter fields (request/query counts, byte
totals, duration sums, response-class breakdowns) go through `counterDelta`
(`rates.ts`) for a raw per-interval delta — first-sample and
counter-decrease (sidecar restart) both null the field for that interval,
same contract as `rate()` but without dividing by seconds, since traffic
fields are per-interval totals, not per-second rates; connection-count and
backends-up fields are point-in-time gauges, read through unchanged. A
boot-id change nulls every counter delta (the sidecar restarted with the
host) but leaves the gauges alone. `createProxyCountersReader` wraps each
source in `endpoint-cache.ts`'s retry-bounded probe (`PROXY_ENDPOINT_RETRY_MS`
= 5 min, mirroring `DOCKER_DATA_ROOT_RETRY_MS`) so a stopped sidecar is not
re-dialed every tick forever; unlike the Docker data-root cache, a
*successful* scrape is never remembered — traffic counters must be re-read
every interval. A sample declares the `"traffic"` `MetricPart` only when at
least one of the 17 traffic-part fields actually resolved (mirrors the
`"sensors"` part's own VM-omission rule).

**Env:** `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS` default `90` (instance
raw-metrics retention). Server metrics are always on — there is no instance-side
enable/disable gate; the daemon always collects and emits host metrics
fire-and-forget, and the instance always persists when a backend is configured.
See **`../turbopanel/AGENTS.md`** (Server metrics).

**Local validation:** fixture-driven tests under `src/metrics/` (no live `/proc`
required):

```bash
deno test src/metrics/
deno fmt && deno lint && deno check
deno task check:layout
```

Fixtures: `src/metrics/collector/testdata/` — `/proc` text snapshots
(`proc-stat-full-fields-*` for all-8-counter CPU deltas,
`proc-diskstats-nvme`/`-lvm`/`-extra-disks` for NVMe naming, device-mapper
exclusion, and mount-backed disk preference, `proc-mounts` for mount-table
candidates and device resolution, `proc-net-dev-with-fabric-tunnel` for
uplink + `tp0` + `docker0`/`veth` classification), `docker-info-*.txt`
data-root parses, and sysfs sensor trees: `sensors-intel/` = coretemp +
RAPL, `sensors-amd/` = k10temp + amdgpu, `sensors-multi-gpu/` = two amdgpu
cards for device-consistent GPU selection, `sensors-none/` = the
sensorless-VM case (no `class/hwmon` at all), `sensors-nvme-disk/` = an
NVMe hwmon chip correlated to its `nvme0n1` block device, `sensors-drivetemp/`
= a `drivetemp` SATA/SAS chip correlated to its `sda` block device,
`sensors-fans-ambient/` = CPU/system fan tachometers plus unclaimed temps
swept into the ambient pool (with a `sd*` block device and no `drivetemp`
chip, for the `drivetemp_not_loaded` capability reason), and
`sensors-gpu-utilization/` = an amdgpu device exposing `gpu_busy_percent`,
`sensors-gpu-utilization-intel/` = an i915 device exposing its busy-percent
gauge under an alternate node name, and `proxy-caddy-metrics.txt` /
`proxy-proxysql-metrics.txt` (plus `-partial` variants for a freshly-started
sidecar with no traffic yet) — captured Prometheus exposition text for the
`collector/proxy/` parser tests.

