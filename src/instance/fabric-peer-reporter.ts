/**
 * Push this host's live TurboFabric peer readings to the control plane.
 *
 * The 60 s `tp0` refresh (`commands/fabric-peer-refresh.ts`, reached through
 * the `subscribeFabricPeers` command port so this file never imports
 * `src/commands/`) hands every reading here. One `fabric-peers-report` frame
 * goes out when a peer's health class changed since the last frame sent on
 * this connection, or when {@link FABRIC_PEER_REPORT_MAX_QUIET_MS} passed
 * without one. Steady tunnels therefore cost one control-plane wake every
 * five minutes, not every minute. The first reading after a (re)connect is
 * always sent.
 *
 * Fire-and-forget and read-only. Sent only to a control plane advertising
 * `fabric-peer-report-v1`; an older one keeps today's behaviour (readings only
 * on reconcile).
 */

import type { DaemonMessage } from "../contracts/cell-messages.ts";
import type { FabricReconcileObservedPeer } from "../contracts/commands-contracts.ts";

/** Longest gap between two frames while nothing changes. */
export const FABRIC_PEER_REPORT_MAX_QUIET_MS = 5 * 60_000;
/** The control plane accepts at most this many peers per frame. */
export const FABRIC_PEER_REPORT_MAX_PEERS = 256;

/** One refreshed reading (twin of `FabricPeerReading` in `commands/`). */
export type FabricPeerReportReading = {
  peers: FabricReconcileObservedPeer[];
  observedAt: string;
};

export type FabricPeerSubscribe = (
  listener: (reading: FabricPeerReportReading) => void,
) => () => void;

export type FabricPeerReporterOptions = {
  /** Send one frame; false when the socket is not open. */
  send: (message: DaemonMessage) => boolean;
  /** True while the control plane advertises `fabric-peer-report-v1`. */
  peerSupportsReport: () => boolean;
  /** Registers for refreshed readings; undefined when no fabric port is wired. */
  subscribe: () => FabricPeerSubscribe | undefined;
  nowMs?: () => number;
};

/** Health class per peer, order-independent: what "changed" means. */
export function fabricPeerHealthSignature(
  peers: readonly FabricReconcileObservedPeer[],
): string {
  return peers
    .map((peer) => `${peer.publicKey}=${peer.health ?? "unknown"}`)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
}

export class FabricPeerReporter {
  readonly #send: (message: DaemonMessage) => boolean;
  readonly #peerSupportsReport: () => boolean;
  readonly #subscribe: () => FabricPeerSubscribe | undefined;
  readonly #nowMs: () => number;
  #unsubscribe: (() => void) | undefined;
  #lastSignature: string | undefined;
  #lastSentMs: number | undefined;

  constructor(options: FabricPeerReporterOptions) {
    this.#send = options.send;
    this.#peerSupportsReport = options.peerSupportsReport;
    this.#subscribe = options.subscribe;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  attach(): void {
    this.detach();
    const subscribe = this.#subscribe();
    if (!subscribe) return;
    this.#unsubscribe = subscribe((reading) => this.report(reading));
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    // A new connection starts with a fresh frame.
    this.#lastSignature = undefined;
    this.#lastSentMs = undefined;
  }

  /** Send `reading` when supported and changed or quiet for too long. */
  report(reading: FabricPeerReportReading): boolean {
    if (!this.#peerSupportsReport()) return false;
    const peers = reading.peers.slice(0, FABRIC_PEER_REPORT_MAX_PEERS);
    const signature = fabricPeerHealthSignature(peers);
    const nowMs = this.#nowMs();
    if (!this.#isDue(signature, nowMs)) return false;
    const sent = this.#send({
      type: "fabric-peers-report",
      peers,
      observedAt: reading.observedAt,
      at: new Date(nowMs).toISOString(),
    });
    if (!sent) return false;
    this.#lastSignature = signature;
    this.#lastSentMs = nowMs;
    return true;
  }

  #isDue(signature: string, nowMs: number): boolean {
    if (this.#lastSentMs === undefined) return true;
    if (signature !== this.#lastSignature) return true;
    return nowMs - this.#lastSentMs >= FABRIC_PEER_REPORT_MAX_QUIET_MS;
  }
}
