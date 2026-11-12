/**
 * An in-process certificate authority for the daemon's ACME client tests. It
 * checks every signed request the way a real one does (nonce, address,
 * signature), validates HTTP-01 challenges through a fetch the test supplies,
 * checks the request for the certificate (names and signature) and hands back
 * a leaf signed by its own key for exactly those names, with an authority key
 * identifier and a serial whose top bit is set. No network.
 */
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { accountThumbprint, type AcmeAccountKey } from "../deploy/acme/jws.ts";
import {
  children,
  concat,
  content,
  type DerNode,
  encodePem,
  octetString,
  oid,
  readNode,
  sequence,
  set,
  tlv,
  unsignedInteger,
} from "../deploy/acme/der.ts";
import {
  OID_ECDSA_SHA256,
  sanExtension,
  signEcdsaDer,
} from "../deploy/acme/csr.ts";

export const FAKE_CA_DIRECTORY = "https://ca.test/directory";
const BASE = "https://ca.test";

type Jwk = { crv: string; kty: string; x: string; y: string };
type Authz = {
  id: string;
  identifier: string;
  wildcard: boolean;
  token: string;
  /** `pending`, then `valid` or `invalid` once the answer was checked. */
  state: "pending" | "valid" | "invalid" | "deactivated";
  /** Reads left before a checked answer shows as settled. */
  holdReads: number;
  error?: { type: string; detail: string };
};
type Order = {
  id: string;
  names: string[];
  authz: Authz[];
  finalized: boolean;
  polls: number;
};

export type FakeCaOptions = {
  /**
   * What a fetch of `http://<name>/.well-known/acme-challenge/<token>` answers;
   * null is a refused connection.
   */
  http01?: (name: string, token: string) => Promise<string | null>;
  /** Refuse new orders with a rate-limit error and this `Retry-After`. */
  rateLimitOrders?: string;
  /**
   * Refuse an order that names a certificate it replaces, with this problem
   * (for example `alreadyReplaced`).
   */
  refuseReplaces?: string;
  /** Answer the first nonce-bearing request with a stale-nonce error. */
  staleNonceOnce?: boolean;
  /** The order stays `processing` for this many polls after the request. */
  processingPolls?: number;
  /** An answered authorization still reads `pending` this many times. */
  pendingReads?: number;
  /** `Retry-After` sent with every authorization and order read. */
  pollRetryAfter?: string;
  /** Names whose authorization is already valid when the order opens. */
  alreadyValid?: string[];
  /**
   * Offers renewal information; the window is what it suggests for any
   * certificate.
   */
  renewalWindow?: { start: Date; end: Date };
  /** Order addresses point at this host instead of the authority's own. */
  orderHost?: string;
  /** The certificate link answers this text instead of a certificate. */
  certificateBody?: string;
  /** The issued leaf leaves out this name. */
  dropName?: string;
  /**
   * An order whose checks all passed reads with this status instead of `ready`.
   */
  readyAs?: string;
};

export type FakeCa = {
  fetch: typeof fetch;
  accounts: Map<string, Jwk>;
  orders: Order[];
  /** Every signed request: path and the account address it used, if any. */
  log: { path: string; kid: string | null }[];
  /** Every URL the client asked for, in order. */
  requested: string[];
  /** Challenge answers received (the challenge id of each). */
  answers: string[];
  /** Authorizations deactivated by their account. */
  deactivated: string[];
  /** The names on each certificate issued, in order. */
  issued: string[][];
  /** Renewal-information identifiers asked about. */
  renewalAsked: string[];
  /** The `replaces` field of each new order, in order. */
  orderReplaces: (string | undefined)[];
  /** The `Accept` header of each certificate download. */
  certificateAccept: (string | null)[];
  /**
   * From now on every request signed by an existing account is refused as
   * deactivated.
   */
  deactivateAccounts: () => void;
  /** The next `count` authorization reads answer a server error. */
  failAuthzReads: (count: number) => void;
  /** The authority key identifier on every leaf it issues. */
  keyId: Uint8Array;
};

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function problem(
  type: string,
  detail: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return json({ type: `urn:ietf:params:acme:error:${type}`, detail }, {
    status,
    headers,
  });
}

function raw(node: DerNode): Uint8Array {
  return node.bytes.subarray(node.start, node.end);
}

function derSignatureToRaw(der: Uint8Array): Uint8Array {
  const [r, s] = children(readNode(der));
  const fix = (n: DerNode | undefined) => {
    if (!n) throw new TypeError("signature part missing");
    const bytes = content(n);
    const trimmed = bytes[0] === 0 ? bytes.slice(1) : bytes;
    const out = new Uint8Array(32);
    out.set(trimmed, 32 - trimmed.length);
    return out;
  };
  return concat(fix(r), fix(s));
}

/**
 * The names in a request for a certificate, after checking its signature, and
 * its public key.
 */
async function verifyCsr(
  csr: Uint8Array,
): Promise<{ names: string[]; spki: Uint8Array }> {
  const [info, , sigBits] = children(readNode(csr));
  if (!info || !sigBits) throw new TypeError("not a certificate request");
  const [, , spki, attrs] = children(info);
  if (!spki || !attrs) throw new TypeError("not a certificate request");
  const key = await crypto.subtle.importKey(
    "spki",
    raw(spki) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    derSignatureToRaw(content(sigBits).subarray(1)) as BufferSource,
    raw(info) as BufferSource,
  );
  if (!ok) throw new TypeError("the request signature is wrong");
  // attributes > attribute > set > extensions > extension > octet string >
  // general names
  const attribute = children(attrs)[0];
  const extensionSet = attribute ? children(attribute)[1] : undefined;
  const extensions = extensionSet ? children(extensionSet)[0] : undefined;
  const san = extensions ? children(children(extensions)[0]!)[1] : undefined;
  if (!san) throw new TypeError("the request names nothing");
  const names = children(readNode(content(san))).map((n) =>
    new TextDecoder().decode(content(n))
  );
  return { names, spki: new Uint8Array(raw(spki)) };
}

const OID_CN = [0x55, 0x04, 0x03];
const OID_AKI = [0x55, 0x1d, 0x23];
const encoder = new TextEncoder();

function nameOf(cn: string): Uint8Array {
  return sequence(set(sequence(oid(OID_CN), tlv(0x0c, encoder.encode(cn)))));
}

async function mintLeaf(
  caKey: CryptoKey,
  keyId: Uint8Array,
  serial: Uint8Array,
  names: string[],
  spki: Uint8Array,
): Promise<string> {
  const aki = sequence(
    oid(OID_AKI),
    octetString(sequence(tlv(0x80, keyId))),
  );
  const tbs = sequence(
    tlv(0xa0, unsignedInteger(Uint8Array.of(2))),
    tlv(0x02, serial),
    sequence(oid(OID_ECDSA_SHA256)),
    nameOf("Fake Test CA"),
    sequence(
      tlv(0x17, encoder.encode("260101000000Z")),
      tlv(0x17, encoder.encode("270101000000Z")),
    ),
    nameOf(names[0] ?? "unnamed"),
    spki,
    tlv(0xa3, sequence(sanExtension(names), aki)),
  );
  const signature = await signEcdsaDer(caKey, tbs);
  return encodePem(
    "CERTIFICATE",
    sequence(
      tbs,
      sequence(oid(OID_ECDSA_SHA256)),
      tlv(0x03, concat(Uint8Array.of(0), signature)),
    ),
  );
}

type Signed = { kid: string | null; jwk: Jwk; payload: unknown };
type ReplyHeaders = Record<string, string>;

/**
 * Make a fresh authority. Its account, order and token ids count up, so tests
 * stay deterministic.
 */
export async function createFakeCa(
  options: FakeCaOptions = {},
): Promise<FakeCa> {
  const caPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const keyId = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
  const accounts = new Map<string, Jwk>();
  const orders: Order[] = [];
  const log: FakeCa["log"] = [];
  const requested: string[] = [];
  const issued: string[][] = [];
  const answers: string[] = [];
  const deactivatedAuthz: string[] = [];
  const renewalAsked: string[] = [];
  const orderReplaces: (string | undefined)[] = [];
  const certificateAccept: (string | null)[] = [];
  const deactivatedAccounts = new Set<string>();
  const nonces = new Set<string>();
  let stale = options.staleNonceOnce === true;
  let authzReadFailures = 0;
  let counter = 0;
  const next = (prefix: string) => {
    counter += 1;
    return `${prefix}${counter}`;
  };
  const orderBase = options.orderHost ? `https://${options.orderHost}` : BASE;
  const pollHeaders = (): ReplyHeaders =>
    options.pollRetryAfter ? { "Retry-After": options.pollRetryAfter } : {};

  let nonceCount = 0;
  const freshNonce = () => {
    nonceCount += 1;
    const nonce = `nonce-${nonceCount}`;
    nonces.add(nonce);
    return nonce;
  };

  async function open(url: string, body: string): Promise<Signed | Response> {
    const parsed = JSON.parse(body) as {
      protected: string;
      payload: string;
      signature: string;
    };
    const header = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parsed.protected)),
    ) as { nonce: string; url: string; kid?: string; jwk?: Jwk };
    if (stale) {
      stale = false;
      return problem("badNonce", "stale nonce", 400, {
        "Replay-Nonce": freshNonce(),
      });
    }
    if (!nonces.delete(header.nonce)) {
      return problem("badNonce", "unknown nonce", 400, {
        "Replay-Nonce": freshNonce(),
      });
    }
    if (header.url !== url) return problem("malformed", "wrong url", 400);
    // As the protocol says: a key names itself only to register; after that, by
    // account.
    const registering = new URL(url).pathname === "/acct";
    if (
      registering !== (header.jwk !== undefined) || (registering && header.kid)
    ) {
      return problem(
        "malformed",
        registering ? "register with the key itself" : "sign with the account",
        400,
        { "Replay-Nonce": freshNonce() },
      );
    }
    const jwk = header.jwk ??
      (header.kid ? accounts.get(header.kid) : undefined);
    if (!jwk) return problem("accountDoesNotExist", "unknown account", 400);
    if (header.kid && deactivatedAccounts.has(header.kid)) {
      return problem(
        "unauthorized",
        "Account is not valid, has status 'deactivated'",
        403,
        { "Replay-Nonce": freshNonce() },
      );
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(parsed.signature) as BufferSource,
      encoder.encode(`${parsed.protected}.${parsed.payload}`),
    );
    if (!valid) return problem("malformed", "bad signature", 400);
    const payload = parsed.payload === "" ? "" : JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parsed.payload)),
    );
    log.push({ path: new URL(url).pathname, kid: header.kid ?? null });
    return { kid: header.kid ?? null, jwk, payload };
  }

  const authzStatus = (a: Authz): Authz["state"] => {
    if (a.state === "valid" || a.state === "invalid") {
      if (a.holdReads > 0) {
        a.holdReads -= 1;
        return "pending";
      }
    }
    return a.state;
  };

  const authzBody = (a: Authz, status = authzStatus(a)) => {
    const challengeStatus = status === "deactivated" ? "pending" : status;
    const challenges = [
      ...(a.wildcard ? [] : [{ type: "http-01", id: `${a.id}h` }]),
      { type: "dns-01", id: `${a.id}d` },
    ];
    return {
      status,
      identifier: { type: "dns", value: a.identifier },
      ...(a.wildcard ? { wildcard: true } : {}),
      expires: "2099-01-01T00:00:00Z",
      challenges: challenges.map((c) => ({
        type: c.type,
        url: `${orderBase}/chall/${c.id}`,
        token: a.token,
        status: challengeStatus,
        ...(status === "invalid" && a.error ? { error: a.error } : {}),
      })),
    };
  };

  const orderBody = (order: Order) => {
    const states = order.authz.map((a) =>
      a.holdReads > 0 ? "pending" : a.state
    );
    let status = states.every((s) => s === "valid")
      ? (options.readyAs ?? "ready")
      : "pending";
    if (states.some((s) => s === "invalid" || s === "deactivated")) {
      status = "invalid";
    }
    if (order.finalized) {
      order.polls += 1;
      status = order.polls > (options.processingPolls ?? 0)
        ? "valid"
        : "processing";
    }
    return {
      status,
      identifiers: order.names.map((value) => ({ type: "dns", value })),
      authorizations: order.authz.map((a) => `${orderBase}/authz/${a.id}`),
      finalize: `${orderBase}/finalize/${order.id}`,
      ...(status === "valid"
        ? { certificate: `${orderBase}/cert/${order.id}` }
        : {}),
    };
  };

  const newOrder = (signed: Signed, headers: ReplyHeaders): Response => {
    if (options.rateLimitOrders !== undefined) {
      return problem("rateLimited", "too many new orders", 429, {
        ...headers,
        "Retry-After": options.rateLimitOrders,
      });
    }
    const payload = signed.payload as {
      identifiers: { value: string }[];
      replaces?: string;
    };
    if (payload.replaces && options.refuseReplaces) {
      return problem(options.refuseReplaces, "refused", 409, headers);
    }
    orderReplaces.push(payload.replaces);
    const names = payload.identifiers.map((i) => i.value);
    const id = next("o");
    const authz: Authz[] = names.map((name) => ({
      id: next("z"),
      identifier: name.replace(/^\*\./, ""),
      wildcard: name.startsWith("*."),
      token: encodeBase64Url(encoder.encode(next("token-"))),
      state: options.alreadyValid?.includes(name) ? "valid" : "pending",
      holdReads: 0,
    }));
    const order: Order = { id, names, authz, finalized: false, polls: 0 };
    orders.push(order);
    return json(orderBody(order), {
      status: 201,
      headers: { ...headers, Location: `${orderBase}/order/${id}` },
    });
  };

  const account = (signed: Signed, headers: ReplyHeaders): Response => {
    // A key the authority already knows gets its account back, as the protocol
    // says.
    const known = [...accounts].find(([, k]) =>
      k.x === signed.jwk.x && k.y === signed.jwk.y
    );
    if (known) {
      return json({ status: "valid" }, {
        headers: { ...headers, Location: known[0] },
      });
    }
    const id = `${BASE}/acct/${next("a")}`;
    accounts.set(id, signed.jwk);
    return json({ status: "valid" }, {
      status: 201,
      headers: { ...headers, Location: id },
    });
  };

  const check = async (a: Authz, jwk: Jwk) => {
    const thumb = await accountThumbprint(
      { publicJwk: jwk } as AcmeAccountKey,
    );
    const body = options.http01
      ? await options.http01(a.identifier, a.token)
      : null;
    if (body === null) {
      a.state = "invalid";
      a.error = {
        type: "urn:ietf:params:acme:error:connection",
        detail: `Connection refused for ${a.identifier}`,
      };
    } else if (body.trim() === `${a.token}.${thumb}`) {
      a.state = "valid";
    } else {
      a.state = "invalid";
      a.error = {
        type: "urn:ietf:params:acme:error:incorrectResponse",
        detail: "The key authorization file from the server did not match",
      };
    }
    a.holdReads = options.pendingReads ?? 0;
  };

  const answer = async (
    a: Authz,
    challengeId: string,
    signed: Signed,
    headers: ReplyHeaders,
  ): Promise<Response> => {
    answers.push(challengeId);
    if (a.state === "pending") await check(a, signed.jwk);
    return json({ status: "processing" }, { headers });
  };

  const finalize = async (
    order: Order,
    signed: Signed,
    headers: ReplyHeaders,
  ): Promise<Response> => {
    const csr = decodeBase64Url((signed.payload as { csr: string }).csr);
    const request = await verifyCsr(csr);
    if (request.names.join() !== order.names.join()) {
      return problem("badCSR", "names differ", 400, headers);
    }
    order.finalized = true;
    (order as Order & { spki?: Uint8Array }).spki = request.spki;
    return json(orderBody(order), { headers });
  };

  const certificate = async (
    order: Order & { spki?: Uint8Array },
    headers: ReplyHeaders,
  ): Promise<Response> => {
    const names = order.names.filter((n) => n !== options.dropName);
    issued.push(order.names);
    const serial = Uint8Array.of(0x00, 0x87, 0x65, 0x43, issued.length);
    const pem = options.certificateBody ??
      await mintLeaf(
        caPair.privateKey,
        keyId,
        serial,
        names,
        order.spki ?? new Uint8Array(),
      );
    return new Response(pem, {
      headers: {
        ...headers,
        "Content-Type": "application/pem-certificate-chain",
      },
    });
  };

  const authorization = (
    a: Authz,
    signed: Signed,
    headers: ReplyHeaders,
  ): Response => {
    const asked = (signed.payload as { status?: string } | "") || null;
    if (asked?.status !== "deactivated") {
      if (authzReadFailures > 0) {
        authzReadFailures -= 1;
        return problem("serverInternal", "busy", 500, headers);
      }
      return json(authzBody(a), {
        headers: { ...headers, ...pollHeaders() },
      });
    }
    if (a.state !== "pending" && a.state !== "valid") {
      return problem("malformed", "cannot deactivate", 400, headers);
    }
    a.state = "deactivated";
    deactivatedAuthz.push(a.id);
    return json(authzBody(a), { headers });
  };

  const findAuthz = (id: string) => {
    for (const order of orders) {
      const found = order.authz.find((a) =>
        a.id === id || `${a.id}h` === id || `${a.id}d` === id
      );
      if (found) return found;
    }
    return null;
  };

  const orderRequest = async (
    kind: string,
    id: string,
    signed: Signed,
    headers: ReplyHeaders,
  ): Promise<Response | null> => {
    const order = orders.find((o) => o.id === id);
    const authz = findAuthz(id);
    if (kind === "chall" && authz) {
      return await answer(authz, id, signed, headers);
    }
    if (kind === "authz" && authz) {
      return authorization(authz, signed, headers);
    }
    if (!order) return null;
    if (kind === "order") {
      return json(orderBody(order), {
        headers: { ...headers, ...pollHeaders() },
      });
    }
    if (kind === "finalize") return await finalize(order, signed, headers);
    if (kind === "cert") return await certificate(order, headers);
    return null;
  };

  const handlePost = async (url: string, body: string): Promise<Response> => {
    const path = new URL(url).pathname;
    const signed = await open(url, body);
    if (signed instanceof Response) return signed;
    const headers = { "Replay-Nonce": freshNonce() };
    if (path === "/acct") return account(signed, headers);
    if (path === "/order") return newOrder(signed, headers);
    const [, kind = "", id = ""] = path.split("/");
    const answered = await orderRequest(kind, id, signed, headers);
    return answered ??
      problem("malformed", `unknown path ${path}`, 404, headers);
  };

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else url = input instanceof URL ? input.href : input.url;
    requested.push(url);
    const path = new URL(url).pathname;
    if (path === "/directory") {
      return json({
        newNonce: `${BASE}/nonce`,
        newAccount: `${BASE}/acct`,
        newOrder: `${BASE}/order`,
        ...(options.renewalWindow ? { renewalInfo: `${BASE}/renewal` } : {}),
        meta: { termsOfService: `${BASE}/terms.pdf` },
      });
    }
    if (path.startsWith("/renewal/") && options.renewalWindow) {
      renewalAsked.push(path.slice("/renewal/".length));
      return json({
        suggestedWindow: {
          start: options.renewalWindow.start.toISOString(),
          end: options.renewalWindow.end.toISOString(),
        },
      }, { headers: { "Retry-After": "21600" } });
    }
    if (path === "/nonce") {
      return new Response(null, {
        status: 200,
        headers: { "Replay-Nonce": freshNonce() },
      });
    }
    if (path.startsWith("/cert/")) {
      certificateAccept.push(new Headers(init?.headers).get("accept"));
    }
    return await handlePost(
      url,
      typeof init?.body === "string" ? init.body : "",
    );
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    accounts,
    orders,
    log,
    requested,
    issued,
    answers,
    deactivated: deactivatedAuthz,
    renewalAsked,
    orderReplaces,
    certificateAccept,
    keyId,
    deactivateAccounts: () => {
      for (const id of accounts.keys()) deactivatedAccounts.add(id);
    },
    failAuthzReads: (count) => {
      authzReadFailures = count;
    },
  };
}
