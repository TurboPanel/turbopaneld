# Host metrics (daemon collector) — AGENTS.md

Fire-and-forget host-metrics collection (async `/proc` + `statfs` reads, **no** per-interval subprocesses) and scheduling, sent via `POST /api/daemon/v1/metrics`. The 20-metric order is an external storage contract mirrored (not build-coupled) with the instance.

Root context: `../../AGENTS.md`. Instance-side storage/query/caching: `../../../instance/src/daemon/metrics/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Host metrics

Samples are sent via authenticated `POST /api/daemon/v1/metrics`
(`DaemonApiClient.sendHostMetrics`, `src/instance/api-client.ts`,
fire-and-forget). Protocol v1 request body:

```json
{ "type": "metrics", "version": 1, "at", "intervalSeconds", "sequence", "metrics", "dimensions" }
```

Contract mirrored (not build-coupled) in `src/metrics/contract.ts` ↔
`../instance/src/daemon/metrics/contract.ts` (`METRICS_SCHEMA_VERSION = 1`). The
20-metric ordered list (`HOST_METRIC_KEYS`: `cpuUsagePercent` … `uptimeSeconds`)
is an **external storage contract** — positional AE doubles and ClickHouse
columns depend on this order.

**Scheduling** (`src/metrics/scheduler.ts`): `MetricsScheduler` takes an
injected `MetricsSink` (`attach(send)`) rather than the raw `WebSocket` — the WS
keeps only commands/outbox + the cell ping. One sample ~every **60 s**
(`METRICS_INTERVAL_MS`) while connected; deterministic per-`serverId` phase
jitter ≤**5 s** (`METRICS_JITTER_MAX_MS`, FNV‑1a — does not change query
resolution). Monotonic process-local `sequence` resets on daemon restart (not
persisted). Fire-and-forget, disposable — no acks, retries, or outbox. Never
blocks startup, connect, liveness, command dispatch, shutdown, or reconnect.
Factory/collect/send failures are rate-limited (`METRICS_LOG_RATE_LIMIT_MS` = 5
min) and must not tear down the socket. Overlapping ticks are dropped; the
steady interval arms when the jittered first tick fires (not after first-collect
completion). Attach-scoped generation ignores stale in-flight emits across
detach/reconnect. Scheduler rebinding tracks `#metricsSchedulerServerId`
separately from `#tokenServerId` so jitter stays tied to the authenticated
server after identity recovery.

**Collector** (`src/metrics/collector/`): async reads only — **no subprocesses
per interval** (no `top`/`vmstat`/`iostat`/`free`/`df`/`ps`/`sar`). Sources:
`/proc/stat`, `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime`,
`/proc/diskstats`, `/proc/net/dev`, `/proc/sys/kernel/osrelease`, process count
via `/proc`, root filesystem via `node:fs/promises` `statfs` on `/` (no `df`).
CPU % and per-second rates use two-snapshot deltas; first-sample rate metrics
are **`null`** (never coerced to `0`). **Disk filter** (`parse-diskstats.ts`):
exclude device prefixes `loop`, `ram`, `zram`, `fd`, `dm-`, `md`, `dcssblk`,
`sr`, `nbd`; drop partition rows (`^p?\d+$` suffix) when the parent whole-disk
row survives; sectors = 512 B. **Net filter** (`parse-net-dev.ts`): exclude
`lo`. Per-filesystem and per-interface series are deferred to future event
types. **Unsupported OS:** `UnsupportedMetricsCollector` returns
`{ supported: false, reason: "unsupported_os:<os>" }` and keeps the daemon
running.

**Env:** `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS` default `90` (instance
ClickHouse raw TTL). Server metrics are always on — there is no instance-side
enable/disable gate; the daemon always collects and emits host metrics
fire-and-forget, and the instance always persists when a backend is configured.
ClickHouse connection vars and `CLICKHOUSE_VERSION` pin: see **ClickHouse**
below and **`../instance/AGENTS.md`** (Server metrics).

**Local validation:** fixture-driven tests under `src/metrics/` (no live `/proc`
required):

```bash
deno test src/metrics/
deno fmt && deno lint && deno check
deno task check:layout
```

Fixtures: `src/metrics/collector/testdata/`.

