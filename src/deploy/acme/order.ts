/**
 * One certificate order from start to finish for one or more names, in one
 * certificate (every name in its subject alternative names): open the order,
 * answer each name's authorization with the solver's challenge type, wait for
 * the authority to validate, send the request for the certificate and fetch
 * the chain. The certificate key is made inside this call and returned with
 * the chain; nothing here writes it anywhere.
 *
 * The control plane owns the schedule (when to try, when to wait after a
 * failure), so this does not keep state between calls and does not retry an
 * order. Inside one call it only retries what is safe to retry: a stale nonce
 * (in the client), a `replaces` the authority says is already used, and a few
 * transient read failures while polling. Everything else comes back as an
 * {@link AcmeError} with the authority's wait, if it gave one.
 *
 * The solver is how a challenge is answered. HTTP-01 answers through the
 * server's own proof socket (`http01.ts`); a DNS-01 solver that asks the
 * control plane to publish the record plugs in the same way later.
 */
import { forEachSequential } from "../../util/sequential.ts";
import { logWarn } from "../../util/logger.ts";
import {
  type AcmeAuthorization,
  type AcmeChallenge,
  type AcmeClient,
  AcmeError,
  type AcmeOrder,
  LocalAcmeError,
  problemCode,
  problemDetail,
} from "./client.ts";
import { buildCertificateRequest, generateCertificateKey } from "./csr.ts";

/** How long a whole order may take before it is given up. */
export const ACME_ORDER_TIMEOUT_MS = 3 * 60_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 10_000;
/**
 * A poll gives up at this many transient read failures in a row (it lives
 * through two).
 */
const TRANSIENT_READS = 3;

export type ChallengeSolver = {
  /** The challenge type this solver answers (`http-01`, later `dns-01`). */
  type: string;
  /**
   * Put the answer in place. `value` is the key authorization (HTTP-01) or the
   * TXT value (DNS-01).
   */
  present(challenge: SolverChallenge): Promise<void>;
  /**
   * Take the answer away again; called once the order is over, whatever its
   * outcome.
   */
  remove(challenge: SolverChallenge): Promise<void>;
};

export type SolverChallenge = { name: string; token: string; value: string };

export type OrderDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

export type OrderInput = {
  names: readonly string[];
  /**
   * Renewal-information identifier of the certificate this renews (RFC 9773).
   */
  replaces?: string;
};

export type IssuedChain = {
  certificatePem: string;
  privateKeyPem: string;
  /** The names as ordered: folded to lowercase, each once. */
  names: string[];
};

const DNS_NAME_RE =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * The names lowercased, each once; refused when empty or one is not a DNS name.
 */
export function orderNames(
  names: readonly string[],
  solverType: string,
): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().toLowerCase().replace(/\.$/, "");
    // Length first: names come off the wire.
    if (
      name.length > 253 || /^\d+(?:\.\d+){3}$/.test(name) ||
      !DNS_NAME_RE.test(name)
    ) {
      // Off the wire: quoted and cut short, so a long or odd value stays one
      // line.
      throw new LocalAcmeError(
        "rejected_name",
        `${JSON.stringify(raw.slice(0, 80))} is not a domain name`,
      );
    }
    if (name.startsWith("*.") && solverType !== "dns-01") {
      throw new LocalAcmeError(
        "unsupported",
        `${name} is a wildcard name, which can only be checked through DNS`,
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) {
    throw new LocalAcmeError("rejected_name", "the order names no domain");
  }
  return out;
}

/**
 * Giving up the authorizations of a failed order gets its own short budget,
 * after the order's: together they stay well inside the issuer unit's
 * `RuntimeMaxSec=600` even for a certificate with a hundred names.
 */
export const ACME_DEACTIVATE_BUDGET_MS = 30_000;

/**
 * One deadline for the whole order. `signal` ends any request still running
 * when the time is up (real time); `check` refuses to start a step once the
 * deadline has passed on the order's own clock (which tests drive).
 */
type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadline: number;
  signal: AbortSignal;
  check: (what: string) => void;
};

function timeoutError(what: string): AcmeError {
  return new AcmeError(
    "timeout",
    `the certificate authority did not finish ${what} in time`,
  );
}

function clockFor(deps: OrderDeps): Clock {
  const now = deps.now ?? Date.now;
  const budget = deps.timeoutMs ?? ACME_ORDER_TIMEOUT_MS;
  const deadline = now() + budget;
  const signal = AbortSignal.timeout(budget);
  return {
    now,
    sleep: deps.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    deadline,
    signal,
    check: (what) => {
      if (signal.aborted || now() >= deadline) throw timeoutError(what);
    },
  };
}

function transient(err: unknown): boolean {
  if (!(err instanceof AcmeError)) return false;
  if (err.code === "unreachable") return true;
  return err.code === "server" && (err.status ?? 500) >= 500 &&
    err.status !== 503;
}

function pollWait(retryAfterMs: number | null, attempt: number): number {
  const backoff = MIN_POLL_MS * 2 ** Math.min(attempt, 3);
  return Math.min(Math.max(retryAfterMs ?? backoff, MIN_POLL_MS), MAX_POLL_MS);
}

/**
 * Read until `settled` says the answer is final, waiting what the authority
 * asks between reads (within bounds). A few transient failures are lived
 * through; the deadline ends it with a `timeout` error.
 */
async function pollUntil<T extends { retryAfterMs: number | null }>(
  clock: Clock,
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  what: string,
): Promise<T> {
  const step = async (attempt: number, failures: number): Promise<T> => {
    clock.check(what);
    let value: T | null = null;
    try {
      value = await read();
    } catch (err) {
      if (!transient(err) || failures + 1 >= TRANSIENT_READS) throw err;
    }
    if (value !== null && settled(value)) return value;
    const wait = pollWait(value?.retryAfterMs ?? null, attempt);
    if (clock.now() + wait > clock.deadline) throw timeoutError(what);
    await clock.sleep(wait);
    return step(attempt + 1, value === null ? failures + 1 : 0);
  };
  return await step(0, 0);
}

/**
 * Open the order; a `replaces` the authority refuses as already used is dropped
 * once.
 */
async function openOrder(
  client: AcmeClient,
  names: string[],
  replaces: string | undefined,
): Promise<AcmeOrder> {
  try {
    return await client.newOrder(names, replaces ? { replaces } : {});
  } catch (err) {
    if (
      replaces && err instanceof AcmeError && err.code === "already_replaced"
    ) {
      return await client.newOrder(names);
    }
    throw err;
  }
}

function challengeError(
  authz: AcmeAuthorization,
  type: string,
): AcmeError {
  const challenge = authz.challenges.find((item) => item.type === type);
  const problem = challenge?.error;
  const name = authz.identifier.value;
  const detail = problemDetail(
    problem,
    `the certificate authority did not accept the check for ${name}`,
  );
  const code = problemCode(problem);
  return new AcmeError(
    code === "unknown" ? "unauthorized" : code,
    `${name}: ${detail}`,
    null,
    null,
    name,
  );
}

type Presented = { authzUrl: string; challenge: AcmeChallenge; name: string };

async function presentAll(
  client: AcmeClient,
  order: AcmeOrder,
  solver: ChallengeSolver,
  presented: Presented[],
  solved: SolverChallenge[],
  clock: Clock,
): Promise<void> {
  await forEachSequential(order.authorizations, async (authzUrl) => {
    clock.check("putting the answers in place");
    const authz = await client.getAuthorization(authzUrl);
    if (authz.status === "valid") return;
    if (authz.status !== "pending") throw challengeError(authz, solver.type);
    const challenge = authz.challenges.find((item) =>
      item.type === solver.type
    );
    const name = authz.identifier.value;
    if (!challenge) {
      throw new LocalAcmeError(
        "unsupported",
        `the certificate authority offered no ${solver.type} check for ${name}`,
      );
    }
    const value = solver.type === "dns-01"
      ? await client.dnsValue(challenge.token)
      : await client.keyAuthorization(challenge.token);
    const entry = { name, token: challenge.token, value };
    solved.push(entry);
    await solver.present(entry);
    presented.push({ authzUrl, challenge, name });
  });
}

async function validateAll(
  client: AcmeClient,
  presented: readonly Presented[],
  solverType: string,
  clock: Clock,
): Promise<void> {
  await forEachSequential(presented, async (item) => {
    clock.check("taking the answers");
    if (item.challenge.status === "pending") {
      await client.answerChallenge(item.challenge.url);
    }
  });
  await forEachSequential(presented, async (item) => {
    const authz = await pollUntil(
      clock,
      () => client.getAuthorization(item.authzUrl),
      (value) => value.status !== "pending",
      `checking ${item.name}`,
    );
    if (authz.status !== "valid") throw challengeError(authz, solverType);
  });
}

function orderFailure(order: AcmeOrder): AcmeError {
  return new AcmeError(
    problemCode(order.error) === "unknown"
      ? "server"
      : problemCode(order.error),
    problemDetail(order.error, "the certificate authority gave up the order"),
  );
}

async function finalizeOrder(
  client: AcmeClient,
  order: AcmeOrder,
  names: string[],
  clock: Clock,
): Promise<IssuedChain> {
  const ready = await pollUntil(
    clock,
    () => client.getOrder(order.url),
    (value) => value.status !== "pending",
    "the checks",
  );
  if (ready.status === "invalid") throw orderFailure(ready);
  if (ready.status !== "ready") {
    // Finalized before this server sent its request: the key is not ours.
    throw new AcmeError(
      "server",
      "the certificate authority finished the order without this server's request",
    );
  }
  clock.check("the certificate");
  const key = await generateCertificateKey();
  const csr = await buildCertificateRequest({
    privateKey: key.privateKey,
    spki: key.spki,
    names,
  });
  let current = await client.finalize(order.url, ready.finalize, csr);
  const done = await pollUntil(
    clock,
    async () => {
      if (current.status === "processing") {
        current = await client.getOrder(order.url);
      }
      return current;
    },
    (value) => value.status !== "processing",
    "the certificate",
  );
  if (done.status !== "valid" || !done.certificate) {
    throw done.status === "invalid" ? orderFailure(done) : new AcmeError(
      "server",
      "the certificate authority did not hand over the certificate",
    );
  }
  clock.check("handing over the certificate");
  const certificatePem = await client.downloadCertificate(done.certificate);
  if (!certificatePem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new AcmeError(
      "server",
      "the certificate authority sent something that is not a certificate",
    );
  }
  return { certificatePem, privateKeyPem: key.privateKeyPem, names };
}

/**
 * Best effort: give up the authorizations still pending, so they stop counting
 * against limits.
 */
async function deactivatePending(
  client: AcmeClient,
  order: AcmeOrder | null,
): Promise<void> {
  if (!order) return;
  let outOfTime = false;
  await forEachSequential(order.authorizations, async (url) => {
    if (outOfTime) return;
    try {
      const authz = await client.getAuthorization(url);
      if (authz.status === "pending") {
        await client.deactivateAuthorization(url);
      }
    } catch (err) {
      const code = err instanceof AcmeError ? err.code : "error";
      outOfTime = code === "timeout";
      logWarn("deploy", `giving up an ACME authorization failed (${code})`);
    }
  });
}

async function removeAll(
  solver: ChallengeSolver,
  solved: readonly SolverChallenge[],
): Promise<void> {
  await forEachSequential(solved, async (entry) => {
    try {
      await solver.remove(entry);
    } catch (err) {
      logWarn("deploy", `removing an ACME challenge answer failed:`, err);
    }
  });
}

/**
 * Run one order. Throws {@link AcmeError} on every failure, with the
 * authority's wait when it gave one; on failure, authorizations still pending
 * are given up. The solver's answers are always removed before this returns.
 */
export async function runAcmeOrder(
  client: AcmeClient,
  input: OrderInput,
  solver: ChallengeSolver,
  deps: OrderDeps = {},
): Promise<IssuedChain> {
  const names = orderNames(input.names, solver.type);
  const clock = clockFor(deps);
  const bound = client.withSignal(clock.signal);
  const solved: SolverChallenge[] = [];
  let order: AcmeOrder | null = null;
  try {
    order = await openOrder(bound, names, input.replaces);
    if (order.status === "invalid") throw orderFailure(order);
    const presented: Presented[] = [];
    await presentAll(bound, order, solver, presented, solved, clock);
    await validateAll(bound, presented, solver.type, clock);
    return await finalizeOrder(bound, order, names, clock);
  } catch (err) {
    const accountGone = err instanceof AcmeError && err.code === "account_gone";
    if (!accountGone) {
      const budget = AbortSignal.timeout(ACME_DEACTIVATE_BUDGET_MS);
      await deactivatePending(client.withSignal(budget), order);
    }
    throw err;
  } finally {
    await removeAll(solver, solved);
  }
}
