# Command handlers — AGENTS.md

Handlers live under `src/commands/`. `src/instance/client.ts` is transport
only: it never imports this directory. `src/entry/run.ts` calls
`wireCommandPorts` (`src/commands/wire.ts`) before it connects, which
registers all nine client ports: command dispatch, the fabric path probe,
drivetemp enable, session open and attach (resend kept results), the result
ack, repeated dispatches, the `hello` report and the 60 s TurboFabric peer
readings (`subscribeFabricPeers`). Nothing is passed as client
options any more. Tests that construct the client call `wireCommandPorts` (or
`registerCommandPorts`) the same way.

Wire contracts (payload parse / result shapes) live in
`src/contracts/commands-contracts.ts` and must stay aligned with the
control-plane canonical `src/contracts/commands/schemas.ts`.

Root context: `../../AGENTS.md`. Transport: `../instance/AGENTS.md`.

## Handlers

`cache.apply` (`cache-apply.ts`, feature `project-cache-v1`) brings a host's
project caches for one environment in line between deploys: the complete set in
`caches`, removals in `removed` (`deleteData` per entry), under the environment
lock. A cache whose Hosting Account is not on the host yet is answered `pending`.
It never prunes a cache that is merely not listed. Detail: `../deploy/cache/AGENTS.md`.

- `server.timezone.set` / `server.ntp.set` (`timezone.ts`, `ntp.ts`) apply via
  `runTimeSyncApply` → `time-sync-apply.yml` and return observed host state
  from `readTimeSync()`.
- `server.firewall.reconcile` (`firewall-reconcile.ts`) renders the panel's
  complete desired firewall through `src/firewall/render.ts` and applies it
  through `src/firewall/apply.ts` (see `src/firewall/AGENTS.md`). Two hooks:
  `INPUT → TP-INPUT` for host listeners, `DOCKER-USER → TP-FWD` for published
  container ports; atomic `iptables-restore --noflush` of only those chains;
  invariants (lo, established, ICMP/ICMPv6, DHCP, every `sshd -T` port, the
  co-located control plane's ports) rendered first. `policy.inputDefault:
  drop` is **held** (rendered, refused with `DEFAULT_DROP_HELD_WARNING`) until
  the commit-confirm guard is proven on a real host (`fw-proof`); `accept`
  applies, **pending**: the result carries `confirmation.deadlineAt`, the rules
  become durable only when `server.firewall.confirm` (`firewall-confirm.ts`)
  names the result's digest in time, and a root timer undoes them otherwise.
  Refusals are `applied: false` + a warning, not a failed command.
- `server.folders.remove` (`remove-folders.ts`) removes the folders of assets
  the panel has deleted, by components, and reports each (`removed`, `reason`).
  See `src/deploy/release/AGENTS.md` ("Explicit folder removal").
- `server.principals.reconcile` also reports `folders[]` (every asset folder
  found by `tp-host folder-list`; omitted, with a warning, when the listing
  could not be completed) and each account's `home`. Nothing is removed because
  of it; the control plane compares it with its own record.
- Deploy / lifecycle / stop / system.reconcile / managed.* /
  `server.fabric.reconcile` / `server.sensors.drivetemp.enable` sit in the
  sibling modules next to `command-router.ts`. Remaining
  `instance/client.ts` → `deploy/` / `managed/` edges (rehydrate, docker
  networking, ACME observe, HA observe, managed logs) stay as a documented
  one-way DAG — not fully hexagonalized in this pass.

## TurboFabric LAN paths (`fabric-lan-routes-v1`)

`server.fabric.reconcile` may carry `tunnel: false` (no `tp0`: it is taken
down like a pause, the key is kept and never created; `peers` must be empty,
`address` may be absent) and `lanRoutes` (`{ cidr, via }`: a member's
container subnet routed via its LAN address on the interface whose connected
subnet holds it; `fabric-lan-routes.ts`). Installed LAN routes are recorded in
`state.json` (`installedLanRoutes`) and are the only ones ever removed. A
pause keeps LAN routes and their `TP-FORWARD` accepts; a teardown removes
them, and so does `scripts/purge.sh`. IPv6 entries are validated but not
installed (forwarding is IPv4 only). Strict reverse-path filtering passes
because the LAN route sends replies out of the interface the traffic came in
on, so no `rp_filter` change is made.

A skipped LAN or `tp0` route is reported in the result's `warnings` (plain
sentences, at most 20), not only logged (warnings go to `daemon.err.log`), and
the apply stamp is not written, so the next reconcile retries it. Docker is
not a fabric prerequisite: without it the tunnel and routes come up, the
routed bridges wait (a `warnings` entry says so) and are created when Docker
becomes reachable, and `TP-FORWARD` hangs off `FORWARD` until `DOCKER-USER`
exists.

## TurboFabric pause and teardown

The daemon is the only owner of `tp0`. Taking it down runs every step even
when one fails (retire a `wg-quick@tp0` that is enabled or running, delete
`tp0`, forwarding rules, files) and then fails the command with one error
naming the failed steps. A pause writes `suspended` first, so a restart keeps
the tunnel down. Boot with a paused state, or with no state at all, deletes a
leftover `tp0`. Host calls refused with systemd's "Access denied" are retried
through `tp-host`, like "Operation not permitted".

## Command results survive a lost link (`command-recovery-v1`)

`command-outbox.ts` journals every accepted command under
`<stateDir>/commands/inflight/<id>.json` (atomic temp file + rename): the
accept time, the latest step plan (rewritten on a step change, otherwise at
most every 30 s) and, once finished, the final `command-outcome`. The
entry is removed only when its `command-outcome-ack` arrives; until then the
outcome is sent again on every attach and every 30 s.
Kept results are paced: at most `OUTCOME_BURST_MAX` (20) per socket per 30 s
window (the control plane closes a socket past 120 frames a minute), never
sent twice on one socket between its open and its attach, and the rest go out
on the next windows. At most 64 stay unconfirmed, for at most 7 days counted
from when they were journaled; beyond that the oldest are dropped.
An entry with no outcome left by a killed daemon is answered with a failed
outcome whose `result` is `{ interrupted: true, lastStep?, releasePromoted? }`.
`hello` / `heartbeat` carry `commands: { running, unacked }` (ids, at most 64)
when either list is not empty, and a running deploy repeats its step plan every
30 s. Transcript chunks the control plane has not taken are kept and resent in
order (retry every 5 s, resync from the `nextSeq` of a `409`; see
`../logs/sink.ts`).

### Known commands on `hello` (`command-recovery-v2`)

Listed in `hello.features` next to `command-recovery-v1` (which stays). A
control plane that does not read it ignores the name and the field. Wire
contract, field `commandState` on **every `hello`** (never on `heartbeat`;
present even when `known` is empty):

| Field | Type | Meaning |
|---|---|---|
| `commandState.processStartId` | string (UUID) | Made once per daemon process; the same on every reconnect of that process, different after a restart |
| `commandState.known` | string[] (at most 256 ids, each at most 64 characters) | Ids of commands this daemon accepted and still holds state for: running, finished with the outcome not yet confirmed (`command-outcome-ack`), and entries a previous process left in the on-disk journal. Read from disk before the socket opens, so the first hello after a restart is already complete |
| `commandState.complete` | boolean | `true` when `known` lists every such id and the journal directory was read. `false` when the list was cut or the journal was unreadable; then a missing id proves nothing |

Reading it: with `complete: true`, a `command-dispatch` the control plane sent
and never saw acked, whose id is not in `known`, was never started by this
daemon, so sending it again
cannot run it twice, whatever its type. This holds because a command is journaled (file and directory flushed) before
it runs, and a command that cannot be journaled (write failure, an id that is
not safe as a file name) is refused with a failed outcome and never runs. An
unconfirmed outcome dropped for the 64-entry cap leaves an id-only tombstone
on disk, listed in `known` until 7 days after it was recorded; one past 7 days
is removed. `*.tmp` files a crash left are deleted at startup. An id in `known` is held; its outcome
arrives on its own, so it is never sent again. Limits the control plane must
keep: only resend a command that is still non-terminal in its own records
(an acknowledged outcome removes the id from `known`), only one younger than
the 7-day unconfirmed retention, and skip a request written after the
connection attached. With `complete: false`, or without the field, keep the
v1 rule (safe-to-repeat types only). A restart changes `processStartId`.

The connection recycle (2 h, jittered) waits for a quiet moment: when the age
limit passes with a command running or an outcome unconfirmed it recycles at
the next idle tick that is quiet, and in any case no later than 10 minutes
past the limit (`MAX_CONNECTION_QUIET_WAIT_MS`). The daemon has no command
queue: commands run concurrently, serialised only by per-resource locks, so
the control plane's per-server lane is where a reconcile can hold up a newer
user command.

Outcomes are sized before they are journaled and sent: `error` keeps its
last 4000 characters (the control plane caps it at 4096), and a successful
`result` over 64 KB as JSON (`capOutcomeResult`, the control plane's
`MAX_DAEMON_WS_RESULT_JSON_BYTES`) is sent as a failed outcome without it,
error "The server's report was too large to store (N KB; limit 64 KB).", with
one warn line. An older control plane closes the socket on a larger result,
and the kept outcome was then resent on every attach, forever; a current one
records the same failure itself.

## Scope Summary (Former Root Index Entry)

| Subsystem | Read before editing | Covers |
|---|---|---|
| **Command handlers** | `src/commands/AGENTS.md` | Daemon command implementations (`command-router.ts`); injected into `InstanceClient` from `src/entry/run.ts` so transport never imports handlers |

## TurboFabric iptables calls wait for the lock

`fabric.ts` `runHost` prepends `-w <XTABLES_LOCK_WAIT_SECONDS>` (the firewall
fold's value, `src/firewall/run.ts`) to every `iptables` call except the
`--version` probe, so a call that meets Docker's or the firewall apply's xtables
lock waits instead of failing. `tp-host` already accepts `-w` and its argv
checks are unchanged. Fabric rule changes touch only `TP-FORWARD` (and its jump
off `DOCKER-USER` / `FORWARD`), which the firewall fold and the managed
installer do not read, so they stay outside the daemon firewall lock
(`src/firewall/lock.ts`). Test fakes see argv without the prefix through
`src/testing/xtables-wait.ts`, which asserts it is there.
