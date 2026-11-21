/**
 * Reads what the peer certificate may be used for. The control plane mints one
 * certificate per server for the hop between servers; a certificate made before
 * client use was added allows server use only, and showing it as a client
 * certificate would be refused by a receiver that checks. The daemon looks at
 * the certificate itself, so no flag can say it is fit when it is not.
 */
import type { TunnelPeerClientAuth } from "../contracts/commands-contracts.ts";
import {
  children,
  content,
  decodePem,
  type DerNode,
  readNode,
} from "./acme/der.ts";

/** 2.5.29.37, extKeyUsage, as DER OID content. */
const EXT_KEY_USAGE_OID = "551d25";
/** 1.3.6.1.5.5.7.3.2, id-kp-clientAuth, as DER OID content. */
const CLIENT_AUTH_OID = "2b06010505070302";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The extensions of a leaf: tbsCertificate field `[3]`, a list of extensions. */
function extensions(der: Uint8Array): DerNode[] {
  const tbs = children(readNode(der))[0];
  const wrapper = (tbs ? children(tbs) : []).find((field) =>
    field.tag === 0xa3
  );
  const list = wrapper ? children(wrapper)[0] : undefined;
  return list ? children(list) : [];
}

/**
 * True when the certificate lists client authentication among its extended key
 * usages. A certificate that lists none, or cannot be read, is not fit. (The
 * runtime's own certificate reader does not expose the extended key usages.)
 */
export function certificateAllowsClientAuth(certificatePem: string): boolean {
  try {
    const der = decodePem(certificatePem, "CERTIFICATE");
    if (!der) return false;
    for (const extension of extensions(der)) {
      const parts = children(extension);
      if (parts[0]?.tag !== 0x06) continue;
      if (hex(content(parts[0])) !== EXT_KEY_USAGE_OID) continue;
      const value = parts.at(-1);
      if (value?.tag !== 0x04) return false;
      const usages = children(readNode(content(value)));
      return usages.some((usage) =>
        usage.tag === 0x06 && hex(content(usage)) === CLIENT_AUTH_OID
      );
    }
    return false;
  } catch {
    return false;
  }
}

/** What the daemon will do for one table: what to present and what to enforce. */
export type PeerClientAuthPlan = {
  presentCertificate: boolean;
  clientAuth?: TunnelPeerClientAuth;
  warnings: string[];
};

/**
 * `require` is only kept when this server's own certificate can be shown too:
 * a server that refused certificate-less peers but could not show one would be
 * refused by the others once they enforce. It falls back to `verify` and says so.
 */
export function planPeerClientAuth(
  requested: TunnelPeerClientAuth | undefined,
  certificatePem: string | undefined,
): PeerClientAuthPlan {
  const presentCertificate = certificatePem !== undefined &&
    certificateAllowsClientAuth(certificatePem);
  if (requested === undefined) return { presentCertificate, warnings: [] };
  if (requested === "require" && !presentCertificate) {
    return {
      presentCertificate,
      clientAuth: "verify",
      warnings: [
        "peer certificate does not allow client use; client certificates are checked but not yet required",
      ],
    };
  }
  return { presentCertificate, clientAuth: requested, warnings: [] };
}
