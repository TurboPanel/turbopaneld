# Tunnel connectors (`src/tunnels/`) — AGENTS.md

Each Cloudflare tunnel connector runs as its own systemd service,
`turbopanel-tunnel-<id>.service`, never as a child of the daemon: systemd stops
the daemon's process group on every daemon restart, so a child connector would
drop with every update. `<id>` is the provider's tunnel id (lower-case UUID) or
one of the two legacy names `instance` and `default`; `isTunnelId` and
`tp_tunnel_id_ok` apply the same rule, and every operation refuses anything else.

- `connector-unit.ts` is pure (ids, names, unit text, token line, status map);
  `connector-service.ts` does the work through `tp-host` (install/remove, start,
  stop, restart, enable, disable, status, list), one operation at a time.
- The unit is one file per tunnel (not an `@` template) so each has its own
  metrics port and, during a connector update, its own pinned version. It runs
  `<vendor>/cloudflared/<version>/cloudflared tunnel run --no-autoupdate
  --metrics 127.0.0.1:<port>` under `DynamicUser=yes`: a throwaway account that
  is neither the daemon's user (it would reach daemon state and sockets) nor the
  hosting Caddy's (TLS keys), with no capability and no inbound port. Ports come
  from 20300-20899, chosen by the daemon and recorded in
  `<state>/cloudflared/tunnels/<id>.json` (no secret; the record also answers
  "which tunnels exist").
- The run token is never on a command line. The daemon stages
  `<state>/cloudflared/tunnels/<id>.env` (`0600`), `tp-host tunnel-env-install
  <id>` checks it (one line, `TUNNEL_TOKEN='<base64>'`) and copies it to
  `<config>/tunnel-env/<id>.env` (`root:root 0600`, folder `root:root 0700`),
  and the unit names that copy. systemd reads it as root, so the connector
  account cannot. The staged file is deleted right after.
- `tp-host` installs a tunnel unit only if it equals `tp_tunnel_unit_text` after
  the id, version and port are read from its name and `ExecStart` line; change
  `renderTunnelUnit` and `tp_tunnel_unit_text` together (a test installs the
  daemon's text and refuses every one-line change). The port band is in both
  (`TUNNEL_METRICS_PORT_*`, `TP_TUNNEL_PORT_*`).
- Readiness is the connector's own `/ready` on its metrics address (200 with
  `readyConnections` when at least one edge connection is up, 503 otherwise);
  `/healthcheck` always answers OK and is never used.
- The connector account is not the daemon's user, so it must be able to walk to
  the binary. The `turbopanel-user` role makes `<vendor>/cloudflared` `0751`;
  the daemon (`makeVendorDirTraversable`) makes the version folder
  `<vendor>/cloudflared/<version>` `0751`; the binary is `0755`. `/opt/turbopanel`
  and `<vendor>` are not set by this code, so a canary check must confirm both
  are traversable by other users (`namei -m` on the binary path as a non-tp user)
  before calling the feature proven.
- Hosts that held a tunnel as `<id>.token` in the tunnels folder migrate on
  daemon start: the file becomes a service and is deleted once the service is
  enabled and (re)started (not once `/ready` passes; status shows that). If a
  service already exists for that id the stale file is dropped, never installed. Files not named for a tunnel id are left alone with a warning.
- Purge needs no tunnel-specific code: it stops and removes every `turbopanel*`
  unit and removes `/etc/turbopanel`, `/var/lib/turbopanel` and
  `/opt/turbopanel/vendor` whole; `scripts/purge.test.ts` pins that for tunnel
  units, token copies and the connector folder.
