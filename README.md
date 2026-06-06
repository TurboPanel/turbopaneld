# turbopanel-daemon

Agent node daemon for TurboPanel. Connects back to an instance over HTTPS/WSS, runs local orchestration (Ansible, Docker, Cloudflare tunnels), and keeps its checkout in sync with the instance's `trunk` commit.

## Install a testing node

Run on a fresh Debian or Raspbian host (arm64 or amd64). The only required argument is the full URL of the instance you want this node to connect to — scheme, host, and port, with no defaults baked in.

```bash
curl -fsSL https://raw.githubusercontent.com/turbopanel/turbopanel-daemon/trunk/install.sh \
  | sudo bash -s -- \
      --instance-url https://<instance-host>:<port>
```

Replace `<instance-host>` and `<port>` with wherever your instance is reachable from this node (LAN hostname, public hostname, tunnel endpoint, etc.).

For self-hosted instances over HTTPS, the installer automatically downloads the platform CA from `/api/instance/ca` (one `curl -k` bootstrap) and restarts the daemon when configuration changes. Re-run the same command any time to upgrade or reconcile a node.

### Options

| Flag | Description |
|------|-------------|
| `--instance-url <URL>` | **Required.** Base URL of the instance (`https://…` or `http://…`). |
| `--tunnel-token <TOKEN>` | Cloudflare tunnel token. Stored at `cloudflared/tunnels/default.token` and run by the daemon. |
| `--instance-ca <PATH>` | PEM platform CA to trust (skips the automatic `/api/instance/ca` fetch). |
| `--insecure-tls` | Skip TLS verification when dialing the instance (dev only). |
| `--branch <NAME>` | Git branch to track (default: `trunk`). |
| `--repo-url <URL>` | Override the daemon git remote. |
| `--no-start` | Provision everything but do not launch Tilt. |

Example with a tunnel token and an explicit platform CA path:

```bash
curl -fsSL https://raw.githubusercontent.com/turbopanel/turbopanel-daemon/trunk/install.sh \
  | sudo bash -s -- \
      --instance-url https://<instance-host>:<port> \
      --tunnel-token <CLOUDFLARED_TOKEN> \
      --instance-ca /path/to/instance-ca.pem
```

LAN example (same command — CA fetch is automatic):

```bash
curl -fsSL https://raw.githubusercontent.com/turbopanel/turbopanel-daemon/trunk/install.sh \
  | sudo bash -s -- \
      --instance-url https://turbopanel.lan:8443
```

Re-running the installer is safe — every Ansible role is idempotent and the daemon restarts when `.env` changes.

## What gets installed

The installer bootstraps Ansible, then runs `orchestration/playbooks/agent-install.yml`, which:

- Creates service user `turbopanel:turbopanel` (UID/GID 9999)
- Clones this repo to `/opt/turbopanel/platform/daemon` on branch `trunk`
- Installs Deno and Tilt under `/opt/turbopanel/runtimes/`
- Writes `/opt/turbopanel/platform/daemon/.env` with `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_INSTANCE_CA` when using a self-hosted HTTPS instance
- Starts the daemon via `tilt up` in a detached `screen` session

## Managing the node

```bash
# Attach to the running Tilt session (Ctrl-A D to detach)
sudo -u turbopanel screen -r turbopanel

# Stop the daemon
sudo -u turbopanel screen -S turbopanel -X quit

# Start manually (e.g. after --no-start)
sudo -u turbopanel bash -lc 'cd /opt/turbopanel/platform/daemon && tilt up --stream'
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

After the initial install, you can reconcile state without re-running the curl bootstrap:

```bash
sudo ANSIBLE_CONFIG=/opt/turbopanel/platform/daemon/orchestration/ansible.cfg \
  /opt/turbopanel/platform/daemon/orchestration/runtime/venv/bin/ansible-playbook \
  -i localhost, -c local \
  -e 'turbopanel_instance_url=https://<instance-host>:<port>' \
  /opt/turbopanel/platform/daemon/orchestration/playbooks/agent-install.yml
```

## Local development

On a host that also runs the instance (co-located dev), the daemon connects over the local Unix socket. See `tilt/daemon.tiltfile`, loaded from the instance repo's Tiltfile.

On a standalone agent node, `tilt up` uses `tilt/agent.tiltfile` and reads `.env` for `TURBOPANEL_INSTANCE_URL`.
