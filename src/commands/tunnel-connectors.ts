/**
 * `server.tunnel.connectors`: start or stop the connectors of organization
 * tunnels on this host, as the control plane's list says. A connector that
 * already runs is left as it is (a resend must not bounce it); one the list
 * removes is stopped and its token copy deleted. Only the ids named here are
 * touched, never the instance's own tunnel.
 */
import type {
  TunnelConnectorsPayload,
  TunnelConnectorsResult,
} from "../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "../deploy/materialize-tls.ts";
import {
  type ConnectorIo,
  defaultConnectorIo,
  installConnector,
  listConnectorIds,
  removeConnector,
} from "../tunnels/connector-service.ts";

export type TunnelConnectorsDeps = {
  decryptSecrets?: DecryptSecretsFn;
  io?: ConnectorIo;
};

/** A plain reason for the report: never the token, never an envelope. */
function reasonOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "failed";
}

export async function handleTunnelConnectors(
  payload: TunnelConnectorsPayload,
  _daemonReceivedAt: string,
  deps: TunnelConnectorsDeps = {},
): Promise<TunnelConnectorsResult> {
  const io = deps.io ?? defaultConnectorIo();
  const present = new Set(await listConnectorIds(io));
  const unchanged = payload.install.filter((e) => present.has(e.tunnelId));
  const wanted = payload.install.filter((e) => !present.has(e.tunnelId));
  if (wanted.length > 0 && !deps.decryptSecrets) {
    throw new Error(
      "tunnel connectors need the secret decryptor to unseal tokens",
    );
  }
  const tokens = wanted.length > 0
    ? await deps.decryptSecrets!(wanted.map((e) => e.tokenEnvelope))
    : [];
  const result: TunnelConnectorsResult = {
    installed: [],
    unchanged: unchanged.map((e) => e.tunnelId),
    removed: [],
  };
  const failures: string[] = [];
  for (const [index, entry] of wanted.entries()) {
    const token = tokens[index];
    if (typeof token !== "string" || token.length === 0) {
      failures.push(`${entry.tunnelId}: could not unseal the run token`);
      continue;
    }
    try {
      await installConnector(io, entry.tunnelId, token);
      result.installed.push(entry.tunnelId);
    } catch (err) {
      failures.push(`${entry.tunnelId}: ${reasonOf(err)}`);
    }
  }
  for (const id of payload.remove) {
    try {
      await removeConnector(io, id);
      result.removed.push(id);
    } catch (err) {
      failures.push(`${id}: ${reasonOf(err)}`);
    }
  }
  // Report a partial failure as a failed command so the control plane repeats
  // the list; what did work is not redone (installs of running ones are no-ops).
  if (failures.length > 0) {
    throw new Error(`tunnel connectors: ${failures.join("; ")}`);
  }
  return result;
}
