/**
 * TurboFabric mesh peer availability: diffs the daemon's already-tracked
 * `wg show tp0 dump` observation (`getLastObservedFabricPeers` —
 * `instance/commands/fabric.ts`, refreshed opportunistically by
 * instance-initiated reconcile/path-probe calls) tick-over-tick, re-running
 * `classifyPeerHandshakeHealth` against the current clock so a
 * `healthy` → `stale` transition surfaces purely from time passing, even with
 * no new dump. This never runs its own `wg` subprocess — an empty cache (no
 * reconcile/probe has happened yet this process) yields `[]`.
 *
 * Endpoint (the wg dump's `host:port`, this peer's current network path) is
 * tracked alongside health so a peer that migrates to a different
 * endpoint/path while remaining healthy still surfaces a `fabric_peer_change`
 * — health alone would miss that transition entirely.
 */
import {
  classifyPeerHandshakeHealth,
  getLastObservedFabricPeers,
} from "../../../instance/commands/fabric.ts";
import type {
  FabricPeerHealth,
  FabricReconcileObservedPeer,
} from "../../../instance/commands/contracts.ts";
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../contract.ts";

export type FabricStateReader = () => FabricReconcileObservedPeer[];

type ObservedPeerState = {
  health: FabricPeerHealth;
  endpoint: string | undefined;
};

function isUnavailableHealth(health: FabricPeerHealth): boolean {
  return health === "stale" || health === "never";
}

export class FabricStateEventCollector implements EventCollector {
  readonly #reader: FabricStateReader;
  readonly #previousState = new Map<string, ObservedPeerState>();

  constructor(deps?: { reader?: FabricStateReader }) {
    this.#reader = deps?.reader ?? getLastObservedFabricPeers;
  }

  detect(ctx: EventDetectContext): MetricEvent[] {
    const peers = this.#reader();
    const events: MetricEvent[] = [];
    const seen = new Set<string>();

    for (const peer of peers) {
      seen.add(peer.publicKey);
      const health = classifyPeerHandshakeHealth(
        peer.lastHandshakeAt,
        ctx.nowMs,
      );
      const prior = this.#previousState.get(peer.publicKey);
      if (prior !== undefined) {
        this.#pushTransitions(events, peer, prior, health, ctx.nowMs);
      }
      this.#previousState.set(peer.publicKey, {
        health,
        endpoint: peer.endpoint,
      });
    }

    this.#forgetUnseen(seen);
    return events;
  }

  #pushTransitions(
    events: MetricEvent[],
    peer: FabricReconcileObservedPeer,
    prior: ObservedPeerState,
    health: FabricPeerHealth,
    nowMs: number,
  ): void {
    const healthChanged = prior.health !== health;
    const endpointChanged = prior.endpoint !== peer.endpoint;

    if (healthChanged || endpointChanged) {
      events.push(
        makeEvent("fabric_peer_change", "info", nowMs, {
          entityId: peer.publicKey,
          payload: {
            healthFrom: prior.health,
            healthTo: health,
            endpointFrom: prior.endpoint ?? null,
            endpointTo: peer.endpoint ?? null,
          },
        }),
      );
    }

    if (!healthChanged) return;

    if (isUnavailableHealth(health)) {
      events.push(
        makeEvent("fabric_unavailable", "warning", nowMs, {
          entityId: peer.publicKey,
        }),
      );
      return;
    }

    if (health === "healthy" && isUnavailableHealth(prior.health)) {
      events.push(
        makeEvent("fabric_recovered", "info", nowMs, {
          entityId: peer.publicKey,
        }),
      );
    }
  }

  #forgetUnseen(seen: ReadonlySet<string>): void {
    for (const publicKey of this.#previousState.keys()) {
      if (!seen.has(publicKey)) this.#previousState.delete(publicKey);
    }
  }
}
