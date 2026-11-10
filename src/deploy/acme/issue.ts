/**
 * The narrow entry point the server-placed order path calls to have this
 * daemon order a certificate itself, over the HTTP proof, instead of starting
 * a one-shot issuer: `issueCertificateOverHttp01`.
 *
 * The caller keeps everything it does today around the order: it holds the
 * order window lock, routes the proof path for the names to this request's
 * socket (`applyProofRoutes`), proves the routes, and afterwards reports the
 * pair and withdraws the routes. This call serves the answers on that socket,
 * uses this server's one account for the directory (made on first use, see
 * `account-store.ts`), runs the order for every name in one certificate, and
 * hands back the chain, its key, its expiry and the renewal hints (RFC 9773).
 * It never throws, never writes the certificate or its key to disk, and never
 * logs them.
 *
 * Only the two Let's Encrypt directories are used; `deps.directoryUrl`
 * exists for tests with an in-process authority.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import type { AcmeIssueRequestMessage } from "../../contracts/cell-messages.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import {
  defaultCommand,
  type InstanceAcmeCommand,
} from "../instance-acme-http01.ts";
import { plainInstanceAcmeProblem } from "../instance-acme-failure.ts";
import {
  LETS_ENCRYPT_DIRECTORY_URL,
  LETS_ENCRYPT_STAGING_DIRECTORY_URL,
} from "../instance-acme-issuer.ts";
import { tenantAcmeSocketPath } from "../tenant-acme-issue.ts";
import { acmeAccountClient, forgetAcmeAccount } from "./account-store.ts";
import { AcmeError, type AcmeErrorCode, fetchRenewalInfo } from "./client.ts";
import { withHttp01Answers } from "./http01.ts";
import { type ChallengeSolver, type OrderDeps, runAcmeOrder } from "./order.ts";
import { renewalCertId } from "./renewal-id.ts";

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type DaemonIssueRequest =
  & Pick<
    AcmeIssueRequestMessage,
    "requestId" | "names" | "directory" | "contactEmail"
  >
  & {
    /** Renewal-information identifier of the certificate this renews. */
    replaces?: string;
  };

export type DaemonIssueDeps = OrderDeps & {
  run?: InstanceAcmeCommand;
  fetch?: typeof fetch;
  /** Tests only: an in-process authority instead of Let's Encrypt. */
  directoryUrl?: string;
  /** Serves the answers while the order runs; the proof socket by default. */
  serveAnswers?: <T>(
    socketPath: string,
    run: InstanceAcmeCommand,
    work: (solver: ChallengeSolver) => Promise<T>,
  ) => Promise<T>;
};

export type RenewalHints = {
  /** What a renewal of this certificate sends as `replaces`; null when it lacks the fields. */
  certId: string | null;
  /** The authority's suggested window, when it gave one. */
  window: { startIso: string; endIso: string } | null;
  /** How long the authority wants callers to wait before asking about it again. */
  retryAfterMs: number | null;
};

export type DaemonIssueOutcome =
  | {
    ok: true;
    /** Leaf first, then the chain, as the authority sent it. */
    certificatePem: string;
    privateKeyPem: string;
    notAfterIso: string;
    renewal: RenewalHints;
  }
  | {
    ok: false;
    code: AcmeErrorCode;
    /** One plain sentence; a rate limit says "rate limited" (the control plane's wait keys on it). */
    reason: string;
    retryAfterMs: number | null;
  };

/** The directory for the request's choice. */
export function daemonAcmeDirectoryUrl(
  directory: DaemonIssueRequest["directory"],
): string {
  return directory === "staging"
    ? LETS_ENCRYPT_STAGING_DIRECTORY_URL
    : LETS_ENCRYPT_DIRECTORY_URL;
}

export const RATE_LIMITED_REASON =
  "Let's Encrypt has rate limited this name; it will be retried in about an hour (a week for repeated certificates)";

const GENERIC_REASON =
  "Let's Encrypt could not issue a certificate; it will be retried later";

function sentence(err: AcmeError): string {
  switch (err.code) {
    case "rate_limited":
      return RATE_LIMITED_REASON;
    case "caa":
      return plainInstanceAcmeProblem("caa");
    case "dns":
      return plainInstanceAcmeProblem("dns");
    case "unauthorized":
    case "connection":
    case "incorrect_response":
    case "tls":
      return plainInstanceAcmeProblem("unauthorized");
    case "unreachable":
      return plainInstanceAcmeProblem("network");
    case "timeout":
      return plainInstanceAcmeProblem("timeout");
    case "account_gone":
      return "this server's Let's Encrypt account was closed; a new one is made on the next try";
    case "foreign_address":
      return "Let's Encrypt named an address outside its own site, so the order was stopped";
    case "rejected_name":
    case "unsupported":
      // Either the authority refused the name or this server did; ours are plain already.
      return err.status === null
        ? err.message
        : plainInstanceAcmeProblem("rejected-identifier");
    case "malformed":
      return /contact|mailto|email/i.test(err.message)
        ? plainInstanceAcmeProblem("invalid-contact")
        : GENERIC_REASON;
    default:
      return GENERIC_REASON;
  }
}

/** Plain words for a failed order; the name is named when the failure is about one. */
export function plainDaemonAcmeFailure(err: unknown): {
  code: AcmeErrorCode;
  reason: string;
  retryAfterMs: number | null;
} {
  if (!(err instanceof AcmeError)) {
    return { code: "unknown", reason: GENERIC_REASON, retryAfterMs: null };
  }
  const text = sentence(err);
  const reason = err.identifier && !text.startsWith(err.identifier)
    ? `${err.identifier}: ${text}`
    : text;
  return { code: err.code, reason, retryAfterMs: err.retryAfterMs };
}

/** The leaf's expiry, after checking it names every name and matches the key. */
export function checkIssuedLeaf(
  certificatePem: string,
  privateKeyPem: string,
  names: readonly string[],
): string {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(certificatePem);
  } catch {
    throw new AcmeError("server", "the certificate could not be read");
  }
  const listed = new Set(
    (leaf.subjectAltName ?? "").split(",").map((entry) =>
      entry.trim().replace(/^DNS:/, "").toLowerCase()
    ),
  );
  const missing = names.find((name) => !listed.has(name.toLowerCase()));
  if (missing) {
    throw new AcmeError(
      "server",
      `the certificate does not name ${missing}`,
    );
  }
  if (!leaf.checkPrivateKey(createPrivateKey(privateKeyPem))) {
    throw new AcmeError("server", "the certificate does not match its key");
  }
  return new Date(leaf.validTo).toISOString();
}

async function renewalHints(
  certificatePem: string,
  directoryUrl: string,
  fetchFn: typeof fetch | undefined,
): Promise<RenewalHints> {
  const certId = renewalCertId(certificatePem);
  if (!certId) return { certId: null, window: null, retryAfterMs: null };
  const info = await fetchRenewalInfo({
    directoryUrl,
    certId,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  return {
    certId,
    window: info.window
      ? {
        startIso: info.window.start.toISOString(),
        endIso: info.window.end.toISOString(),
      }
      : null,
    retryAfterMs: info.retryAfterMs,
  };
}

/** Order one certificate for every name in the request over the HTTP proof. Never throws. */
export async function issueCertificateOverHttp01(
  layout: LayoutPaths,
  request: DaemonIssueRequest,
  deps: DaemonIssueDeps = {},
): Promise<DaemonIssueOutcome> {
  if (!SAFE_REQUEST_ID_RE.test(request.requestId)) {
    return {
      ok: false,
      code: "unsupported",
      reason: "the request id is not usable",
      retryAfterMs: null,
    };
  }
  const directoryUrl = deps.directoryUrl ??
    daemonAcmeDirectoryUrl(request.directory);
  const serve = deps.serveAnswers ?? withHttp01Answers;
  const fetchOption = deps.fetch ? { fetch: deps.fetch } : {};
  try {
    const chain = await serve(
      tenantAcmeSocketPath(layout, request.requestId),
      deps.run ?? defaultCommand,
      async (solver) => {
        const client = await acmeAccountClient(layout, {
          directoryUrl,
          contactEmail: request.contactEmail,
          ...fetchOption,
        });
        return await runAcmeOrder(
          client,
          {
            names: request.names,
            ...(request.replaces ? { replaces: request.replaces } : {}),
          },
          solver,
          deps,
        );
      },
    );
    const notAfterIso = checkIssuedLeaf(
      chain.certificatePem,
      chain.privateKeyPem,
      request.names,
    );
    const renewal = await renewalHints(
      chain.certificatePem,
      directoryUrl,
      deps.fetch,
    );
    return { ok: true, ...chain, notAfterIso, renewal };
  } catch (err) {
    if (err instanceof AcmeError && err.code === "account_gone") {
      await forgetAcmeAccount(layout, directoryUrl).catch(() => undefined);
    }
    return { ok: false, ...plainDaemonAcmeFailure(err) };
  }
}
