# Host metrics (daemon collector) — AGENTS.md

Fire-and-forget host-metrics collection (async `/proc` + `statfs` reads, **no** per-interval subprocesses) and scheduling, sent via `POST /api/daemon/v1/metrics`. `HOST_METRIC_KEYS` is the v2 named logical contract (schema version 2, 38 keys) mirrored (not build-coupled) with the instance — it carries no storage ordering.

Root context: `../../AGENTS.md`. Instance-side storage/query/caching: `../../../turbopanel/src/daemon/metrics/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Host metrics

Samples are sent via authenticated `POST /api/daemon/v1/metrics`
(`DaemonApiClient.sendHostMetrics`, `src/instance/api-client.ts`,
fire-and-forget). Protocol v1 request body:

```json
{ "type": "metrics", "version": 2, "at", "intervalSeconds", "sequence", "metrics", "dimensions" }
```

Contract mirrored (not build-coupled) in `src/metrics/contract.ts` ↔
`../turbopanel/src/daemon/metrics/contract.ts` (`METRICS_SCHEMA_VERSION = 2`). The
38-key list (`HOST_METRIC_KEYS`: `cpuUserPercent` … `uptimeSeconds`) is a
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
the v2 field fill. Sources: `/proc/stat` (all 8 CPU percentages — no stored
`cpuUsagePercent`; the API derives `100 - cpuIdlePercent`), `/proc/loadavg`,
`/proc/meminfo` (raw bytes only, swap-absent hosts report `null` never `0`),
`/proc/uptime`, `/proc/diskstats` (throughput, IOPS, and `Δticks/Δops` read/
write latency), `/proc/net/dev`, `/proc/sys/kernel/osrelease`, process count
via `/proc`. **Three storage probes** via `node:fs/promises` `statfs` (no
`df`): system `/`, the hosting path (admin override from
`<daemonStateDir>/metrics/hosting-path.json`, else `principalHomeRoot` —
`collector/hosting.ts`), and the Docker data root (Docker Engine API
`GET /info` `DockerRootDir` via `src/docker/client.ts`, `null` when Docker
is absent) — raw bytes normalized first (`totalBytes = blocks * bsize`,
`availableBytes = bavail * bsize`), no percent reduction. **Network
classification** (`network.ts`): every interface is parsed, then classified
`loopback` / `container-bridge` (`veth*`/`docker*`/`br-*`/`virbr*`/`vnet*`/
`tap*`/`tun*`) / `fabric` (TurboFabric names, seeded `tp0`) / `uplink`;
uplink and fabric byte rates aggregate independently and are never combined,
and `veth` churn nulls only the container-bridge class. **Sensor subsystem**
(`sensors/`): hwmon/thermal-zone temperatures, RAPL energy-delta CPU power,
hwmon `power1_average` GPU power (NVIDIA power stays `null` — `nvidia-smi`
would be a per-interval subprocess); admin overrides read from
`<daemonStateDir>/metrics/sensor-overrides.json` beat auto-detection; sensor
identities (`chip:label`) and uplink/fabric interface names land in
dimensions. CPU % and per-second rates use two-snapshot deltas; first-sample
rate metrics are **`null`** (never coerced to `0`), and a boot-id change
nulls rates, CPU, and power deltas. GPU selection is device-first
(`selectGpuDevice`): candidates group per hwmon device and one GPU feeds
both temperature and power — a multi-GPU host never mixes two cards in one
sample. **Disk filter** (`block-devices.ts` + `mounts.ts`):
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
selection), and classified interfaces for the
`metrics-capabilities-request`/`-result` correlated round trip in
`src/instance/client.ts` (instance-side cell kind + client route arrive with
the live-metrics-leases phase). **Unsupported OS:**
`UnsupportedMetricsCollector` returns
`{ supported: false, reason: "unsupported_os:<os>" }` and keeps the daemon
running.

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
data-root parses, and sysfs sensor trees (`sensors-intel/` = coretemp +
RAPL, `sensors-amd/` = k10temp + amdgpu, `sensors-multi-gpu/` = two amdgpu
cards for device-consistent GPU selection; a missing `sensors-none/` path
exercises the sensorless-VM case).

