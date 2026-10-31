/**
 * `server.tunnel.status`: what every tunnel connector on this host is doing and
 * which connector version it runs, plus the version this daemon moves them to.
 * Read-only; the control plane polls it to show versions per server.
 */
import type { TunnelStatusResult } from "../contracts/commands-contracts.ts";
import {
  type ConnectorIo,
  defaultConnectorIo,
  reportConnectors,
} from "../tunnels/connector-service.ts";

export type TunnelStatusDeps = {
  io?: ConnectorIo;
};

export function handleTunnelStatus(
  _daemonReceivedAt: string,
  deps: TunnelStatusDeps = {},
): Promise<TunnelStatusResult> {
  return reportConnectors(deps.io ?? defaultConnectorIo());
}
