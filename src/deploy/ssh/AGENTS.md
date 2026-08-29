# SSH access (`src/deploy/ssh/`) — AGENTS.md

Parent context: `../AGENTS.md` (tenant deploy & hosting ingress).

Tenant SSH is three files: a pure `authorized_keys` renderer, a pure `sshd`
drop-in renderer, and `apply.ts`, which owns every host write. Nothing here
touches a host outside `apply.ts`, so the bytes deciding who can log in are
assertable in CI.

**Key files are root-owned and live outside the home.**
`/etc/ssh/turbopanel/authorized_keys/<username>`, `root:root 0644`, with every
parent `root:root 0750` plus traverse-only ACLs on `tpsftp` / `tpshell`
because `sshd` opens the file as the account and `StrictModes` refuses a
group-writable path. The obvious location — `~/.ssh/authorized_keys` — is
principal-*writable*, so a tenant could add keys the panel cannot see and
panel-side revocation would stop meaning anything. The trade-off (a tenant
manages keys in the panel, not over SSH) is stated in the product copy.

**Two gates, one definition of canonical.** The control plane fully decodes a
pasted key, compares its embedded algorithm name against its label, and
re-renders it. The daemon then checks only that nothing *structural* — a second
line, an options field, a trailing comment — can reach the file.
`isCanonicalSshPublicKey` (`ssh/key-types.ts`) is that check; `contracts.ts`
mirrors the same regex because it is a zero-import leaf, and
`ssh/apply.test.ts` asserts the two cannot drift.

**The drop-in ends with `Match all`, and that line is load-bearing.** Debian puts
`Include /etc/ssh/sshd_config.d/*.conf` at the *top* of `sshd_config` and
processes it inline, so a `Match` block running to end-of-file swallows every
global directive below the include in the administrator's own file. The drop-in
also sets **no global directive before its first `Match`**, for the mirror-image
reason: `sshd` takes the first occurrence of most keywords, so a global here
would override the administrator's value for the whole host.

**Never repaired, only reported.** A missing `Include` line fails the reconcile
with the line to add — editing someone's `sshd_config` so our own file starts
taking effect is not a move a hosting panel makes silently. `AllowUsers` /
`AllowGroups` / `Deny*` outrank any `Match` and cannot be worked around from a
drop-in, so they become a transcript warning and the reconcile continues.

**Rollout**: stage → swap → `sshd -t` → reload, rolling back to the previous
bytes (or deleting a first-ever file) if the test fails. `reload`, never
`restart`, so established sessions survive a config that passes `-t` and then
rejects every key. The unchanged-content rule means a routine deploy touches
`sshd` not at all.

**`prune` is not a tuning knob.** `applySshAccess` removes key files only when
the caller holds the **complete** managed set for the host. `environment.deploy`
describes one environment and a host serves many, so it passes `prune: false`;
`server.principals.reconcile` carries the whole server and passes `true`.
Pruning from a deploy payload would revoke every other environment's access.
Containment for removal comes from the directory — `/etc/ssh/turbopanel/` is
ours by construction — so `root`'s keys and an administrator's own
`~/.ssh/authorized_keys` are unreachable from here whatever the payload says.

**Access is a group, not a shell test**, because `sshd` matches on groups:
`tpsftp` (files only, `ForceCommand internal-sftp`) and `tpshell`. Membership is
reconciled by `ensurePrincipalManagedGroups` in the same pass as runtime
entitlements — one containment set (`allManagedGroups`), or a principal
downgraded from shell to files-only would keep `tpshell` because the entitlement
pass did not recognize it.
