/**
 * Minimal OpenPGP public-key reader for the repository-key checks: the primary
 * key fingerprint (v4) and the key expiry from the newest self-signature. It
 * needs no gpg binary, so the bundled-key test runs anywhere.
 */

export type PgpKeyInfo = {
  fingerprint: string;
  /** Key creation time. */
  created: Date;
  /** Expiry from the newest self-signature, `null` when the key never expires. */
  expires: Date | null;
};

type Packet = { tag: number; body: Uint8Array };

const SIG_TYPES_SELF_CERT = new Set([0x10, 0x11, 0x12, 0x13]);

/** Decode an ASCII-armored block (or pass binary through) to bytes. */
export function dearmor(input: Uint8Array): Uint8Array {
  const text = new TextDecoder("latin1").decode(input);
  if (!text.includes("-----BEGIN PGP")) return input;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("-----BEGIN PGP"));
  const body: string[] = [];
  let inHeaders = true;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("-----END PGP")) break;
    if (inHeaders) {
      if (line.trim() === "") inHeaders = false;
      continue;
    }
    if (line.startsWith("=")) continue; // CRC-24
    body.push(line.trim());
  }
  const binary = atob(body.join(""));
  return Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
}

function readPacketHeader(
  data: Uint8Array,
  pos: number,
): { tag: number; start: number; length: number } {
  const first = data[pos]!;
  if ((first & 0x80) === 0) throw new Error("not an OpenPGP packet");
  if (first & 0x40) {
    const tag = first & 0x3f;
    const l0 = data[pos + 1]!;
    if (l0 < 192) return { tag, start: pos + 2, length: l0 };
    if (l0 < 224) {
      return {
        tag,
        start: pos + 3,
        length: ((l0 - 192) << 8) + data[pos + 2]! + 192,
      };
    }
    if (l0 === 255) {
      const view = new DataView(data.buffer, data.byteOffset + pos + 2, 4);
      return { tag, start: pos + 6, length: view.getUint32(0) };
    }
    throw new Error("partial-length packets are not supported");
  }
  const tag = (first & 0x3c) >> 2;
  const lenType = first & 0x03;
  if (lenType === 0) return { tag, start: pos + 2, length: data[pos + 1]! };
  if (lenType === 1) {
    return {
      tag,
      start: pos + 3,
      length: (data[pos + 1]! << 8) | data[pos + 2]!,
    };
  }
  if (lenType === 2) {
    const view = new DataView(data.buffer, data.byteOffset + pos + 1, 4);
    return { tag, start: pos + 5, length: view.getUint32(0) };
  }
  throw new Error("indefinite-length packets are not supported");
}

export function parsePackets(data: Uint8Array): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < data.length) {
    const header = readPacketHeader(data, pos);
    packets.push({
      tag: header.tag,
      body: data.subarray(header.start, header.start + header.length),
    });
    pos = header.start + header.length;
  }
  return packets;
}

function u32(body: Uint8Array, at: number): number {
  return new DataView(body.buffer, body.byteOffset + at, 4).getUint32(0);
}

/** Creation and key-expiry (seconds) from a v4 signature's hashed subpackets. */
function signatureTimes(
  body: Uint8Array,
): { type: number; created: number; keyExpirySeconds: number | null } | null {
  if (body[0] !== 4) return null;
  const type = body[1]!;
  const hashedLen = (body[4]! << 8) | body[5]!;
  let pos = 6;
  const end = 6 + hashedLen;
  let created = 0;
  let keyExpirySeconds: number | null = null;
  while (pos < end) {
    let len = body[pos]!;
    pos += 1;
    if (len >= 192 && len < 255) {
      len = ((len - 192) << 8) + body[pos]! + 192;
      pos += 1;
    } else if (len === 255) {
      len = u32(body, pos);
      pos += 4;
    }
    const subType = body[pos]! & 0x7f;
    if (subType === 2) created = u32(body, pos + 1);
    if (subType === 9) keyExpirySeconds = u32(body, pos + 1);
    pos += len;
  }
  return { type, created, keyExpirySeconds };
}

async function sha1Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    // OpenPGP v4 fingerprints are defined as SHA-1 over the key packet; this
    // identifies a key, it does not protect anything.
    await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>), // NOSONAR typescript:S4790
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** Parse the primary key of a (possibly armored) public key file. */
export async function readPgpKey(input: Uint8Array): Promise<PgpKeyInfo> {
  const packets = parsePackets(dearmor(input));
  const primary = packets[0];
  if (primary?.tag !== 6 || primary.body[0] !== 4) {
    throw new Error("expected a v4 public key packet first");
  }
  const created = u32(primary.body, 1);
  const hashed = new Uint8Array(3 + primary.body.length);
  hashed[0] = 0x99;
  hashed[1] = (primary.body.length >> 8) & 0xff;
  hashed[2] = primary.body.length & 0xff;
  hashed.set(primary.body, 3);
  const fingerprint = await sha1Hex(hashed);

  let newest: { created: number; keyExpirySeconds: number | null } | null =
    null;
  for (const packet of packets) {
    if (packet.tag === 14) break; // subkeys come after the primary's own sigs
    if (packet.tag !== 2) continue;
    const times = signatureTimes(packet.body);
    if (!times || !SIG_TYPES_SELF_CERT.has(times.type)) continue;
    if (!newest || times.created >= newest.created) newest = times;
  }
  const expirySeconds = newest?.keyExpirySeconds ?? 0;
  return {
    fingerprint,
    created: new Date(created * 1000),
    expires: expirySeconds > 0
      ? new Date((created + expirySeconds) * 1000)
      : null,
  };
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
