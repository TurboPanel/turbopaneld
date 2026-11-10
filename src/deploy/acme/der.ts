/**
 * The small part of DER (ASN.1) the certificate client needs: read a node and
 * its children, and write the few shapes a certificate request is made of.
 * Web Crypto and plain bytes only.
 */

export type DerNode = {
  tag: number;
  /** Offset of the node's first (tag) byte within `bytes`. */
  start: number;
  /** Offset of the content within `bytes`. */
  contentOffset: number;
  /** Offset just past the node within `bytes`. */
  end: number;
  bytes: Uint8Array;
};

/** Read the node that starts at `offset`. Throws on bytes that are not DER. */
export function readNode(bytes: Uint8Array, offset = 0): DerNode {
  const tag = bytes[offset];
  const first = bytes[offset + 1];
  if (tag === undefined || first === undefined) {
    throw new RangeError("unexpected end of DER");
  }
  let cursor = offset + 2;
  let length = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || cursor + count > bytes.length) {
      throw new RangeError("unsupported DER length");
    }
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + (bytes[cursor + i] ?? 0);
    }
    cursor += count;
  }
  const end = cursor + length;
  if (end > bytes.length) throw new RangeError("truncated DER");
  return { tag, start: offset, contentOffset: cursor, end, bytes };
}

export function content(node: DerNode): Uint8Array {
  return node.bytes.subarray(node.contentOffset, node.end);
}

/** The nodes inside a constructed node; none for a primitive one. */
export function children(node: DerNode): DerNode[] {
  if ((node.tag & 0x20) === 0) return [];
  const out: DerNode[] = [];
  let offset = node.contentOffset;
  while (offset < node.end) {
    const child = readNode(node.bytes, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthBytes(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), lengthBytes(value.length), value);
}

export const sequence = (...parts: Uint8Array[]): Uint8Array =>
  tlv(0x30, concat(...parts));
export const set = (...parts: Uint8Array[]): Uint8Array =>
  tlv(0x31, concat(...parts));
export const octetString = (value: Uint8Array): Uint8Array => tlv(0x04, value);
export const oid = (value: readonly number[]): Uint8Array =>
  tlv(0x06, Uint8Array.from(value));

/** A non-negative INTEGER from big-endian bytes: no leading zeros, a sign byte when needed. */
export function unsignedInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.slice(start);
  const padded = (trimmed[0] ?? 0) >= 0x80
    ? concat(Uint8Array.of(0), trimmed)
    : trimmed;
  return tlv(0x02, padded);
}

/** Web Crypto signs ECDSA as `r || s`; X.509 wants a DER `SEQUENCE { r, s }`. */
export function derEcdsaSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return sequence(
    unsignedInteger(raw.slice(0, half)),
    unsignedInteger(raw.slice(half)),
  );
}

/** PEM text for DER bytes, 64 characters a line. */
export function encodePem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCodePoint(byte);
  const b64 = btoa(binary);
  const lines = [`-----BEGIN ${label}-----`];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  lines.push(`-----END ${label}-----`);
  return `${lines.join("\n")}\n`;
}

/** The DER bytes of the first `label` block in `pem`, or null when there is none. */
export function decodePem(pem: string, label: string): Uint8Array | null {
  const re = new RegExp(
    String
      .raw`-----BEGIN ${label}-----([A-Za-z0-9+/=\s]+)-----END ${label}-----`,
  );
  const body = re.exec(pem)?.[1]?.replaceAll(/\s+/g, "");
  if (!body) return null;
  try {
    return Uint8Array.from(atob(body), (char) => char.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}
