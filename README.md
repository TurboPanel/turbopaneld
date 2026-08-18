# TurboPanel Daemon

**Host daemon for every TurboPanel-managed host** — Ansible orchestration, authenticated control-plane presence, deploy/runtime, and host metrics.

[![Release](https://img.shields.io/github/v/release/turbopanel/turbopaneld?label=release)](https://github.com/turbopanel/turbopaneld/releases)
[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-daemon%20setup-3366cc)](https://turbopanel.io/docs/deployment/daemon-setup)
[![Status: Private alpha](https://img.shields.io/badge/status-private%20alpha-3dd68c)](https://turbopanel.io/roadmap)

GitHub: [turbopanel/turbopaneld](https://github.com/turbopanel/turbopaneld). Package name: `turbopaneld`.

> **Private alpha** — Neither TurboPanel High Availability nor self-hosted is publicly available yet. The production install steps below describe the target flow as we work toward a beta release; see the [roadmap](https://turbopanel.io/roadmap) for progress.

## What the daemon does

On each enrolled server, `turbopaneld`:

- Maintains an authenticated WebSocket to the control plane (`/ws/daemon/v1`)
- Runs Ansible playbooks to install runtimes, Docker, Caddy, databases, and application stacks
- Executes correlated commands (deploy, stop, ping, hostname, reboot, timezone, NTP, TurboFabric, managed engines)
- Collects and reports host metrics (`/proc`-based, 20-metric contract)
- Applies dev-sync tarballs and tunnel tokens when co-located with a developer control plane

The daemon is the **only** component that runs Ansible on managed hosts.

## How it talks to the control plane

| Layer | Detail |
| --- | --- |
| Transport | HTTPS upgrade to **WSS** at `/ws/daemon/v1` |
| Authentication | Short-lived **daemon JWT** (EdDSA / Ed25519, 15-minute lifetime) |
| Key discovery | `GET /api/daemon/v1/jwks.json` |
| TLS trust | Platform CA for self-hosted (`GET /api/daemon/v1/instance/ca`); system roots for public certs |
| Enrollment | License-based hello + challenge/response; persists `serverId` and daemon keys under `/var/lib/turbopanel` |

Remote daemons dial the public control-plane URL. Co-located daemons on the control-plane host may use a Unix socket when configured.

## Required privileges (production)

| Item | Value |
| --- | --- |
| Service user | `tp:tp` (UID/GID **9999**) |
| systemd unit | `turbopaneld.service` |
| Sudo | Passwordless sudo for Ansible orchestration tasks |
| State | `/var/lib/turbopanel` (license, keys, fabric material) |
| Config | `/etc/turbopanel/daemon.env` |
| Logs | `/var/log/turbopanel/daemon.log`, `daemon.err.log` |

Development co-located installs run as the current dev user instead of `tp` — see [Developing the daemon](#developing-the-daemon).

## Supported OS and architecture

| OS | Architecture | Notes |
| --- | --- | --- |
| Debian 12+ (Bookworm / Trixie) | `x86_64` (amd64) | Recommended |
| Debian 12+ (Bookworm / Trixie) | `aarch64` (arm64) | Supported |
| Raspberry Pi OS **64-bit** | `aarch64` (arm64) | 64-bit images only |

**Not supported:** 32-bit ARM (`armv7l`, `armhf`), 32-bit Raspberry Pi OS, or any CPU other than `aarch64` and `x86_64`.

Full matrix: [Daemon setup](https://turbopanel.io/docs/deployment/daemon-setup).

## Version compatibility

Pair daemon builds with a compatible control plane channel. See [compatibility matrix](https://turbopanel.io/docs/deployment/compatibility) and [upgrade guide](https://turbopanel.io/docs/deployment/upgrade).

## Production install

Obtain a license from your TurboPanel organization, then run the official installer:

```sh
curl -fsSL turbopanel.sh | TURBOPANEL_LICENSE=<base64url-license> sh
```

For self-hosted control planes, add `TURBOPANEL_HOST=https://<instance-host>:8443`.

### Trust and what the script does

- Hosted at **https://turbopanel.sh** (assets-only Cloudflare Worker — no server-side script execution; see `workers/turbopanel-sh/` in this repo)
- Downloads the release artifact for your channel, lays out `/opt/turbopanel`, installs `turbopaneld.service`, and runs initial Ansible converge
- **Self-escalates with `sudo`** when needed — do not prefix the pipeline with `sudo`
- Fetches the platform CA from the control plane for TLS verification on self-hosted installs

Upgrade: re-run the same command or use the in-console **Update** action. Removal: [Uninstall guide](https://turbopanel.io/docs/deployment/uninstall).

## Logs and troubleshooting

```sh
journalctl -u turbopaneld -f
tail -f /var/log/turbopanel/daemon.log
```

- [Troubleshooting](https://turbopanel.io/docs/deployment/troubleshooting)
- [Daemon update / refresh](https://turbopanel.io/docs/deployment/daemon-update)
- [Daemon trust model](https://turbopanel.io/docs/security/daemon-trust-model)

## Security

Report vulnerabilities: [turbopanel.io/security](https://turbopanel.io/security?utm_source=github-daemon-readme) · [Private reporting](https://github.com/turbopanel/turbopaneld/security/advisories/new)

## Developing the daemon

Contributor workflow uses the [TurboPanel Development Environment](https://github.com/turbopanel/dev) — **not** the production installer above.

Clone the six sibling repos (including this one), then from the `dev` checkout:

```sh
vagrant up
vagrant ssh
# inside guest:
dev/console
```

That boots the Vagrant guest with sibling checkouts mounted, runs the daemon from source via Deno, and converges the dev overlay. Details: [Local development](https://turbopanel.io/docs/getting-started/development?utm_source=github-daemon-readme).

Maintainer conventions and path model: [AGENTS.md](./AGENTS.md).

## License

TurboPanel Daemon is licensed under the [GNU Affero General Public License v3.0 only (AGPL-3.0-only)](./LICENSE).

Copyright (C) 2025 TurboPanel contributors
