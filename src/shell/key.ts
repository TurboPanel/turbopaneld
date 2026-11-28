/**
 * The session key of one web terminal session travels in `shell-open` as
 * `keySealed`: base64url of the HPKE encapsulated key (32 bytes) followed by
 * the ciphertext (the 32-byte key and a 16-byte tag), sealed with the same
 * suite as the other daemon secrets (`crypto/hpke.ts`), `aad` = the server id
 * and `info` = "turbopanel shell key v1" followed by the lower-case sid.
 */
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import {
  type HpkeEnvelope,
  openFromSender,
  sealingKid,
  sealToRecipient,
} from "../crypto/hpke.ts";
import { KEY_BYTES } from "./frames.ts";

export const SHELL_KEY_INFO_PREFIX = "turbopanel shell key v1";
const ENC_BYTES = 32;
const TAG_BYTES = 16;

export function shellKeyInfo(sid: string): string {
  return `${SHELL_KEY_INFO_PREFIX}${sid.toLowerCase()}`;
}

/** Seal a session key the way the control plane does (used by tests and vectors). */
export async function sealShellKey(
  recipientPublicRaw: Uint8Array,
  serverId: string,
  sid: string,
  key: Uint8Array,
): Promise<string> {
  const envelope = await sealToRecipient(
    recipientPublicRaw,
    await sealingKid(recipientPublicRaw),
    serverId,
    key,
    shellKeyInfo(sid),
  );
  const enc = decodeBase64Url(envelope.enc);
  const ct = decodeBase64Url(envelope.ct);
  const joined = new Uint8Array(enc.length + ct.length);
  joined.set(enc, 0);
  joined.set(ct, enc.length);
  return encodeBase64Url(joined);
}

/** The 32-byte session key; throws on any malformed or mismatched input. */
export async function openShellKey(
  recipientPrivateRaw: Uint8Array,
  serverId: string,
  sid: string,
  keySealed: string,
): Promise<Uint8Array> {
  const joined = decodeBase64Url(keySealed);
  if (joined.length !== ENC_BYTES + KEY_BYTES + TAG_BYTES) {
    throw new TypeError("keySealed has the wrong length");
  }
  const envelope: HpkeEnvelope = {
    v: 1,
    kid: "",
    enc: encodeBase64Url(joined.subarray(0, ENC_BYTES)),
    ct: encodeBase64Url(joined.subarray(ENC_BYTES)),
  };
  const key = await openFromSender(
    recipientPrivateRaw,
    serverId,
    envelope,
    shellKeyInfo(sid),
  );
  if (key.length !== KEY_BYTES) throw new TypeError("session key length");
  return key;
}
