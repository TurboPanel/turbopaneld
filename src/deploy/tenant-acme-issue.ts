/**
 * One-shot certificate order for names the control plane hands this server
 * (`acme-issue-request`, feature `acme-issue-v1`).
 *
 * The order is placed from this server's own addresses, over the HTTP proof,
 * by a second Caddy started for this request only
 * (`turbopanel-tenant-acme@<request>.service`, the same shape as the control
 * plane's own issuer in `instance-acme-http01.ts`). It is not the hosting web
 * server's built-in client, which retries and renews on its own schedule; the
 * control plane owns the schedule.
 *
 * Order of events: take the window lock, clear any leftover storage for the
 * names (so a pair found afterwards is new), route the proof path for these
 * names to the issuer socket inside each site's own port-80 block, answer a
 * random nonce on that socket and fetch it through this server and through every
 * helper's address with the right `Host` (a helper that cannot pass it on is
 * left out and costs no failed check), start the issuer, wait for a pair per
 * name, report each pair to the control plane with the request id, then stop the
 * issuer, withdraw the routes and delete the certificates it stored. The ACME
 * account stays in the issuer's storage: one account per issuing server, made on
 * first use.
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
  delay,
  findIssuedPair,
  grantInstanceAcmeSocket,
  type InstanceAcmeCommand,
  instanceAcmePreflightNonce,
  readFilePrivileged,
  removeLeftoverPreflightSocket,
  withInstanceAcmeWindowLock,
  withPreflightServer,
} from "./instance-acme-http01.ts";
import {
  inspectIssuerCertificatePem,
  INSTANCE_ACME_ISSUE_TIMEOUT_MS,
  instanceAcmeIssuerConfig,
  instanceAcmeIssuerFailureLine,
  instanceAcmeIssuerKey,
  instanceAcmeProblem,
  LETS_ENCRYPT_DIRECTORY_URL,
  LETS_ENCRYPT_STAGING_DIRECTORY_URL,
} from "./instance-acme-issuer.ts";

export const TENANT_ACME_SERVICE_PREFIX = "turbopanel-tenant-acme@";

/** How long the local proof routes of one request may stay (the order takes minutes). */
const LOCAL_ROUTE_TTL_MS = 15 * 60 * 1000;
const PROOF_FETCH_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 10_000;
const POLL_MS = 500;
const CHALLENGE_PATH = "/.well-known/acme-challenge/";
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function tenantAcmeUnit(requestId: string): string {
  return `${TENANT_ACME_SERVICE_PREFIX}${requestId}.service`;
}

/** The issuer's storage; its `caddy/acme` folder holds this server's one account. */
export function tenantAcmeDataDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "tenant-acme");
}

export function tenantAcmeCertificateRoot(layout: LayoutPaths): string {
  return join(tenantAcmeDataDir(layout), "caddy", "certificates");
}

export function tenantAcmeConfigPath(
  layout: LayoutPaths,
  requestId: string,
): string {
  return join(tenantAcmeDataDir(layout), "requests", `${requestId}.json`);
}

export function tenantAcmeSocketPath(
  layout: LayoutPaths,
  requestId: string,
): string {
  return join(layout.runDir, `tenant-acme-${requestId}.sock`);
}

/** Next to the request's config, so the daemon (the issuer's account) always owns it. */
export function tenantAcmeLogPath(
  layout: LayoutPaths,
  requestId: string,
): string {
  return join(tenantAcmeDataDir(layout), "requests", `${requestId}.log`);
}

/** The issuer config for one request: its names, this server's account, the socket. */
export function tenantAcmeIssuerConfig(
  layout: LayoutPaths,
  request: Pick<
    AcmeIssueRequestMessage,
    "requestId" | "names" | "directory" | "contactEmail"
  >,
): Record<string, unknown> {
  return instanceAcmeIssuerConfig({
    hosts: request.names,
    instanceAcme: tenantAcmeSettings(request),
    socketPath: tenantAcmeSocketPath(layout, request.requestId),
    logFile: tenantAcmeLogPath(layout, request.requestId),
  });
}

function tenantAcmeSettings(
  request: Pick<AcmeIssueRequestMessage, "directory"> & {
    contactEmail?: string;
  },
) {
  return {
    contactEmail: request.contactEmail ?? "",
    // The control plane only asks once the organization has accepted the terms.
    tosAccepted: true,
    directoryUrl: request.directory === "staging"
      ? LETS_ENCRYPT_STAGING_DIRECTORY_URL
      : LETS_ENCRYPT_DIRECTORY_URL,
    useStaging: request.directory === "staging",
  };
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
  sleep?: (ms: number) => Promise<void>;
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
  timeoutMs?: number;
  readLog?: () => Promise<string>;
  applyRoutes?: typeof applyProofRoutes;
  preflightServer?: typeof withPreflightServer;
  startUnit?: (unit: string, run: InstanceAcmeCommand) => Promise<void>;
  stopUnit?: (unit: string, run: InstanceAcmeCommand) => Promise<Error | null>;
  /** True while this request's issuer unit is running. */
  isUnitActive?: (unit: string, run: InstanceAcmeCommand) => Promise<boolean>;
};

export type TenantIssueOutcome =
  | { ok: true; notAfterIso: string; skippedHelpers: string[] }
  | { ok: false; reason: string };

class IssueStop extends Error {}

async function systemctlUnit(
  verb: "start" | "stop",
  unit: string,
  run: InstanceAcmeCommand,
): Promise<string | null> {
  const result = await run(
    "sudo",
    verb === "start"
      ? hostSudoArgs(["-n", "systemctl", "start", unit])
      : hostSudoArgs(["-n", "systemctl", "stop", unit]),
  );
  return result.ok ? null : result.stderr.trim() || `could not ${verb} ${unit}`;
}

async function defaultStart(
  unit: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  const problem = await systemctlUnit("start", unit, run);
  if (problem !== null) throw new Error(problem);
}

async function defaultStop(
  unit: string,
  run: InstanceAcmeCommand,
): Promise<Error | null> {
  const problem = await systemctlUnit("stop", unit, run);
  return problem === null ? null : new Error(problem);
}

async function defaultIsActive(
  unit: string,
  run: InstanceAcmeCommand,
): Promise<boolean> {
  const result = await run("systemctl", ["is-active", unit]);
  return ["active", "activating", "reloading"].includes(result.stdout.trim());
}

async function removeIfPresent(path: string, recursive = false): Promise<void> {
  try {
    await Deno.remove(path, { recursive });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** Delete the certificates and keys the issuer stored for these names. The account stays. */
export async function deleteTenantCertificates(
  layout: LayoutPaths,
  request: Pick<AcmeIssueRequestMessage, "names" | "directory">,
): Promise<void> {
  const issuerKey = instanceAcmeIssuerKey(tenantAcmeSettings(request));
  await forEachSequential(request.names, async (host) => {
    if (!/^[a-z0-9.-]+$/.test(host)) return;
    await removeIfPresent(
      join(tenantAcmeCertificateRoot(layout), issuerKey, host),
      true,
    );
  });
}

type Found = { host: string; crt: string; key: string; notAfterMs: number };

async function pairsReady(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
  issuerKey: string,
  nowMs: number,
  run: InstanceAcmeCommand,
): Promise<Found[] | null> {
  const found = await Promise.all(
    request.names.map(async (host): Promise<Found | null> => {
      const pair = await findIssuedPair(
        tenantAcmeCertificateRoot(layout),
        host,
        issuerKey,
      );
      if (!pair) return null;
      const pem = new TextDecoder().decode(
        await readFilePrivileged(pair.crt, run),
      );
      const info = inspectIssuerCertificatePem(pem, nowMs);
      if (!info?.valid) return null;
      return { host, ...pair, notAfterMs: Date.parse(info.notAfter) };
    }),
  );
  return found.every((pair) => pair !== null) ? found : null;
}

function waitForPairs(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
  issuerKey: string,
  deps: TenantIssueDeps,
  run: InstanceAcmeCommand,
): Promise<Found[]> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const timeoutMs = deps.timeoutMs ?? INSTANCE_ACME_ISSUE_TIMEOUT_MS;
  const started = now();
  const readLog = deps.readLog ??
    (() => readLogFile(tenantAcmeLogPath(layout, request.requestId)));
  const poll = async (): Promise<Found[]> => {
    const failure = instanceAcmeIssuerFailureLine(await readLog());
    if (failure) throw new Error(`issuer failed: ${failure}`);
    const ready = await pairsReady(layout, request, issuerKey, now(), run);
    if (ready) return ready;
    if (now() - started >= timeoutMs) {
      throw new Error("instance ACME issuer timed out");
    }
    await sleep(POLL_MS);
    return poll();
  };
  return poll();
}

async function readLogFile(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

async function writeIssuerFiles(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
): Promise<void> {
  const config = tenantAcmeConfigPath(layout, request.requestId);
  await Deno.mkdir(join(tenantAcmeDataDir(layout), "requests"), {
    recursive: true,
    mode: 0o750,
  });
  await Deno.writeTextFile(
    config,
    `${JSON.stringify(tenantAcmeIssuerConfig(layout, request), null, 2)}\n`,
    { mode: 0o640 },
  );
  await Deno.writeTextFile(tenantAcmeLogPath(layout, request.requestId), "", {
    mode: 0o640,
  });
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
            ok: await answersNonce(get, helper.address, host, nonce),
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

async function reportPairs(
  found: readonly Found[],
  request: AcmeIssueRequestMessage,
  deps: TenantIssueDeps,
  run: InstanceAcmeCommand,
): Promise<void> {
  const decode = async (path: string) =>
    new TextDecoder().decode(await readFilePrivileged(path, run));
  await forEachSequential(found, async (pair) => {
    try {
      await deps.report({
        hostname: pair.host,
        certificatePem: await decode(pair.crt),
        privateKeyPem: await decode(pair.key),
        requestId: request.requestId,
      });
    } catch (err) {
      // The status only: the request body (the pair) is never part of a message.
      const status = typeof err === "object" && err !== null &&
          "status" in err && typeof err.status === "number"
        ? ` (status ${err.status})`
        : "";
      throw new IssueStop(
        `the control plane did not accept the certificate for ${pair.host}${status}`,
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
  const unit = tenantAcmeUnit(request.requestId);
  // A live issuer for this very request (a re-send while it works): leave it,
  // its socket and its files alone. Starting again would do nothing, and
  // clearing the leftover socket would cut the live issuer off.
  if (await (deps.isUnitActive ?? defaultIsActive)(unit, run)) {
    return {
      ok: false,
      reason: "an order for this request is already running",
    };
  }
  const stop = deps.stopUnit ?? defaultStop;
  const routes = deps.applyRoutes ?? applyProofRoutes;
  let routesApplied = false;
  let unitStarted = false;
  try {
    // Anything left from an earlier try is cleared first, so a pair found below
    // is certainly this order's and always carries a fresh key.
    await deleteTenantCertificates(layout, request);
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
    await writeIssuerFiles(layout, request);
    await removeLeftoverPreflightSocket(
      tenantAcmeSocketPath(layout, request.requestId),
    );
    unitStarted = true;
    await (deps.startUnit ?? defaultStart)(unit, run);
    await grantInstanceAcmeSocket(
      tenantAcmeSocketPath(layout, request.requestId),
      run,
    );
    const issuerKey = instanceAcmeIssuerKey(tenantAcmeSettings(request));
    const found = await waitForPairs(layout, request, issuerKey, deps, run);
    await reportPairs(found, request, deps, run);
    const notAfterMs = Math.min(...found.map((pair) => pair.notAfterMs));
    return {
      ok: true,
      notAfterIso: new Date(notAfterMs).toISOString(),
      skippedHelpers,
    };
  } catch (err) {
    return { ok: false, reason: plainReason(err) };
  } finally {
    await cleanUp(layout, request, {
      run,
      unit,
      stop,
      unitStarted,
      routesApplied,
    });
  }
}

/**
 * The control plane waits about an hour on a reason that says "rate limited", so
 * orders from this server say it in those words (the shared text for the
 * control plane's own names reads differently).
 */
const RATE_LIMITED_REASON =
  "Let's Encrypt has rate limited this name; it will be retried in about an hour (a week for repeated certificates)";

function plainReason(err: unknown): string {
  if (err instanceof IssueStop) return err.message;
  if (
    err instanceof Error && instanceAcmeProblem(err.message) === "rate-limited"
  ) {
    return RATE_LIMITED_REASON;
  }
  return plainInstanceAcmeFailure(err instanceof Error ? err.message : "");
}

async function cleanUp(
  layout: LayoutPaths,
  request: AcmeIssueRequestMessage,
  state: {
    run: InstanceAcmeCommand;
    unit: string;
    stop: NonNullable<TenantIssueDeps["stopUnit"]>;
    unitStarted: boolean;
    routesApplied: boolean;
  },
): Promise<void> {
  const quiet = async (label: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      logWarn("deploy", `tenant ACME cleanup (${label}) failed:`, err);
    }
  };
  if (state.unitStarted) {
    await quiet("stop issuer", async () => {
      const problem = await state.stop(state.unit, state.run);
      if (problem) throw problem;
    });
  }
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
    "delete certificates",
    () => deleteTenantCertificates(layout, request),
  );
  await quiet("delete request files", async () => {
    await removeIfPresent(tenantAcmeConfigPath(layout, request.requestId));
    await removeIfPresent(tenantAcmeLogPath(layout, request.requestId));
    await removeIfPresent(tenantAcmeSocketPath(layout, request.requestId));
  });
}

/**
 * At start-up, before any request is taken: a daemon restart (the hourly update
 * check restarts it) can leave an issuer running with nobody to stop it, which
 * would keep retrying after its proof routes expire and leave a private key on
 * disk. Stop every issuer unit and delete the per-request config and logs, the
 * stored certificates and keys and the leftover sockets. The shared account
 * store (`caddy/acme`) stays, so the server keeps its one ACME account.
 */
export async function sweepTenantAcme(
  layout: LayoutPaths,
  deps: {
    run?: InstanceAcmeCommand;
    stopUnit?: TenantIssueDeps["stopUnit"];
  } = {},
): Promise<void> {
  const run = deps.run ?? defaultCommand;
  const stop = deps.stopUnit ?? defaultStop;
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
