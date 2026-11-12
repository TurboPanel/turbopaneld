/**
 * TurboFabric mesh peer availability: diffs the daemon's already-tracked
 * `wg show tp0 dump` observation (`getLastObservedFabricPeers` —
 * `src/commands/fabric.ts`, refreshed every 60 s while `tp0` exists and on
 * every reconcile/path probe) tick-over-tick, re-running
 * `classifyPeerHandshakeHealth` against the current clock. This never runs
 * its own `wg` subprocess — an empty cache (no read yet this process) yields
 * `[]`. A reading older than `FABRIC_PEER_READING_MAX_AGE_MS` (the refresh
 * stopped, e.g. `tp0` went away) raises nothing and keeps the last state:
 * an old handshake time is not proof that a healthy tunnel went stale.
 *
 * Endpoint (the wg dump's `host:port`, this peer's current network path) is
 * tracked alongside health so a peer that migrates to a different
 * endpoint/path while remaining healthy still surfaces a `fabric_peer_change`
 * — health alone would miss that transition entirely.
 */
import {
  classifyPeerHandshakeHealth,
  getLastObservedFabricPeers,
  getLastObservedFabricPeersAtMs,
} from "../../../commands/fabric.ts";
import { FABRIC_PEER_READING_MAX_AGE_MS } from "../../../commands/fabric-peer-refresh.ts";
import type {
  FabricPeerHealth,
  FabricReconcileObservedPeer,
} from "../../../contracts/commands-contracts.ts";
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../../contracts/metrics-contract.ts";

export type FabricStateReader = () => FabricReconcileObservedPeer[];
/** When the reading was taken (epoch ms); null when unknown. */
export type FabricStateReadingAge = () => number | null;

type ObservedPeerState = {
  health: FabricPeerHealth;
  endpoint: string | undefined;
};

function isUnavailableHealth(health: FabricPeerHealth): boolean {
  return health === "stale" || health === "never";
}

export class FabricStateEventCollector implements EventCollector {
  readonly #reader: FabricStateReader;
  readonly #observedAtMs: FabricStateReadingAge;
  readonly #previousState = new Map<string, ObservedPeerState>();

  constructor(
    deps?: { reader?: FabricStateReader; observedAtMs?: FabricStateReadingAge },
  ) {
    this.#reader = deps?.reader ?? getLastObservedFabricPeers;
    // An injected reader without an age is always fresh.
    this.#observedAtMs = deps?.observedAtMs ??
      (deps?.reader ? () => null : getLastObservedFabricPeersAtMs);
  }

  #readingIsOld(nowMs: number): boolean {
    const observedAtMs = this.#observedAtMs();
    return observedAtMs !== null &&
      nowMs - observedAtMs > FABRIC_PEER_READING_MAX_AGE_MS;
  }

  detect(ctx: EventDetectContext): MetricEvent[] {
    if (this.#readingIsOld(ctx.nowMs)) return [];
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
