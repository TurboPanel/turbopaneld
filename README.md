# TurboPanel Daemon

Node agent for TurboPanel-managed hosts — Ansible orchestration, instance WebSocket presence, deploy/managed engines, host metrics.

GitHub: [turbopanel/turbopaneld](https://github.com/turbopanel/turbopaneld). Package name: `turbopaneld`. Local checkout: `~/daemon` (or `${TURBOPANEL_DAEMON_REPO}`).

## Development

Do **not** bootstrap this repo on its own. The co-located stack is owned by **[turbopanel/dev](https://github.com/turbopanel/dev)**.

```sh
curl -fsSL trbp.nl/develop.sh | sh
```

That installs/updates `~/dev`, launches the developer console, and (after **Converge**) runs the daemon from this checkout via Deno (`turbopaneld.service`) with the `dev/orchestration` overlay. Mutable data lives under FHS paths (`/etc/turbopanel`, `/var/lib/turbopanel`, …) owned by the current dev user.

Typical layout after converge:

| Path | Repo |
| --- | --- |
| `~/dev` | [turbopanel/dev](https://github.com/turbopanel/dev) — console + Ansible overlay |
| `~/daemon` | this repo |
| `~/instance` | control plane |
| `~/ui` | product console |
| `~/website` | marketing + docs |

Edit sources in place under `$HOME`. Re-converge from the console when the stack needs refresh. Details: [dev README](https://github.com/turbopanel/dev#readme) and [Local development](https://turbopanel.io/docs/getting-started/development).

Production installs use `curl -fsSL turbopanel.sh/run.sh | sh` (legacy alias: `trbp.nl/run.sh`) — separate from the developer console.

Agent conventions and path model: [AGENTS.md](./AGENTS.md).
