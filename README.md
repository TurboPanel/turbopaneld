# turbopanel-daemon

Remote daemon for TurboPanel-managed servers. Connects back to an instance over
HTTPS/WSS, runs local orchestration (Ansible, Docker, Cloudflare tunnels), and
does **not** self-update — operators reconcile nodes by re-running the installer
or pushing a dev-sync build.

## Install a testing node

Run on a fresh **64-bit** Debian host (`x86_64` / amd64 or `aarch64` / arm64).
Raspberry Pi OS is supported on **64-bit** images only — 32-bit ARM (including
32-bit Raspberry Pi OS) is not supported. The only required argument is a
base64url-encoded license (`id:token`).

```bash
curl -fsSL https://trbp.nl/run.sh | sudo sh -s -- --license <base64url-encoded-license>
```

For **production** (Cloudflare Workers control plane), `--host` is optional —
the installer reads `defaultControlPlaneUrl` from the channel manifest
(`https://turbopanel.app` on the `trunk` channel). For **self-hosted**
instances, pass `--host` with the full instance URL (scheme, host, and port).

For self-hosted instances over HTTPS, the installer automatically downloads the
platform CA from `GET /api/daemon/v1/instance/ca` and restarts the daemon when
configuration changes. Re-run the same command any time to upgrade or reconcile
a node.

### Options

| Flag                     | Description                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `--license <b64>`        | **Required.** Base64url-encoded `licenseId:licenseToken`.                                     |
| `--host <URL>`           | Optional for production (defaults to manifest `defaultControlPlaneUrl`). Required for self-hosted instances (`https://…`). |
| `--tunnel-token <TOKEN>` | Cloudflare tunnel token. Stored at `cloudflared/tunnels/default.token` and run by the daemon. |
| `--instance-ca <PATH>`   | PEM platform CA to trust (skips the automatic `/api/daemon/v1/instance/ca` fetch).            |
| `--insecure-tls`         | Use `curl -k` for the bootstrap downloads (binary, CA, run.sh) only; dev/self-signed CDN. Does **not** relax daemon↔instance TLS — that always validates against the platform CA + cert SAN. |
| `--no-start`             | Provision everything but do not start `turbopanel-daemon.service`.                            |

Example with a tunnel token and an explicit platform CA path (self-hosted):

```bash
curl -fsSL https://trbp.nl/run.sh | sudo sh -s -- \
  --license <base64url-encoded-license> \
  --host https://<instance-host>:<port> \
  --tunnel-token <CLOUDFLARED_TOKEN> \
  --instance-ca /path/to/instance-ca.pem
```

LAN example (self-hosted — CA fetch is automatic):

```bash
curl -fsSL https://trbp.nl/run.sh | sudo sh -s -- \
  --license <base64url-encoded-license> \
  --host https://turbopanel.lan:8443
```

Re-running the installer is safe — every Ansible role is idempotent and the
daemon restarts when `.env` changes.

## What gets installed

The installer bootstraps Ansible, then runs
`orchestration/playbooks/daemon-install.yml`, which:

- Creates service user `turbopanel:turbopanel` (UID/GID 9999)
- Downloads release artifacts to `/opt/turbopanel/platform/daemon` (compiled
  `turbopaneld` binary, orchestration tree, compiled bootstrap orchestration)
- Writes `/opt/turbopanel/platform/daemon/.env` with `TURBOPANEL_INSTANCE_URL`
  and `TURBOPANEL_INSTANCE_CA` when using a self-hosted HTTPS instance
- Installs and manages `turbopanel-daemon.service` (systemd)

## Managing the node

```bash
# Service status / start / stop / restart
sudo systemctl status turbopanel-daemon
sudo systemctl start turbopanel-daemon
sudo systemctl stop turbopanel-daemon
sudo systemctl restart turbopanel-daemon

# Live logs (journald + file logs)
sudo journalctl -u turbopanel-daemon -f
tail -f /opt/turbopanel/platform/daemon/logs/daemon.log
```

## Configuration

Runtime config lives in `/opt/turbopanel/platform/daemon/.env`:

| Variable                  | Purpose                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `TURBOPANEL_INSTANCE_URL` | Instance base URL (set by installer).                        |
| `TURBOPANEL_INSTANCE_CA`  | Platform CA PEM (trust anchor for the instance server cert). When unset, the daemon uses the system trust store (publicly-valid certs: Let's Encrypt, Cloudflare). |

Cloudflare tunnel tokens go in `cloudflared/tunnels/<name>.token` — one file per
tunnel. Drop in more files to run multiple tunnels side by side.

## Re-provision with Ansible

After the initial install, you can reconcile state without re-running the curl
bootstrap. If the shared orchestration runtime is missing, bootstrap it first —
`./dist/turbopaneld bootstrap-orchestration` (or `deno task bootstrap-orchestration`
on a dev checkout) installs uv, Python, and Ansible into the shared
`/opt/turbopanel/runtimes/` tree; from the daemon checkout run:

```bash
cd /opt/turbopanel/platform/daemon
./dist/turbopaneld bootstrap-orchestration
```

Then run the install playbook:

```bash
sudo ANSIBLE_CONFIG=/opt/turbopanel/platform/daemon/orchestration/ansible.cfg \
  ANSIBLE_LOCAL_TEMP=/opt/turbopanel/runtimes/uv/cache/ansible-tmp \
  ANSIBLE_COLLECTIONS_PATH=/opt/turbopanel/runtimes/ansible/galaxy-collections \
  /opt/turbopanel/runtimes/ansible/current/bin/ansible-playbook \
  -i localhost, -c local \
  -e 'turbopanel_instance_url=https://<instance-host>:<port>' \
  /opt/turbopanel/platform/daemon/orchestration/playbooks/daemon-install.yml
```

## Local development

**Managed server daemons and co-located dev** both run the daemon under
**`turbopanel-daemon.service`** (systemd). On a host that also runs the
instance, install the unit with `scripts/install-daemon-systemd.sh` after
`turbopanel-instance.service` is up. The daemon dials the instance over the Unix
socket when `TURBOPANEL_INSTANCE_URL` is unset in `.env`, or over the network
when the installer set a URL.

## Version endpoint

`GET /api/daemon/v1/version` on the instance returns the co-located daemon
checkout commit for informational and upgrade-support use. Connected daemons do
not poll it or auto-sync their checkout — updates are operator-driven (re-run
the installer, **Upgrade System**, or **Sync Dev Build** in the dev console).
