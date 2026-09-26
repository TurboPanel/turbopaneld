# `src/firewall/` — the managed host firewall (daemon side)

TurboPanel owns the host firewall on every daemon'd server (decided
2026-09-19 after a canary control plane's 8443 was dropped by a pre-installed
ufw). The panel derives the desired ruleset from what it deployed; this
module renders and applies it. Road track `firewall` on the *Road to 0.1.x*
page carries the build order; this is the `fw-daemon-reconcile` row.

| File | Role |
| --- | --- |
| `render.ts` | **Pure.** `FirewallReconcilePayload` → `iptables-restore` / `ip6tables-restore` documents + sha256 digest. Invariants first (lo, `ESTABLISHED,RELATED`, ICMP / ICMPv6, DHCP client, every sshd port, the co-located control plane's ports), then `drop`/`reject` rows, then `accept` rows, then the default. Never emits `OUTPUT`, a builtin policy line, or a jump. |
| `apply.ts` | Host side. `probeXtables`, `hasDockerUserChain`, `isControlPlaneColocated`; `applyRenderedFirewall` = `--test` → `--noflush` restore per family → `-C`/`-I` jumps → durable `<configDir>/firewall.v4|.v6`; `removeFirewall` (mode `off`); `snapshotFirewallChains` (the rollback input commit-confirm will use); `reinstallFirewallForwardingIfEnabled` (the Docker-monitor hook, wired in `fw-boot-persistence`). |
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

## Guards, in order

1. `mode: off` → `removeFirewall`, nothing probed.
2. No `iptables` → the command **fails** (nothing to render against).
3. `policy.inputDefault: drop` → rendered, then **refused**
   (`DEFAULT_DROP_HELD_WARNING`) until commit-confirm rollback exists. A
   co-located control plane with no `controlPlane.tcpPorts` adds
   `CONTROL_PLANE_PORTS_MISSING_WARNING`. Remove the hold in
   `fw-invariants-commit-confirm`, not before.
4. `mode: observe` → rendered, digest reported, nothing applied.
5. v4 apply failure throws. A v6 apply failure keeps v4 applied and its
   durable document written, leaves the v6 chains and `firewall.v6` as they
   were, and throws `FirewallIpv6ApplyError`, so the reconcile fails in the
   panel rather than enforcing a `drop` on IPv4 only behind a warning. No
   `ip6tables` binary at all is still a warning (`ipv6Applied: false`).

## Not here yet (later rows)

Commit-confirm rollback and `turbopaneld firewall off`
(`fw-invariants-commit-confirm`); the boot unit and the Docker-monitor call
to `reinstallFirewallForwardingIfEnabled` (`fw-boot-persistence`); the
installer's bootstrap ruleset (`fw-installer-bootstrap`; the ufw/firewalld
removal itself is done — `orchestration/roles/daemon-prereqs/tasks/firewall-takeover.yml`,
on every converge, `fw-takeover`); folding `../managed/firewall.ts` and the fabric `TP-FORWARD`
chain into the renderer (`fw-fold-existing`).
