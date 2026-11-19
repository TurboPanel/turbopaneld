/**
 * Answering DNS-01 checks by asking the control plane to publish the records
 * (feature `acme-issue-dns-v1`).
 *
 * This daemon never holds a DNS credential and never writes a TXT record. The
 * solver hands the order's records to a {@link DnsRelay}, which carries them to
 * the control plane (`acme-dns-publish`) and waits for the answer
 * (`acme-dns-published`: the records read back at every authoritative name
 * server). After the authority has checked them, or the order failed, the
 * solver tells the control plane once to take them away (`acme-dns-remove`).
 */
import type { AcmeDnsRecord } from "../../contracts/cell-messages.ts";
import type { ChallengeSolver, SolverChallenge } from "./order.ts";

/** Where the records of one order go; implemented over the cell link. */
export type DnsRelay = {
  /**
   * Ask the control plane to publish `records` for `requestId` and resolve once
   * it says they are readable everywhere. Rejects with a plain reason when it
   * says it could not, when the link is down, or when `signal` ends first.
   */
  publish(
    requestId: string,
    records: readonly AcmeDnsRecord[],
    signal: AbortSignal,
  ): Promise<void>;
  /** Tell the control plane the order is over; never throws. */
  remove(requestId: string): void;
};

/** The TXT record name for a name: a wildcard is checked at its base name. */
export function dnsChallengeRecordName(name: string): string {
  return `_acme-challenge.${name.replace(/^\*\./, "")}`;
}

/** The solver for one order: all its records go in one request. */
export function createDns01Solver(
  requestId: string,
  relay: DnsRelay,
): ChallengeSolver {
  let asked = false;
  let removed = false;
  const publishAll = (
    challenges: readonly SolverChallenge[],
    signal: AbortSignal,
  ): Promise<void> => {
    asked = true;
    return relay.publish(
      requestId,
      challenges.map(({ name, value }) => ({
        name: dnsChallengeRecordName(name),
        value,
      })),
      signal,
    );
  };
  return {
    type: "dns-01",
    present: (challenge) =>
      publishAll([challenge], AbortSignal.timeout(60_000)),
    presentAll: publishAll,
    // One removal per order, whatever the number of names; nothing to remove
    // when no record was ever requested.
    remove: () => {
      if (!asked || removed) return Promise.resolve();
      removed = true;
      relay.remove(requestId);
      return Promise.resolve();
    },
  };
}
