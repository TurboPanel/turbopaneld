/**
 * `server.tunnel.connectors`: start or stop the connectors of organization
 * tunnels on this host, as the control plane's list says. A connector that
 * already runs on the same run token is left as it is (a resend must not
 * bounce it); one whose run token changed is restarted on the new one; one that is
 * installed but stopped or failed is started again, so a resend repairs it;
 * one the list removes is stopped and its token copy deleted. Only the ids
 * named here are touched, never the instance's own tunnel.
 */
import type {
  TunnelConnectorsPayload,
  TunnelConnectorsResult,
} from "../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "../deploy/materialize-tls.ts";
import {
  type ConnectorIo,
  connectorTokenChanged,
  defaultConnectorIo,
  installConnector,
  listConnectorIds,
  removeConnector,
  startStoppedConnector,
} from "../tunnels/connector-service.ts";
import { logInfo } from "../util/logger.ts";

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
  if (payload.install.length > 0 && !deps.decryptSecrets) {
    throw new Error(
      "tunnel connectors: this daemon cannot unseal run tokens here (no secret decryptor), so no connector was installed or checked for a new token",
    );
  }
  // Every token is unsealed (locally, never logged), so a connector already
  // here that runs on an older run token (the token was rotated) is moved to
  // the new one; one on the same token is left as it is.
  const tokens = payload.install.length > 0
    ? await deps.decryptSecrets!(payload.install.map((e) => e.tokenEnvelope))
    : [];
  const plan = await Promise.all(payload.install.map(async (entry, index) => {
    const token = tokens[index];
    const usable = typeof token === "string" && token.length > 0;
    const here = present.has(entry.tunnelId);
    const changed = here && usable &&
      await connectorTokenChanged(io, entry.tunnelId, token);
    return { entry, token: usable ? token : null, install: !here || changed };
  }));
  const wanted = plan.filter((p) => p.install);
  const unchanged = plan.filter((p) => !p.install).map((p) => p.entry);
  const installs = await Promise.allSettled(wanted.map(async (p) => {
    if (p.token === null) throw new Error("could not unseal the run token");
    await installConnector(io, p.entry.tunnelId, p.token);
    if (present.has(p.entry.tunnelId)) {
      logInfo(
        "tunnels",
        `moved the connector of tunnel ${p.entry.tunnelId} to its new run token`,
      );
    }
  }));
  // Installed but stopped or failed: start it again (a running one is left as it is).
  const repairs = await Promise.allSettled(
    unchanged.map((e) => startStoppedConnector(io, e.tunnelId)),
  );
  const repaired = settledIds(unchanged.map((e) => e.tunnelId), repairs);
  repairs.forEach((outcome, index) => {
    if (outcome.status === "fulfilled" && outcome.value) {
      logInfo(
        "tunnels",
        `started the stopped connector of tunnel ${unchanged[index]!.tunnelId}`,
      );
    }
  });
  // Both lists go through the connector module's own queue, one at a time.
  const removals = await Promise.allSettled(
    payload.remove.map((id) => removeConnector(io, id)),
  );
  const installed = settledIds(wanted.map((p) => p.entry.tunnelId), installs);
  const removed = settledIds(payload.remove, removals);
  // Report a partial failure as a failed command so the control plane repeats
  // the list; what did work is not redone (installs of running ones are no-ops).
  const failures = [
    ...installed.failures,
    ...repaired.failures,
    ...removed.failures,
  ];
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
