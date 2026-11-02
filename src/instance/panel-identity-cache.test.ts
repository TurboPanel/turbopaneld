import { assert, assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { sealingKid } from "../crypto/hpke.ts";
import {
  createPanelSealKeySource,
  IDENTITY_DOCUMENT_PATH,
  type PanelIdentityFetch,
} from "./panel-identity-cache.ts";

const test = Deno.test.bind(Deno);

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function rawPublic(
  algorithm: "Ed25519" | "X25519",
  pair: CryptoKeyPair,
): Promise<Uint8Array> {
  void algorithm;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const x = (jwk.x as string).replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(x + "=".repeat((4 - x.length % 4) % 4)),
    (c) => c.charCodeAt(0),
  );
}

async function signedDocument(
  options: { keyset?: number; expiresInMs?: number; tamper?: boolean } = {},
): Promise<
  {
    fetched: PanelIdentityFetch;
    sealPub: Uint8Array;
    sealKid: string;
    currentKid: string;
  }
> {
  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const sealing = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]) as CryptoKeyPair;
  const currentPub = await rawPublic("Ed25519", signing);
  const sealPub = await rawPublic("X25519", sealing);
  const currentKid = await sealingKid(currentPub);
  const sealKid = await sealingKid(sealPub);
  const body = JSON.stringify({
    v: 1,
    keys: [{
      kid: currentKid,
      alg: "Ed25519",
      pub: encodeBase64Url(currentPub),
      role: "current",
    }],
    seal: { kid: sealKid, alg: "X25519", pub: encodeBase64Url(sealPub) },
    keyset: options.keyset ?? 1,
    urls: [],
    issued: new Date(NOW).toISOString(),
    expires: new Date(NOW + (options.expiresInMs ?? 30 * DAY)).toISOString(),
  });
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      signing.privateKey,
      new TextEncoder().encode(`tp-http\n${IDENTITY_DOCUMENT_PATH}\n${body}`),
    ),
  );
  return {
    fetched: {
      body: options.tamper ? body.replace('"keyset":1', '"keyset":9') : body,
      signature: `${currentKid}:${encodeBase64Url(sig)}`,
    },
    sealPub,
    sealKid,
    currentKid,
  };
}

test("a signed document yields the sealing key and the signing fingerprint", async () => {
  const doc = await signedDocument();
  const source = createPanelSealKeySource({
    fetchDocument: () => Promise.resolve(doc.fetched),
    now: () => NOW,
  });
  const key = await source.get();
  assertEquals(key?.kid, doc.sealKid);
  assertEquals(key?.panelFingerprint, doc.currentKid);
  assertEquals(key?.pub, doc.sealPub);
});

test("an unsigned, tampered, expired or untrusted document gives no key", async () => {
  const cases: Array<
    [PanelIdentityFetch, ((kid: string) => boolean) | undefined]
  > = [];
  const good = await signedDocument();
  cases.push([{ ...good.fetched, signature: null }, undefined]);
  cases.push([(await signedDocument({ tamper: true })).fetched, undefined]);
  cases.push([(await signedDocument({ expiresInMs: -1 })).fetched, undefined]);
  cases.push([{ body: "{not json", signature: "x:y" }, undefined]);
  cases.push([good.fetched, () => false]);
  for (const [fetched, trusted] of cases) {
    const source = createPanelSealKeySource({
      fetchDocument: () => Promise.resolve(fetched),
      now: () => NOW,
      ...(trusted ? { isTrustedSigningKey: trusted } : {}),
    });
    assertEquals(await source.get(), null);
  }
});

test("the key is cached for a day and a lower keyset never replaces it", async () => {
  const first = await signedDocument({ keyset: 2 });
  const lower = await signedDocument({ keyset: 1 });
  let calls = 0;
  let current = first.fetched;
  let clock = NOW;
  const source = createPanelSealKeySource({
    fetchDocument: () => {
      calls += 1;
      return Promise.resolve(current);
    },
    now: () => clock,
  });
  assertEquals((await source.get())?.kid, first.sealKid);
  await source.get();
  assertEquals(calls, 1);

  clock += DAY + 1;
  current = lower.fetched;
  assertEquals((await source.get())?.kid, first.sealKid);
  assertEquals(calls, 2);
});

test("a failed fetch keeps the last good key and yields none before one", async () => {
  const doc = await signedDocument();
  let fail = false;
  let clock = NOW;
  const source = createPanelSealKeySource({
    fetchDocument: () =>
      fail ? Promise.reject(new Error("down")) : Promise.resolve(doc.fetched),
    now: () => clock,
  });
  fail = true;
  assertEquals(await source.get(), null);
  fail = false;
  assert((await source.get()) !== null);
  fail = true;
  clock += 2 * DAY;
  assert((await source.get()) !== null);
});
