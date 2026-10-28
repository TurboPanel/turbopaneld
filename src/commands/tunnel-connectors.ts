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
  const installs = await Promise.allSettled(wanted.map(async (entry, index) => {
    const token = tokens[index];
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("could not unseal the run token");
    }
    await installConnector(io, entry.tunnelId, token);
  }));
  // Both lists go through the connector module's own queue, one at a time.
  const removals = await Promise.allSettled(
    payload.remove.map((id) => removeConnector(io, id)),
  );
  const installed = settledIds(wanted.map((e) => e.tunnelId), installs);
  const removed = settledIds(payload.remove, removals);
  // Report a partial failure as a failed command so the control plane repeats
  // the list; what did work is not redone (installs of running ones are no-ops).
  const failures = [...installed.failures, ...removed.failures];
  if (failures.length > 0) {
    throw new Error(`tunnel connectors: ${failures.join("; ")}`);
  }
  return {
    installed: installed.ok,
    unchanged: unchanged.map((e) => e.tunnelId),
    removed: removed.ok,
  };
}

/** Split settled results into the ids that worked and a plain line per failure. */
function settledIds(
  ids: readonly string[],
  settled: readonly PromiseSettledResult<unknown>[],
): { ok: string[]; failures: string[] } {
  const ok: string[] = [];
  const failures: string[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") ok.push(ids[index]);
    else failures.push(`${ids[index]}: ${reasonOf(outcome.reason)}`);
  });
  return { ok, failures };
}
