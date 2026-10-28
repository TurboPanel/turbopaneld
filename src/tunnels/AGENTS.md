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
- The unit carries extra limits (`UMask`, `RestrictAddressFamilies` with netlink
  because the Go program lists interfaces that way, `PrivateDevices`,
  `ProtectKernelLogs`, `ProtectClock`, `ProtectHostname`,
  `SystemCallArchitectures`). They are unproven against the real connector under
  systemd: after the update, a canary check must confirm the unit reaches
  `/ready` 200 on its metrics port; if not, drop one restriction at a time (in
  `renderTunnelUnit` and `tp_tunnel_unit_text` together) until it does.
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

## Installing and removing connectors (`server.tunnel.connectors`)

The control plane tells each carrying server which organization tunnels to run
(feature `tunnel-connector-v1`, `src/commands/tunnel-connectors.ts`). Each entry
is the provider's tunnel id plus the run token as a `tpdaemon.` envelope; the
handler unseals only the tokens of tunnels that have no connector yet, then
calls `installConnector`. A connector that already runs is left as it is, so a
resend never restarts it. `remove` entries call `removeConnector`. Only the ids
named in the command are touched, and the contract refuses `instance` and
`default`, so the instance's own tunnel and legacy token files are never
reached from here. One tunnel failing does not stop the others; the command
then fails with the tunnel ids and plain reasons (never a token or an
envelope) and the control plane sends the list again.

## Connector updates (blue/green)

- The daemon pins one connector version (`CLOUDFLARED_VERSION`, with checksums in
  `assets.ts`) and the permission list names that exact file, so a newer
  connector reaches servers only with a daemon release. After a daemon update,
  `startTunnels` migrates legacy token files and then runs
  `runConnectorUpdates`: every tunnel whose recorded version differs from the pin
  is moved by `updateConnector`, one tunnel at a time.
- A tunnel has two possible units: slot `a` (`turbopanel-tunnel-<id>.service`,
  the name every earlier install used) and slot `b`
  (`turbopanel-tunnel-<id>-b.service`). The record's `slot` names the one that
  carries the tunnel; the other exists only while a switch runs. An id never
  ends in `-b`, so `tp-host` reads the suffix unambiguously (`tp_tunnel_unit_ok`
  accepts `-b` only after a valid id; `slotSuffix` and the unit text's
  `SyslogIdentifier` must stay in step with `tp_tunnel_unit_text`).
- The switch: download the pinned version into its own folder (checksum
  verified, `ensureCloudflared`), install the other slot's unit on a new metrics
  port with the same root-only token copy (the daemon never touches the token),
  start it, poll its own `/ready` (default 90 s, every 2 s). Connected: write the
  record (new slot, port, version), then stop and remove the old unit. Not
  connected, or any step failing: remove the new unit and leave the old one
  untouched (`rolled-back`). Both units are replicas of the same tunnel, so
  Cloudflare sends traffic to either during the overlap.
- Safety checks before the old unit may stop: the new unit's metrics port must be
  bindable on loopback when chosen (so a local user listening on the next port
  cannot be mistaken for the connector), `/ready` must show at least one edge
  connection, and `systemctl is-active` of the new unit must say `active`. A
  rolled-back attempt is kept in the record (`lastUpdate`: outcome, time, reason
  of at most 300 characters) and reported.
- Updates run at daemon start and again every hour (`startUpdateLoop`, never two
  rounds at once), so a missed window or an offline download heals on a later
  round; the pause file is read at the start of each round.
- The status report reads records directly and is not held up by an update that
  is waiting for a connector.
- A crash between writing the record and stopping the old unit leaves a stray
  unit of the non-recorded slot; the next `updateConnector` removes it first.
  `removeConnector` drops both slots.
- A token change on a running tunnel restarts the unit in the slot that carries
  it, in place (a restart, not a switch).
- An admin pauses updates on a server by creating `updates.paused` in the
  tunnels folder (`CONNECTOR_UPDATES_PAUSED_FILE`); removing it resumes. There is
  no wire command for pause or "update now" yet.
- `server.tunnel.status` (feature `tunnel-status-v1`) is read-only: it answers
  `{ pinnedVersion, connectors: [{ tunnelId, status, version, slot, lastUpdate? }] }`. The
  control plane polls it to show the version per server and an update-pending
  notice (running version differs from the pinned one).
- Not proven on a real host yet: the overlap on one tunnel across two metrics
  ports, the 90 s window against a real edge connection time, and the traversal
  of the new version folder by the throwaway account.
