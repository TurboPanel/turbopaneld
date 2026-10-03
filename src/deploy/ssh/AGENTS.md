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

**Every principal is matched, including one with no level.** `tpprincipal`
(registry `accessGroups.principal`) is joined by every principal in
`resolveManagedGroups`, whatever the wire says, and a failed join fails the
reconcile instead of being logged. Its `Match` block comes after the level
blocks and refuses every sign-in method (`PubkeyAuthentication no`,
`AuthorizedKeysFile none`, …) and every forward. Because `sshd` keeps the
first value of each keyword, a level member is untouched; the block only
decides for a principal with no level, which before matched nothing and fell
through to the host defaults — its own `~/.ssh/authorized_keys` and
`AllowTcpForwarding yes`, so a planted key was a tunnel into the host's
loopback and LAN (found live 2026-10-02). Rule: the backstop may only set
keywords **every** level block already sets (`apply.test.ts` pins it); a
`ForceCommand` or `ChrootDirectory` there would leak onto `tpshell` members.
The SFTP chroot lives in `sftpLevelDirectives` for that reason.
For the same reason the drop-in is ensured on **every** deploy that
materializes a principal (`applyDeploySshAccess`), not only when keys are
declared; a keyless principal gets no key file. Every level block also sets
`AllowStreamLocalForwarding no`, `PermitOpen none` and `PermitListen none`.

**Password sign-in is a third group plus a shadow hash.** `tppasswd` is
additive — its `Match` block sets only `PasswordAuthentication yes` and sits
**first** in the drop-in, because when several `Match` blocks apply `sshd`
takes the first instance of each keyword; everything else still comes from the
member's level block, and non-members keep the level blocks' explicit `no`.
The hash itself is sha512-crypt, computed control-plane side (the plaintext
never rides the wire), applied by `ensurePrincipalPassword` in
`ensure-principal.ts` via `chpasswd -e` over **stdin** — never argv, which
`ps` can read. A material with no `passwordHash` locks the account password
(`usermod -p !`), the state `useradd` created it in.

**The SFTP chroot is a per-host switch, on last.** With the switch on, the
`tpsftp` block gets `ChrootDirectory <root>/%u` and
`ForceCommand internal-sftp -d /home`: the jail is the root-owned principal
home, the session starts in `home/`, and `sites/` is visible read-only. `%u`,
not `%h`, because the passwd home is `home/` one level down. The switch is
`/etc/ssh/turbopanel-sftp-chroot`, outside every tp-host tree, so no generic
verb can write or remove it: only `tp-host sftp-chroot on` (which refuses
while any member — supplementary or primary `tpsftp` — fails
`sftp-chroot check`: a chroot path component not root-owned or group/world
writable, no principal-owned `home/`, a passwd home other than
`<root>/<p>/home`, or `tpshell` held as well) and `off`, the ungated
rollback. The daemon asks `sftp-chroot status` (`on <root>` | `off`) and
renders the root tp-host validated, never its own environment's; an
unreadable or malformed answer aborts the reconcile rather than unjailing.
When on, each reconcile re-runs `check` (findings become warnings and the jail
stays — fail closed for that member), and after `sshd -t` runs
`sftp-chroot verify`, which asks `sshd -T -C user=<member>` whether the jail
is really effective; a refusal rolls the drop-in back like a failed `-t`.
`server.principals.reconcile` reports `sftpChroot`.
