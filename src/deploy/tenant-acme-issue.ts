/**
 * Server-placed certificate order for names the control plane hands this server
 * (`acme-issue-request`, features `acme-issue-v1` and `acme-issue-one-cert-v1`).
 *
 * The order is placed from this server's own addresses, over the HTTP proof,
 * by the daemon's own ACME client (`acme/issue.ts`): one certificate covers
 * every name of the request. It is not the hosting web server's built-in
 * client, which retries and renews on its own schedule; the control plane owns
 * the schedule. Earlier releases started a one-shot web server unit per order
 * (`turbopanel-tenant-acme@<request>.service`); nothing starts it any more, and
 * the start-up sweep still stops one an older release left running.
 *
 * Order of events: take the window lock, route the proof path for these names
 * to the request's socket inside each site's own port-80 block, answer a random
 * nonce on that socket and fetch it through this server and through every
 * helper's address with the right `Host` (a helper that cannot pass it on is
 * left out and costs no failed check), place the order with the answers served
 * on the same socket, report the pair to the control plane once per name with
 * the request id, then withdraw the routes. The ACME account stays under
 * `<state>/tenant-acme/account`: one per issuing server and contact address.
 *
 * Nothing here logs a certificate or key; failures are short plain reasons.
 */

import { join } from "@std/path";
import type { AcmeIssueRequestMessage } from "../contracts/cell-messages.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import {
  applyProofRoutes,
  localInterfaceAddresses,
  normalizeProofTarget,
  withdrawProofForwards,
} from "./acme-proof-forward.ts";
import { withHostingSitesLock } from "./ingress.ts";
import { plainInstanceAcmeFailure } from "./instance-acme-failure.ts";
import {
  defaultCommand,
  type InstanceAcmeCommand,
  instanceAcmePreflightNonce,
  withInstanceAcmeWindowLock,
  withPreflightServer,
} from "./instance-acme-http01.ts";
import {
  type DaemonIssueDeps,
  issueCertificateOverHttp01,
} from "./acme/issue.ts";

export const TENANT_ACME_SERVICE_PREFIX = "turbopanel-tenant-acme@";

/** How long the local proof routes of one request may stay (the order takes minutes). */
const LOCAL_ROUTE_TTL_MS = 15 * 60 * 1000;
const PROOF_FETCH_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CHALLENGE_PATH = "/.well-known/acme-challenge/";
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function tenantAcmeUnit(requestId: string): string {
  return `${TENANT_ACME_SERVICE_PREFIX}${requestId}.service`;
}

/**
 * Server-placed order state: `account/` holds this server's ACME accounts (one
 * per contact address); `requests/` and `caddy/` are what an older release's
 * one-shot issuer left, cleared by the start-up sweep (its `caddy/acme`
 * account folder is kept and no longer used).
 */
export function tenantAcmeDataDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "tenant-acme");
}

export function tenantAcmeCertificateRoot(layout: LayoutPaths): string {
  return join(tenantAcmeDataDir(layout), "caddy", "certificates");
}

export function tenantAcmeSocketPath(
  layout: LayoutPaths,
  requestId: string,
): string {
  return join(layout.runDir, `tenant-acme-${requestId}.sock`);
}

// --- a plain HTTP request with a chosen Host header ---------------------------

export type ProofResponse = { status: number; body: string };

export type ProofGet = (
  address: string,
  host: string,
  path: string,
  timeoutMs: number,
  port?: number,
) => Promise<ProofResponse>;

function chunkedBody(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const eol = rest.indexOf("\r\n");
    if (eol < 0) return out;
    const size = Number.parseInt(rest.slice(0, eol), 16);
    if (!Number.isFinite(size) || size === 0) return out;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
}

/** Parse a whole HTTP/1.1 response read until the connection closed. */
export function parseProofResponse(text: string): ProofResponse {
  const split = text.indexOf("\r\n\r\n");
  const head = split < 0 ? text : text.slice(0, split);
  const raw = split < 0 ? "" : text.slice(split + 4);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  const body = /^transfer-encoding:\s*chunked/im.test(head)
    ? chunkedBody(raw)
    : raw;
  return { status, body: body.trim() };
}

/**
 * `GET http://<address>:80<path>` with `Host: <host>`. Deno's `fetch` ignores a
 * custom `Host`, and the whole point is to reach a server by address while
 * asking for a name, so this speaks the request itself.
 */
type Connect = (opts: { hostname: string; port: number }) => Promise<Deno.Conn>;

/** Connect, giving up after `ms`; a connection that arrives late is closed. */
export function connectWithin(
  hostname: string,
  port: number,
  ms: number,
  connect: Connect = Deno.connect,
): Promise<Deno.Conn> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("connect timed out"));
    }, ms);
    connect({ hostname, port }).then((conn) => {
      if (settled) {
        conn.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(conn);
    }, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export const rawProofGet: ProofGet = async (
  address,
  host,
  path,
  timeoutMs,
  port = 80,
) => {
  // One bound for the whole request, connect included: a blackholed address
  // must not hold the order for the system's own connect timeout.
  const started = Date.now();
  const conn = await connectWithin(
    address,
    port,
    Math.min(timeoutMs, CONNECT_TIMEOUT_MS),
  );
  const timer = setTimeout(() => {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }, Math.max(1, timeoutMs - (Date.now() - started)));
  try {
    const request =
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: turbopaneld\r\n\r\n`;
    await conn.write(new TextEncoder().encode(request));
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of conn.readable) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length >= 65_536) break;
    }
    return parseProofResponse(text);
  } finally {
    clearTimeout(timer);
    try {
      conn.close();
    } catch {
      // closed by the timeout
    }
  }
};

async function answersNonce(
  get: ProofGet,
  address: string,
  host: string,
  nonce: string,
): Promise<boolean> {
  try {
    const res = await get(
      address,
      host,
      `${CHALLENGE_PATH}${nonce}`,
      PROOF_FETCH_TIMEOUT_MS,
    );
    return res.status === 200 && res.body === nonce;
  } catch {
    return false;
  }
}

async function answersHelper(
  get: ProofGet,
  address: string,
  host: string,
  nonce: string,
): Promise<boolean> {
  const target = normalizeProofTarget(address);
  return target !== null && await answersNonce(get, target, host, nonce);
}

/** This server answers `host` on one of its own addresses (a site may bind to just one). */
async function answersLocally(
  get: ProofGet,
  addresses: readonly string[],
  host: string,
  nonce: string,
): Promise<boolean> {
  const answers = await Promise.all(
    addresses.map((address) => answersNonce(get, address, host, nonce)),
  );
  return answers.some(Boolean);
}

/** Loopback first, then every other address the server has (never link-local). */
export function localProofAddresses(own: readonly string[]): string[] {
  const out = ["127.0.0.1"];
  for (const address of own) {
    const clean = normalizeProofTarget(address);
    if (clean !== null && !out.includes(clean)) out.push(clean);
  }
  return out;
}

// --- the order -------------------------------------------------------------------

export type TenantIssueDeps = {
  run?: InstanceAcmeCommand;
  now?: () => number;
  /** Reports one finished pair (`POST /tls/issued` with the request id). */
  report: (input: {
    hostname: string;
    certificatePem: string;
    privateKeyPem: string;
    requestId: string;
  }) => Promise<unknown>;
  proofGet?: ProofGet;
  nonce?: () => string;
  localAddresses?: () => string[];
  applyRoutes?: typeof applyProofRoutes;
  preflightServer?: typeof withPreflightServer;
  /** Places the order with this daemon's own client (test seam). */
  issueOwn?: typeof issueCertificateOverHttp01;
  /** Passed to the client: clock, sleep, and in tests an in-process authority. */
  acme?: DaemonIssueDeps;
};

export type TenantIssueOutcome =
  | { ok: true; notAfterIso: string; skippedHelpers: string[] }
  | { ok: false; reason: string };

class IssueStop extends Error {}

async function removeIfPresent(path: string, recursive = false): Promise<void> {
  try {
    await Deno.remove(path, { recursive });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Prove the proof path end to end before asking the authority: this server must
 * answer the nonce itself, and each helper must pass it on. Returns the helpers
 * that did not (they are left out of this attempt).
 */
async function proveRoutes(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
  deps: TenantIssueDeps,
  run: InstanceAcmeCommand,
): Promise<string[]> {
  const get = deps.proofGet ?? rawProofGet;
  const addresses = localProofAddresses(
    (deps.localAddresses ?? localInterfaceAddresses)(),
  );
  const skipped: string[] = [];
  const serve = deps.preflightServer ?? withPreflightServer;
  await forEachSequential(request.names, async (host) => {
    const nonce = (deps.nonce ?? instanceAcmePreflightNonce)();
    await serve(
      tenantAcmeSocketPath(layout, request.requestId),
      nonce,
      run,
      async () => {
        if (!(await answersLocally(get, addresses, host, nonce))) {
          throw new IssueStop(
            `this server did not answer the check for ${host} on port 80; check that the name's site is deployed here and that port 80 is open`,
          );
        }
        const helpers = await Promise.all(
          request.helpers.map(async (helper) => ({
            helper,
            // Same rule as the forward target: loopback, link-local, multicast,
            // unspecified and v4-mapped addresses never count as a proven helper
            // (a helper at 127.0.0.1 would answer from this very server).
            ok: await answersHelper(get, helper.address, host, nonce),
          })),
        );
        for (const { helper, ok } of helpers) {
          if (!ok && !skipped.includes(helper.serverId)) {
            skipped.push(helper.serverId);
          }
        }
      },
    );
  });
  return skipped;
}

/**
 * One certificate covers every name, and the control plane takes one pair per
 * name today, so the same pair goes out once for each name (a repeat for a
 * name the stored pair already covers only notes that the name is served).
 */
async function reportPair(
  pair: { certificatePem: string; privateKeyPem: string },
  request: AcmeIssueRequestMessage,
  deps: TenantIssueDeps,
): Promise<void> {
  await forEachSequential(request.names, async (hostname) => {
    try {
      await deps.report({
        hostname,
        certificatePem: pair.certificatePem,
        privateKeyPem: pair.privateKeyPem,
        requestId: request.requestId,
      });
    } catch (err) {
      // The status only: the request body (the pair) is never part of a message.
      const status = typeof err === "object" && err !== null &&
          "status" in err && typeof err.status === "number"
        ? ` (status ${err.status})`
        : "";
      throw new IssueStop(
        `the control plane did not accept the certificate for ${hostname}${status}`,
      );
    }
  });
}

/** Run one order from start to cleanup. Never throws; returns the outcome. */
export function issueTenantCertificates(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
  deps: TenantIssueDeps,
): Promise<TenantIssueOutcome> {
  return withInstanceAcmeWindowLock(() => runOrder(layout, request, deps));
}

async function runOrder(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
  deps: TenantIssueDeps,
): Promise<TenantIssueOutcome> {
  const run = deps.run ?? defaultCommand;
  const now = deps.now ?? Date.now;
  if (!SAFE_REQUEST_ID_RE.test(request.requestId)) {
    return { ok: false, reason: "the request id is not usable" };
  }
  if (Date.parse(request.startByIso) <= now()) {
    return { ok: false, reason: "the request was not started in time" };
  }
  const routes = deps.applyRoutes ?? applyProofRoutes;
  let routesApplied = false;
  try {
    const applied = await withHostingSitesLock(() =>
      routes(layout, {
        requestId: request.requestId,
        names: request.names,
        upstream: `unix/${tenantAcmeSocketPath(layout, request.requestId)}`,
        expiresAtIso: new Date(now() + LOCAL_ROUTE_TTL_MS).toISOString(),
      }, { run })
    );
    routesApplied = true;
    if (!applied.ok) throw new IssueStop(applied.reason);
    const skippedHelpers = await proveRoutes(layout, request, deps, run);
    const issue = deps.issueOwn ?? issueCertificateOverHttp01;
    const outcome = await issue(
      layout,
      request,
      tenantAcmeSocketPath(layout, request.requestId),
      { ...deps.acme, run },
    );
    // Already plain words; a rate limit says "rate limited", which the
    // control plane's one-hour wait keys on.
    if (!outcome.ok) throw new IssueStop(outcome.reason);
    await reportPair(outcome, request, deps);
    return { ok: true, notAfterIso: outcome.notAfterIso, skippedHelpers };
  } catch (err) {
    return { ok: false, reason: plainReason(err) };
  } finally {
    await cleanUp(layout, request, { run, routesApplied });
  }
}

function plainReason(err: unknown): string {
  if (err instanceof IssueStop) return err.message;
  return plainInstanceAcmeFailure(err instanceof Error ? err.message : "");
}

async function cleanUp(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
  state: { run: InstanceAcmeCommand; routesApplied: boolean },
): Promise<void> {
  const quiet = async (label: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      logWarn("deploy", `tenant ACME cleanup (${label}) failed:`, err);
    }
  };
  if (state.routesApplied) {
    await quiet("withdraw routes", async () => {
      await withHostingSitesLock(() =>
        withdrawProofForwards(layout, { requestId: request.requestId }, {
          run: state.run,
        })
      );
    });
  }
  await quiet(
    "delete request socket",
    () => removeIfPresent(tenantAcmeSocketPath(layout, request.requestId)),
  );
}

/**
 * At start-up, before any request is taken: clear what an older release's
 * one-shot issuer may have left. A daemon updated from such a release can find
 * an issuer unit still running with nobody to stop it, which would keep
 * retrying after its proof routes expire and leave a private key on disk. Stop
 * every `turbopanel-tenant-acme@*` unit and delete the per-request config and
 * logs, the certificates and keys it stored and the leftover request sockets.
 * The accounts stay: `account/` (this daemon's own client, one per contact
 * address) and the old issuer's `caddy/acme`.
 */
export async function sweepTenantAcme(
  layout: LayoutPaths,
  deps: {
    run?: InstanceAcmeCommand;
    stopUnit?: (
      unit: string,
      run: InstanceAcmeCommand,
    ) => Promise<Error | null>;
  } = {},
): Promise<void> {
  const run = deps.run ?? defaultCommand;
  const stop = deps.stopUnit ?? stopUnit;
  await withInstanceAcmeWindowLock(async () => {
    const listed = await run("systemctl", [
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      `${TENANT_ACME_SERVICE_PREFIX}*`,
    ]);
    const units = listed.stdout.split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((name) =>
        name.startsWith(TENANT_ACME_SERVICE_PREFIX) &&
        /^[A-Za-z0-9_@.-]+$/.test(name)
      );
    await forEachSequential(units, async (unit) => {
      const problem = await stop(unit, run);
      if (problem) logWarn("deploy", `stopping ${unit} failed:`, problem);
    });
    await removeIfPresent(join(tenantAcmeDataDir(layout), "requests"), true);
    await removeIfPresent(tenantAcmeCertificateRoot(layout), true);
    await removeSockets(layout.runDir);
  });
}

/** `systemctl stop` through tp-host; the problem, or null when it stopped. */
async function stopUnit(
  unit: string,
  run: InstanceAcmeCommand,
): Promise<Error | null> {
  const result = await run(
    "sudo",
    hostSudoArgs(["-n", "systemctl", "stop", unit]),
  );
  return result.ok
    ? null
    : new Error(result.stderr.trim() || `could not stop ${unit}`);
}

async function removeSockets(runDir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(runDir)) {
      if (/^tenant-acme-[A-Za-z0-9_-]+\.sock$/.test(entry.name)) {
        await removeIfPresent(join(runDir, entry.name));
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}
