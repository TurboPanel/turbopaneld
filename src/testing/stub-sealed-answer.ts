import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { HpkeEnvelope } from "../crypto/hpke.ts";
import type { DaemonSealingContext } from "../instance/api-client.ts";
import { HPKE_VECTOR_KID } from "./hpke-vector.ts";

/**
 * Test-only stand-in for a sealed `/secrets/decrypt` answer: each "envelope"
 * carries its plaintext base64url-encoded in `ct`, and
 * {@link STUB_SEALING_CONTEXT} reads it back. No cryptography is involved;
 * tests of the real seal and open use `hpke-vector.ts`.
 */
export const STUB_SEALING_CONTEXT: DaemonSealingContext = {
  open: (envelope) =>
    Promise.resolve(
      new TextDecoder().decode(decodeBase64Url(envelope.ct)),
    ),
};

export function stubEnvelope(plaintext: string): HpkeEnvelope {
  return {
    v: 1,
    kid: HPKE_VECTOR_KID,
    enc: "c3R1Yg",
    ct: encodeBase64Url(new TextEncoder().encode(plaintext)),
  };
}

/** The body of a sealed decrypt answer for `plaintexts`, in order (`null` stays `null`). */
export function stubSealedAnswer(
  plaintexts: ReadonlyArray<string | null>,
): { ok: true; sealed: Array<HpkeEnvelope | null> } {
  return {
    ok: true,
    sealed: plaintexts.map((value) =>
      value === null ? null : stubEnvelope(value)
    ),
  };
}
