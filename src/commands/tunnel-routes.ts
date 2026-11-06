/**
 * `server.tunnel.routes`: make this host forward tunnel traffic for sites that
 * run on other servers of the datacenter, as the control plane's whole table
 * says (see `../deploy/tunnel-caddy.ts` for the text it writes). An empty table
 * removes the forwarding file and the peer certificate material.
 */
import type {
  TunnelRoutesPayload,
  TunnelRoutesResult,
} from "../contracts/commands-contracts.ts";
import {
  applyTunnelRoutes,
  type ApplyTunnelRoutesDeps,
} from "../deploy/tunnel-apply.ts";
import type { DecryptSecretsFn } from "../deploy/materialize-tls.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";

export type TunnelRoutesDeps = {
  decryptSecrets?: DecryptSecretsFn;
  resolveLayout?: () => LayoutPaths;
  grantRead?: ApplyTunnelRoutesDeps["grantRead"];
};

export function handleTunnelRoutes(
  payload: TunnelRoutesPayload,
  _daemonReceivedAt: string,
  deps: TunnelRoutesDeps = {},
): Promise<TunnelRoutesResult> {
  const decryptSecrets = deps.decryptSecrets;
  if (!decryptSecrets && payload.peerMaterial) {
    return Promise.reject(
      new Error("tunnel routes need the secret decryptor to unseal the key"),
    );
  }
  return applyTunnelRoutes((deps.resolveLayout ?? resolveLayout)(), payload, {
    decryptSecrets: decryptSecrets ?? (() => Promise.resolve([])),
    ...(deps.grantRead ? { grantRead: deps.grantRead } : {}),
  });
}
