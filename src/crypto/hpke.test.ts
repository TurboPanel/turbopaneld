import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import {
  HPKE_VECTOR,
  HPKE_VECTOR_AAD,
  HPKE_VECTOR_KID,
  HPKE_VECTOR_PLAINTEXT,
  HPKE_VECTOR_RECIPIENT_SEED,
} from "../testing/hpke-vector.ts";
import { isHpkeEnvelope, openFromSender, sealingKid } from "./hpke.ts";

const test = Deno.test.bind(Deno);

async function vectorPublicKey(): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x6e,
    0x04,
    0x22,
    0x04,
    0x20,
    ...HPKE_VECTOR_RECIPIENT_SEED,
  ]);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "X25519" },
    true,
    ["deriveBits"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return Uint8Array.from(
    atob((jwk.x as string).replaceAll("-", "+").replaceAll("_", "/") + "=")
      .split("").map((c) => c.charCodeAt(0)),
  );
}

test("opens the envelope the control plane sealed for the shared vector", async () => {
  const opened = await openFromSender(
    HPKE_VECTOR_RECIPIENT_SEED,
    HPKE_VECTOR_AAD,
    HPKE_VECTOR,
  );
  assertEquals(new TextDecoder().decode(opened), HPKE_VECTOR_PLAINTEXT);
});

test("refuses a wrong server id, a tampered ciphertext and a short key", async () => {
  await assertRejects(() =>
    openFromSender(HPKE_VECTOR_RECIPIENT_SEED, "srv_other", HPKE_VECTOR)
  );
  const flipped = HPKE_VECTOR.ct.startsWith("A") ? "B" : "A";
  await assertRejects(() =>
    openFromSender(HPKE_VECTOR_RECIPIENT_SEED, HPKE_VECTOR_AAD, {
      ...HPKE_VECTOR,
      ct: flipped + HPKE_VECTOR.ct.slice(1),
    })
  );
  await assertRejects(() =>
    openFromSender(new Uint8Array(31), HPKE_VECTOR_AAD, HPKE_VECTOR)
  );
});

test("sealingKid is the control plane's fingerprint of the raw public key", async () => {
  assertEquals(await sealingKid(await vectorPublicKey()), HPKE_VECTOR_KID);
  assertEquals(HPKE_VECTOR_KID.length, 43);
  assertEquals(encodeBase64Url(new Uint8Array(32)).length, 43);
});

test("isHpkeEnvelope accepts the vector and rejects other shapes", () => {
  assert(isHpkeEnvelope(HPKE_VECTOR));
  assert(!isHpkeEnvelope("tpdaemon.v1.x"));
  assert(!isHpkeEnvelope({ ...HPKE_VECTOR, v: 2 }));
  assert(!isHpkeEnvelope({ ...HPKE_VECTOR, kid: "short" }));
  assert(!isHpkeEnvelope(null));
});
