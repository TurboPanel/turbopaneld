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
export type VectorEnvelope = {
  statement: string;
  approvals: VectorApproval[];
};

function envelope(
  value: { statement: string; approvals: string[][] },
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
  };
}

export const keysetVectors = {
  now: raw.now,
  pin: raw.pin as VectorPin,
  pinAfterChain: raw.pinAfterChain as VectorPin,
  chain: raw.chain.map(envelope),
  refused: raw.refused.map((entry) => ({
    name: entry.name,
    pin: entry.pin as VectorPin,
    envelope: envelope(entry.envelope),
  })),
};
