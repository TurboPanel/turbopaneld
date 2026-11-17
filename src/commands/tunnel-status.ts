/**
 * `server.tunnel.status`: what every tunnel connector on this host is doing and
 * which connector version it runs, plus the version this daemon moves them to.
 * Read-only; the control plane polls it to show versions per server.
 */
import type { TunnelStatusResult } from "../contracts/commands-contracts.ts";
import { join } from "@std/path";
import { readTunnelState } from "../deploy/tunnel-state.ts";
import {
  type ConnectorIo,
  defaultConnectorIo,
  reportConnectors,
} from "../tunnels/connector-service.ts";

export type TunnelStatusDeps = {
  io?: ConnectorIo;
};

export async function handleTunnelStatus(
  _daemonReceivedAt: string,
  deps: TunnelStatusDeps = {},
): Promise<TunnelStatusResult> {
  const io = deps.io ?? defaultConnectorIo();
  const status = await reportConnectors(io);
  // What the hop between servers does about client certificates, from the
  // table in force. Read here, not sent back with the table, so a downgrade
  // never makes the control plane send the table again.
  const state = await readTunnelState(join(io.layout.configDir, "hosting"))
    .catch(() => undefined);
  if (!state?.clientAuth) return status;
  return {
    ...status,
    peerClientAuth: state.clientAuth,
    ...(state.clientAuthDowngraded ? { peerClientAuthDowngraded: true } : {}),
  };
}
