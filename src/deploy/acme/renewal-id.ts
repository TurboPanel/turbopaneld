/**
 * The identifier ACME Renewal Information (RFC 9773) uses for a certificate:
 * the base64url authority key identifier, a dot, and the base64url serial
 * number, both as they appear in the leaf. A renewal order sends it as
 * `replaces`.
 */
import { encodeBase64Url } from "@std/encoding/base64url";
import { children, content, decodePem, type DerNode, readNode } from "./der.ts";

/** 2.5.29.35, authorityKeyIdentifier, as DER OID content. */
const AKI_OID = "551d23";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tbsCertificate fields, the explicit version skipped. */
function tbsFields(der: Uint8Array): DerNode[] {
  const tbs = children(readNode(der))[0];
  const fields = tbs ? children(tbs) : [];
  return fields[0]?.tag === 0xa0 ? fields.slice(1) : fields;
}

function authorityKeyId(fields: DerNode[]): Uint8Array | null {
  const wrapper = fields.find((field) => field.tag === 0xa3);
  const list = wrapper ? children(wrapper)[0] : undefined;
  for (const extension of list ? children(list) : []) {
    const parts = children(extension);
    if (parts[0]?.tag !== 0x06 || hex(content(parts[0])) !== AKI_OID) continue;
    const value = parts.at(-1);
    if (value?.tag !== 0x04) return null;
    const keyId = children(readNode(content(value))).find((node) =>
      node.tag === 0x80
    );
    return keyId ? content(keyId) : null;
  }
  return null;
}

/** The renewal-information identifier of the first certificate in `pem`, or null. */
export function renewalCertId(certificatePem: string): string | null {
  try {
    const der = decodePem(certificatePem, "CERTIFICATE");
    if (!der) return null;
    const fields = tbsFields(der);
    const serial = fields[0]?.tag === 0x02 ? content(fields[0]) : null;
    const aki = authorityKeyId(fields);
    if (!aki || !serial || serial.length === 0) return null;
    // RFC 9773 takes the DER content as is, the leading zero of a serial whose
    // top bit is set included (its own example: 0x87654321 gives "AIdlQyE").
    return `${encodeBase64Url(aki)}.${encodeBase64Url(serial)}`;
  } catch {
    return null;
  }
}
