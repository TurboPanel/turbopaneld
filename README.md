# turbopanel-daemon

Remote daemon for TurboPanel-managed servers. Connects back to an instance over HTTPS/WSS, runs local orchestration (Ansible, Docker, Cloudflare tunnels), and does **not** self-update — operators reconcile nodes by re-running the installer or pushing a dev-sync build.

## Install a testing node

Run on a fresh Debian or Raspbian host (arm64 or amd64). The only required argument is the full URL of the instance you want this node to connect to — scheme, host, and port, with no defaults baked in.

`install.sh` was removed from this repo. Use the **official CDN-hosted installer** published from [turbopanel/turbopanel-cdn](https://github.com/turbopanel/turbopanel-cdn):

```bash
curl -fsSL https://raw.githubusercontent.com/turbopanel/turbopanel-cdn/trunk/install.sh \
  | sudo bash -s -- \
      --instance-url https://<instance-host>:<port>
```

Replace `<instance-host>` and `<port>` with wherever your instance is reachable from this node (LAN hostname, public hostname, tunnel endpoint, etc.).

For self-hosted instances over HTTPS, the installer automatically downloads the platform CA from `GET /api/daemon/v1/instance/ca` (one `curl -k` bootstrap) and restarts the daemon when configuration changes. Re-run the same command any time to upgrade or reconcile a node.

### Options

| Flag | Description |
|------|-------------|
| `--instance-url <URL>` | **Required.** Base URL of the instance (`https://…` or `http://…`). |
| `--tunnel-token <TOKEN>` | Cloudflare tunnel token. Stored at `cloudflared/tunnels/default.token` and run by the daemon. |
| `--instance-ca <PATH>` | PEM platform CA to trust (skips the automatic `/api/daemon/v1/instance/ca` fetch). |
| `--insecure-tls` | Skip TLS verification when dialing the instance (dev only). |
| `--branch <NAME>` | Git branch to track (default: `trunk`). |
| `--repo-url <URL>` | Override the daemon git remote. |
| `--no-start` | Provision everything but do not start `turbopanel-daemon.service`. |

Example with a tunnel token and an explicit platform CA path:

```bash
curl -fsSL https://raw.githubusercontent.com/turbopanel/turbopanel-cdn/trunk/install.sh \
  | sudo bash -s -- \
      --instance-url https://<instance-host>:<port> \
      --tunnel-token <CLOUDFLARED_TOKEN> \
      --instance-ca /path/to/instance-ca.pem
```

LAN example (same command — CA fetch is automatic):

```bash
curl -fsSL https://raw.githubusercontent.com/turbopanel/turbopanel-cdn/trunk/install.sh \
  | sudo bash -s -- \
      --instance-url https://turbopanel.lan:8443
```

Re-running the installer is safe — every Ansible role is idempotent and the daemon restarts when `.env` changes.

## What gets installed

The installer bootstraps Ansible, then runs `orchestration/playbooks/daemon-install.yml`, which:

- Creates service user `turbopanel:turbopanel` (UID/GID 9999)
- Clones this repo to `/opt/turbopanel/platform/daemon` on branch `trunk`
- Installs Deno to `/usr/local/bin/deno`
- Writes `/opt/turbopanel/platform/daemon/.env` with `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_INSTANCE_CA` when using a self-hosted HTTPS instance
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

| Variable | Purpose |
|----------|---------|
| `TURBOPANEL_INSTANCE_URL` | Instance base URL (set by installer). |
| `TURBOPANEL_INSTANCE_CA` | Platform CA PEM (trust anchor for the instance server cert). |
| `TURBOPANEL_TLS_INSECURE` | Set to `1` to skip TLS verification. |

Cloudflare tunnel tokens go in `cloudflared/tunnels/<name>.token` — one file per tunnel. Drop in more files to run multiple tunnels side by side.

## Re-provision with Ansible

After the initial install, you can reconcile state without re-running the curl bootstrap. If the shared orchestration runtime is missing, bootstrap it first — `scripts/bootstrap-orchestration.ts` installs uv, Python, and Ansible into the shared `/opt/turbopanel/runtimes/` tree (replaces the former `bootstrap-orchestration.sh`); from the daemon checkout run:

```bash
cd /opt/turbopanel/platform/daemon
/usr/local/bin/deno task bootstrap-orchestration
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

**Managed server daemons and co-located dev** both run the daemon under **`turbopanel-daemon.service`** (systemd). On a host that also runs the instance, install the unit with `scripts/install-daemon-systemd.sh` after `turbopanel-instance.service` is up. The daemon dials the instance over the Unix socket when `TURBOPANEL_INSTANCE_URL` is unset in `.env`, or over the network when the installer set a URL.

## Version endpoint

`GET /api/daemon/v1/version` on the instance returns the co-located daemon checkout commit for informational and upgrade-support use. Connected daemons do not poll it or auto-sync their checkout — updates are operator-driven (re-run the installer, **Upgrade System**, or **Sync Dev Build** in the dev console).
