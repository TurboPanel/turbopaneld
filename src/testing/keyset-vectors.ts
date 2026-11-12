/**
 * The shared key-set vectors (`keyset-statement-vectors.json`, byte-identical
 * to the control plane's copy) with their approvals turned into envelopes as
 * the control plane serves them. The file stores each approval as
 * `[id, authenticatorData, clientDataJSON, assertion]`.
 */
import raw from "./keyset-statement-vectors.json" with { type: "json" };

export type VectorPasskey = { id: string; alg: string; pub: string };
export type VectorPin = {
  current: string;
  keyset: number;
  rpId: string;
  passkeys: VectorPasskey[];
};
export type VectorApproval = {
  id: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
};
export type VectorKeySig = { pub: string; sig: string };
export type VectorEnvelope = {
  statement: string;
  approvals: VectorApproval[];
  /** The replaced key's signature; absent on a revoke. */
  keySig?: VectorKeySig;
};

function envelope(
  value: {
    statement: string;
    approvals: string[][];
    keySig?: VectorKeySig;
  },
): VectorEnvelope {
  return {
    statement: value.statement,
    approvals: value.approvals.map((
      [id, authenticatorData, clientDataJSON, signature],
    ) => ({
      id: id ?? "",
      authenticatorData: authenticatorData ?? "",
      clientDataJSON: clientDataJSON ?? "",
      signature: signature ?? "",
    })),
    ...(value.keySig ? { keySig: value.keySig } : {}),
  };
}

export const keysetVectors = {
  now: raw.now,
  pin: raw.pin as VectorPin,
  pinAfterChain: raw.pinAfterChain as VectorPin,
  /** The canonical passkeys line and its hash, for a set given out of order. */
  passkeysLine: raw.passkeysLine as {
    passkeys: VectorPasskey[];
    line: string;
    hash: string;
  },
  chain: raw.chain.map(envelope),
  refused: raw.refused.map((entry) => ({
    name: entry.name,
    pin: entry.pin as VectorPin,
    envelope: envelope(entry.envelope),
  })),
};
