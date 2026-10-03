# `src/firewall/` — the managed host firewall (daemon side)

TurboPanel owns the host firewall on every daemon'd server (decided
2026-09-19 after a canary control plane's 8443 was dropped by a pre-installed
ufw). The panel derives the desired ruleset from what it deployed; this
module renders and applies it. Road track `firewall` on the *Road to 0.1.x*
page carries the build order; this is the `fw-daemon-reconcile` row.

| File | Role |
| --- | --- |
| `render.ts` | **Pure.** `FirewallReconcilePayload` → `iptables-restore` / `ip6tables-restore` documents + sha256 digest. Invariants first (lo, `ESTABLISHED,RELATED`, ICMP / ICMPv6, DHCP client, every sshd port, the co-located control plane's ports), then `drop`/`reject` rows, then `accept` rows, then the default. Never emits `OUTPUT`, a builtin policy line, or a jump. |
| `apply.ts` | Host side. `probeXtables`, `hasDockerUserChain`, `isControlPlaneColocated`; `applyRenderedFirewall` = arm the rollback guard and stage the documents (`pending.ts`) → `--test` → `--noflush` restore per family → `-C`/`-I` jumps, **pending, not durable**; `removeFirewall` (mode `off`, and the `turbopaneld firewall off` break-glass); `snapshotFirewallChains` (unused so far); `reinstallFirewallForwardingIfEnabled` (the Docker-monitor hook, wired in `../entry/run.ts` beside the fabric one: at startup and on every Docker reachability change, v4 and v6; while a ruleset is pending it re-applies the *pending* document, never the older confirmed one). |
| `pending.ts` | Commit-confirm state: the marker (`<runDir>/firewall-pending.json`), the pending documents (`<configDir>/firewall.pending.v4|.v6`), the rollback record the guard writes (`<stateDir>/firewall-rollback.json`), `armPendingFirewall` (arms `turbopanel-firewall-guard.timer` **before** anything is loaded; no guard, no rules) and `clearPendingFirewall`. |
| `confirm.ts` | `confirmPendingFirewall(digest)`: promotes the pending documents to the durable `<configDir>/firewall.v4|.v6`, clears the stage, stops the guard. States `confirmed`, `nothing_pending` (idempotent), `digest_mismatch`, `expired`, `rolled_back`. Behind `server.firewall.confirm` and `turbopaneld firewall confirm`. |
| `auto-confirm.ts` | `autoConfirmFirewall(digest, { verifyControlPlane })`: the daemon confirms its own change. After the rules are live it waits 2 s, makes one authenticated round trip to the control plane (`GET /api/daemon/v1/ping`, 20 s limit) and, only if that answers, runs `confirmPendingFirewall`. Fails, times out or no client: does nothing and the 120 s rollback fires. Called from `../commands/firewall-reconcile.ts`; the result carries `confirmation.autoConfirm { ok, reason }`. |
| `fold.ts` | Stage 6 (`fw-fold-existing`). Folds the legacy `TP-MANAGED-PUB` / `TP-MGD-*` chains (`../managed/firewall.ts`) into `TP-FWD`: reads the **live** `iptables -S`, and removes the legacy chain only when every legacy listener is covered (same `--ctorigdst`/port `DROP`, and a `RETURN` containing each source it admitted). Never adds a rule. `deferred` while a ruleset is pending; runs after a confirm and on `turbopaneld firewall fold`. `isManagedListenerCovered` is the same test the legacy installer uses to stop rebuilding a folded listener. TurboFabric's `TP-FORWARD` is left alone. |
| `run.ts` | Spawn + `sudo -n` fallback, with **`-w 5`** on every xtables binary (Docker holds the xtables lock while it mutates chains). Test seams `setFirewallRunForTests` / `setFirewallSkipRealSyscallsForTests`. |
| `sshd-port.ts` | Effective sshd ports from `sshd -T` (`port` and pinned `listenaddress` lines). Fails **open**: no answer → the renderer keeps 22 with a warning. |

## The two hooks

- `INPUT → TP-INPUT` — host listeners (sshd, Caddy on the co-located host,
  WireGuard, host-native sites, Raft). Where ufw lived. `scope: host`.
- `DOCKER-USER → TP-FWD` — ports Docker publishes (Traefik, ProxySQL, managed
  listeners, compose `ports:`). Matched post-DNAT on `--ctorigdstport` /
  `--ctorigdst`; the chain opens with `RETURN`s for reply traffic and for
  anything that entered on `docker0`, `br-+`, `tp0`, so container egress is
  never restricted (`xt_conntrack` has no DNAT status match — `--ctstatus
  DNAT` is nftables-only). Ends in an implicit `RETURN`: Docker keeps
  governing what the panel did not restrict. `scope: published`. An `accept`
  from named sources **narrows** (RETURN those, DROP the rest for that port);
  an `accept` from `any` renders nothing.

A separate native nftables table with `policy drop` on the forward hook was
considered and rejected: it needs every legitimate forward path enumerated
as an invariant, and one omission is an outage.

## Verified on a real host (2026-09-19, Debian 13 container, iptables v1.8.11 nf_tables)

`iptables-restore --noflush` with `:TP-X - [0:0]` flushes and rebuilds
**only that chain** (re-apply is idempotent, no doubling); `--test` validates
without touching the kernel; `-i br-+` and `--ctorigdstport` parse; the
rendered v4 and v6 documents apply as-is. The exact documents that were
`--test`ed and applied twice live in `fixtures/golden.v4|.v6`, and
`render.golden.test.ts` pins the renderer to them byte-for-byte — so a rule
template edit shows up as a diff a reviewer reads. **Re-run the container
proof (command in that test's header) before regenerating a fixture; never
regenerate to make a red test green.** The hostfree suites (`render.test.ts`,
`render.golden.test.ts`, `apply.test.ts`,
`../commands/firewall-reconcile.test.ts`) are the bar for this row;
the on-host proof is Road row `fw-proof`.

## Commit-confirm (`fw-invariants-commit-confirm`)

Outbound is an invariant `ACCEPT` and `ESTABLISHED,RELATED` is always accepted,
so no ruleset can break a remote daemon's own connection: "roll back when the
daemon loses the control plane" could never fire. What a bad ruleset cuts is a
human's SSH, the co-located panel's own port, public tenant ports, and the same
after a reboot if it were persisted. So an apply is **pending** until someone
who reached the host from outside confirms it:

1. `applyRenderedFirewall` writes the marker and the pending v4 document, then
   `systemctl restart turbopanel-firewall-guard.timer`. If that fails it throws
   `FirewallGuardUnavailableError` and **loads nothing**.
2. It loads the rules (`--test` first; a refusal clears the stage again) and
   records the IPv6 intent in the marker (`replace` / `forget` / `keep`).
3. The result carries `confirmation: { state, deadlineAt, windowSeconds: 120,
   autoConfirm }`. **The daemon confirms itself** (`auto-confirm.ts`, owner
   decision 2026-10-03): when it can make a fresh authenticated round trip to
   the control plane after the rules are live, it runs the confirm below and
   reports `state: "confirmed"`, `autoConfirm.ok: true`. Otherwise
   `state: "pending"`, `autoConfirm.ok: false` with the reason, and nothing
   else happens. The control plane runs no test and no outside probe, and no
   human clicks. `server.firewall.confirm` and `turbopaneld firewall confirm`
   still work (same function, idempotent). **What this does not prove:**
   outbound is never filtered, so the check cannot show inbound access (SSH,
   public ports) survived; the invariant SSH/control-plane ACCEPTs are what
   protect that. A rollback is reported as `lastRollback` on the next result
   (only while nothing is pending; a confirm clears the record).
4. `confirmPendingFirewall` promotes the pending documents to the durable ones,
   clears the marker and stops the timer. After the deadline it refuses
   (`expired`) and starts the guard service instead.
5. Otherwise `orchestration/scripts/tp-firewall-guard` (root, from
   `<install>/lib`, run by the timer) takes both TurboPanel jumps out first
   (the host is open), then restores the last **confirmed** documents if they
   exist and are strictly TurboPanel's own chains and targets (validated, not
   trusted, and never read through a symlink), else deletes the chains. It
   writes `firewall-rollback.json`, removes the marker and pending documents,
   stops its timer. It **fails open**: any error leaves fewer restrictions,
   never more. It does not need the daemon to be running.

The guard timer is not enabled at boot and `<runDir>` is tmpfs, so a reboot
forgets any pending ruleset; the durable documents change only on confirm.

**Boot (`fw-boot-persistence`).** `turbopanel-firewall.service` (enabled by the
`daemon-launch` role, `DefaultDependencies=no`, `Before=network-pre.target
docker.service`, a no-op until `/etc/turbopanel/firewall.v4|.v6` exists) runs
`tp-firewall-guard restore`: it loads **only the confirmed documents** (never a
pending one: it removes stale `firewall.pending.*`), with the same validation
and the same fail-open handling as a rollback, and writes no rollback record.
`ExecStart=-` means the unit can never fail a boot. `TP-INPUT` is therefore in
place before Docker starts; `TP-FWD` needs `DOCKER-USER`, which only exists once
dockerd is up, so the daemon's Docker monitor re-hangs it
(`reinstallFirewallForwardingIfEnabled`) at startup and whenever Docker becomes
reachable again, in both families: Docker 28+ builds the IPv6 `DOCKER-USER`
by default (Docker 29.8.1 on the fleet, checked 2026-10-01), so v6 is re-hung
exactly like v4, each family on its own. Under a pending ruleset v6 is re-hung
only when the marker records `replace`; `keep` / `forget` leave v6 to the guard.
`turbopaneld firewall off` (root, over SSH) removes every chain, jump, stored
document and the pending state: the break-glass when the panel is unreachable.
The default-drop hold below stays until the guard has been proven on a real
host (`fw-proof`).

## Guards, in order

1. `mode: off` → `removeFirewall`, nothing probed.
2. No `iptables` → the command **fails** (nothing to render against).
3. `policy.inputDefault: drop` → rendered, then **refused**
   (`DEFAULT_DROP_HELD_WARNING`) until the commit-confirm guard is proven on a
   real host (`fw-proof`) and the control plane confirms from outside (stage 4).
   A co-located control plane with no `controlPlane.tcpPorts` adds
   `CONTROL_PLANE_PORTS_MISSING_WARNING`. Remove the hold there, not before.
4. `mode: observe` → rendered, digest reported, nothing applied.
5. v4 apply failure throws. A v6 apply failure keeps v4 loaded (pending, under
   the guard: nobody confirms a failed command, so the guard undoes it at the
   deadline), leaves the v6 chains and the durable `firewall.v6` as they were,
   and throws `FirewallIpv6ApplyError`, so the reconcile fails in the panel
   rather than enforcing a `drop` on IPv4 only behind a warning. The error text
   starts `ipv6_unfiltered:`. No `ip6tables` binary at all (v6 rendered) is a
   successful apply with `ipv6Status: "ipv6_unfiltered"` and a warning that
   begins `ipv6_unfiltered:`; the control plane must show it as degraded, never
   as plain success. `ipv6Status` is absent on observe/off/refused results.

## Not here yet (later rows)

The control plane's outside probe that sends the confirm
(`fw-derived-rules`); the
installer's bootstrap ruleset (`fw-installer-bootstrap`; the ufw/firewalld
removal itself is done — `orchestration/roles/daemon-prereqs/tasks/firewall-takeover.yml`,
on every converge, `fw-takeover`); the panel-side derivation of a managed public listener's exact peer sources (the daemon fold in `fold.ts` is built and inert until the panel sends that rule; TurboFabric's `TP-FORWARD` stays its own chain).
