import type { HpkeEnvelope } from "../crypto/hpke.ts";

/**
 * The control plane's fixed HPKE test vector (`src/test-fixtures/hpke-vector.ts`
 * in the panel repo): recipient private key bytes 1..32, `aad` below. Test-only;
 * keep the two copies identical.
 */
export const HPKE_VECTOR_RECIPIENT_SEED = Uint8Array.from(
  { length: 32 },
  (_, i) => i + 1,
);
export const HPKE_VECTOR_AAD = "srv_hpke_vector";
export const HPKE_VECTOR_PLAINTEXT = "hpke vector plaintext";
export const HPKE_VECTOR_KID = "qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE";
export const HPKE_VECTOR: HpkeEnvelope = {
  v: 1,
  kid: HPKE_VECTOR_KID,
  enc: "J_QRSdG2Woxda2mBqLMsgsSSQ9OfY47LJM8g8c6r8mc",
  ct: "LifWMSmtWSgR8oGCsj_7sIlVuliNV6ddJiQSR-gPjsGtMS9C9w",
};
