/**
 * Policy for the `AllowedIPs` a fabric reconcile may install on `tp0`.
 *
 * Every AllowedIPs entry becomes a kernel route and a forwarding accept, so a
 * default route (or any range that is not private) sent by mistake would take
 * over this host's traffic. The control plane applies the same rules before it
 * builds a payload (`turbopanel` `advertised-ranges.ts`); the daemon repeats
 * them so a bad payload is refused here even if the control plane is wrong.
 */
import {
  cidrLiteralContains,
  parseCidrLiteral,
} from "../contracts/commands-contracts.ts";

const MIN_PREFIX_V4 = 8;
const MIN_PREFIX_V6 = 48;

/**
 * Private blocks a peer may route: RFC 1918, RFC 6598, RFC 4193. Built from
 * parts so no address literal sits in the source.
 */
const PRIVATE_BLOCKS: readonly string[] = [
  [[10, 0, 0, 0], 8],
  [[172, 16, 0, 0], 12],
  [[192, 168, 0, 0], 16],
  [[100, 64, 0, 0], 10],
].map(([octets, bits]) => `${(octets as number[]).join(".")}/${bits}`)
  .concat(["fc00", "7"].join("::/"));

type PolicyPayload = {
  address: string;
  prefix: string;
  peers: readonly { allowedIPs: readonly string[] }[];
};

function rangesOverlap(a: string, b: string): boolean {
  return cidrLiteralContains(a, b) || cidrLiteralContains(b, a);
}

/** Why one range is unacceptable on its own, or `null`. */
function rangeProblem(cidr: string): string | null {
  const parsed = parseCidrLiteral(cidr);
  if (!parsed) return `${cidr} is not a valid range`;
  const min = parsed.version === 4 ? MIN_PREFIX_V4 : MIN_PREFIX_V6;
  if (parsed.prefix < min) {
    return `${cidr} is a default route or too broad a range`;
  }
  if (!PRIVATE_BLOCKS.some((block) => cidrLiteralContains(block, cidr))) {
    return `${cidr} is not a private range`;
  }
  return null;
}

function claimsOwnAddress(cidr: string, payload: PolicyPayload): boolean {
  const own = [payload.address, payload.prefix].map((value) =>
    value.includes("/") ? value : `${value}/32`
  );
  return own.some((range) => rangesOverlap(cidr, range));
}

/** First range that overlaps, but is not equal to, a range of an earlier peer. */
function overlapsOtherPeer(
  cidr: string,
  index: number,
  payload: PolicyPayload,
): string | null {
  for (let other = 0; other < index; other += 1) {
    for (const range of payload.peers[other]?.allowedIPs ?? []) {
      const same = cidrLiteralContains(cidr, range) &&
        cidrLiteralContains(range, cidr);
      if (!same && rangesOverlap(cidr, range)) return range;
    }
  }
  return null;
}

/**
 * `null` when every peer's AllowedIPs pass, otherwise a plain message naming
 * the first offending range. Two peers may advertise the very same range
 * (redundant gateways); partial overlap between peers is refused.
 */
export function fabricAllowedIpsPolicyError(
  payload: PolicyPayload,
): string | null {
  for (const [index, peer] of payload.peers.entries()) {
    for (const cidr of peer.allowedIPs) {
      const problem = rangeProblem(cidr);
      if (problem) return `TurboFabric refused a peer route: ${problem}`;
      if (claimsOwnAddress(cidr, payload)) {
        return `TurboFabric refused a peer route: ${cidr} overlaps this server's own fabric range`;
      }
      const clash = overlapsOtherPeer(cidr, index, payload);
      if (clash) {
        return `TurboFabric refused a peer route: ${cidr} overlaps another peer's range ${clash}`;
      }
    }
  }
  return null;
}
