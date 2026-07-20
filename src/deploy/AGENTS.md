# Tenant deploy & hosting ingress — AGENTS.md

The `environment.deploy` / `environment.stop` command handlers: Docker Compose bring-up with Traefik labels, hosting-edge Caddy (`:80`/`:443`, distinct from control-plane Caddy), org TLS materialization from `tpdaemon` envelopes, and best-effort container reporting.

Root context: `../../AGENTS.md`. Instance-side command pipeline: `../../../instance/src/lib/commands/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Tenant Docker Compose deploy + hosting ingress

`environment.deploy` (command router →
`src/instance/commands/deploy-environment.ts`):

1. Ensure Docker engine (`ensureDocker` → `runDockerSetup` when the binary is
   missing or the Engine API is unreachable). Docker CLI calls fall back to
   `sudo -n -u <self> -- docker …` when the socket is permission-denied so the
   first deploy after group membership still works without a daemon restart
   (`sg docker` fails for `/usr/sbin/nologin` service accounts with "This
   account is currently not available").
2. Bootstrap Traefik on Docker network `turbopanel-ingress` (internal bind
   `127.0.0.1:8080` only — **no** public `:80`/`:443` on Traefik; **no**
   ACME/LE).
3. Ensure vendored hosting Caddy (`ensureHostingCaddy` — Ansible `caddy-setup`
   then direct GitHub download) when
   `/opt/turbopanel/vendor/caddy/current/caddy` is missing. On-demand like
   Docker; daemon-converge does not install it. Required for hostname ingress.
4. Write runtime compose under
   `<stateDir>/deployments/<environmentId>/docker-compose.yml` with Traefik
   labels (`src/deploy/compose-labels.ts`).
5. `docker compose -p <projectName> up -d --remove-orphans`.
6. When the payload includes `tlsMaterial[]`, materialize org certs under
   `layout.tlsDir` (`/etc/turbopanel/tls/<tlsId>/fullchain.pem` + `privkey.pem`,
   modes `0640`/`0600`) via `materializeTlsCertificates`
   (`src/deploy/materialize-tls.ts`). Private keys arrive as `tpdaemon`
   envelopes — decrypt only through `POST /api/daemon/v1/secrets/decrypt`
   (daemon JWT); never log plaintext.
7. Refresh hosting-edge Caddy config under `/etc/turbopanel/hosting/`
   (`auto_https off` always). Per-hostname site blocks use
   `tls <fullchain> <privkey>` when a resolved `tlsId` was materialized;
   otherwise `tls internal`. Unit `turbopanel-hosting-caddy.service` when sudo
   allows. **Distinct** from control-plane Caddy (`:8443`).
8. Best-effort `docker compose ps --format json` — per-container identity/status
   (`containerId`, `containerName`, `composeServiceName`, `status`, optional
   `serviceId` from `payload.hostings`) is included in the command result when
   collection succeeds; a `ps`/parse failure never fails an otherwise-successful
   deploy.

`environment.stop` (command router →
`src/instance/commands/stop-environment.ts`):

1. `docker compose -p <projectName> -f <stateDir>/deployments/<environmentId>/docker-compose.yml down --remove-orphans --volumes`
   when the compose file exists (idempotent no-op when missing).
2. Remove `/etc/turbopanel/hosting/sites/<environmentId>.caddy` via
   `removeHostingCaddySite` and best-effort reload hosting Caddy.
3. Delete the deployment directory.
4. Return authoritative `containers: []` so the instance clears Postgres
   container pins.

Helpers: `src/deploy/ensure-docker.ts`, `src/deploy/ingress.ts`,
`src/deploy/materialize-tls.ts`, `src/deploy/ensure-hosting-caddy.ts`. Future
seams (not MVP): multi-server service placement, WireGuard mesh, swarm-style
replicas, ACME issuance on the daemon.
