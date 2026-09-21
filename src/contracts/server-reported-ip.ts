/**
 * Daemon-reported host interface address — the wire shape hello, heartbeat,
 * and `addresses-result` share with the control plane
 * (`turbopanel/src/contracts/server-addresses.ts`).
 *
 * Collection lives in `src/host/server-addresses.ts` (after the phase-5
 * rename; today `src/host/server-addresses.ts`). Keep field names and optionality
 * aligned: a drift here would let the control plane mis-pick a multi-homed
 * host's preferred address.
 */

export type ServerReportedIpScope = "private" | "public";

export type ServerReportedIp = {
  address: string;
  version: 4 | 6;
  scope: ServerReportedIpScope;
  /** Interface CIDR when known (host form `address/prefix` is fine). */
  cidr?: string;
  /** Host interface name (e.g. `eth0`, `enp1s0`). */
  interface?: string;
  /**
   * Set when this address sits on the interface carrying the host's default
   * route for its family — the NIC that actually faces the control plane.
   *
   * Multi-homed hosts report several usable addresses and the control plane
   * has to pick one to show. Sorted-first is arbitrary and frequently picks a
   * management or storage NIC; the default-route interface is the address a
   * peer would reach this host on.
   */
  preferred?: boolean;
};
