# Command handlers — AGENTS.md

Handlers live under `src/commands/`. `src/instance/client.ts` is transport
only: it never imports this directory. `src/entry/run.ts` injects
`handleCommandDispatch`, `handleFabricPathProbe`, and `handleDrivetempEnable`
into `InstanceClient` (plus `src/commands/wire.ts` for tests that construct
the client without those options).

Wire contracts (payload parse / result shapes) live in
`src/contracts/commands-contracts.ts` and must stay aligned with the
control-plane canonical `src/contracts/commands/schemas.ts`.

Root context: `../../AGENTS.md`. Transport: `../instance/AGENTS.md`.

## Handlers

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
  commit-confirm rollback lands (`fw-invariants-commit-confirm`); `accept`
  applies. Refusals are `applied: false` + a warning, not a failed command.
- Deploy / lifecycle / stop / system.reconcile / managed.* /
  `server.fabric.reconcile` / `server.sensors.drivetemp.enable` sit in the
  sibling modules next to `command-router.ts`. Remaining
  `instance/client.ts` → `deploy/` / `managed/` edges (rehydrate, docker
  networking, ACME observe, HA observe, managed logs) stay as a documented
  one-way DAG — not fully hexagonalized in this pass.
