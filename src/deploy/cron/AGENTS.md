# Scheduled jobs (`src/deploy/cron/`) — AGENTS.md

Parent context: `../AGENTS.md` (tenant deploy & hosting ingress).

One systemd timer per `x-turbopanel.cron[]` entry, plus the `oneshot` service it
triggers. Same pure-renderer / apply split as `native/`.

**Why timers rather than `/etc/cron.d`.** The service sets `User=`, so
`ExecStart` reaches `execve` **after** systemd has dropped privileges — which
makes `/usr/bin/php8.4` succeed or fail purely on the account's entitlement
groups. Nothing in the generated unit grants anything, and that is the cleanest
demonstration that entitlement had to be an OS grant rather than something baked
into generated config. It also reuses the per-principal slice (a runaway job
counts against the same account ceiling its app does) and journald captures
output, which is why the command parser can refuse `>>` outright — there is
somewhere better for it to go.

**The schedule arrives already translated.** `OnCalendar`, not cron: the control
plane owns the translation (`lib/cron.ts`) because the two disagree about what
restricting both day fields means, and that disagreement has to be refused in
one place rather than re-derived here. The daemon's gate is a charset check
only — systemd is the authority on its own grammar, and re-implementing it would
give two answers to one question.

**`ExecStart` is argv**, every argument systemd-quoted unconditionally: one code
path, and no judgement call about which characters are safe in a unit file. The
wire already refuses NUL/CR/LF in an argument, so what is left cannot terminate
the directive.

**Rollout**: render → install only on a byte difference → **one**
`daemon-reload` after every file is on disk → enable only what moved. That last
step is not an optimization: `enable --now` resets a timer's next firing, so
re-enabling everything each deploy would mean a five-minute job on a busy
project never actually fires. A failed `daemon-reload` fails the apply rather
than enabling against a set systemd has not read.

**Removal is scoped by environment id**, which is baked into the unit name. A
job deleted from compose has its timer disabled and both files removed;
another environment's timers on the same host are never listed, let alone
touched. The apply runs even when the payload declares no jobs — skipping it
then would leave a deleted job firing forever, which is the failure nobody
notices until it does something.

**A principal is required.** A timer with no `User=` runs as root, and there is
no safe account to guess. Refused at prepare (`site_cron_unowned`), on the wire,
and in the daemon's own contract parser.

`Persistent=false` and a `RandomizedDelaySec` spread: a host down for a week must
not stampede every missed run on boot, and a hundred sites scheduled every five
minutes must not all fire on the same tick.

