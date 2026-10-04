/**
 * Short-lived HTTP-01 window for the control plane's Let's Encrypt names.
 *
 * Hosting Caddy owns port 80 while the issuer runs. The reserved site
 * forwards only `/.well-known/acme-challenge/*` to the issuer socket and
 * answers every other path with 404. The issuer is not enabled; this
 * process starts and stops it. When the window closes, the reserved site
 * is removed. If that leaves only daemon-reserved sites, hosting Caddy is
 * disabled.
 */

import { dirname, join } from "@std/path";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import type { InstanceAcmeWireSettings } from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { instanceSiteHostname } from "../instance/instance-acme-observe.ts";
import { HOSTING_CADDY_USER } from "./ensure-hosting-caddy.ts";
import {
  HOSTING_CADDY_SERVICE,
  inspectIssuerCertificatePem,
  INSTANCE_ACME_CERT_GROUP,
  INSTANCE_ACME_HTTP01_ISSUER_UNREACHABLE,
  INSTANCE_ACME_ISSUE_TIMEOUT_MS,
  INSTANCE_ACME_SERVICE,
  type InstanceAcmeCertificateBaseline,
  instanceAcmeCertificateRoot,
  instanceAcmeConfigPath,
  instanceAcmeHostSettled,
  instanceAcmeIssuerFailureLine,
  instanceAcmeIssuerKey,
  instanceAcmeLogPath,
  instanceAcmeSettingsPath,
  instanceAcmeSocketPath,
  renderInstanceAcmeIssuerConfig,
  renderInstanceAcmeSettings,
} from "./instance-acme-issuer.ts";

export const INSTANCE_ACME_HTTP01_SITE = "00-instance-acme-http01.caddy";

/** Control-plane Caddy unit. `ExecReload` already passes `--force`. */
export const CONTROL_PLANE_CADDY_SERVICE = "turbopanel-caddy.service";

/**
 * One HTTP-01 window at a time.
 *
 * `applyPublicUrls` and the renewal scheduler both open this window.
 * Callers must not take the lock again from inside `fn` — that waits on
 * itself. A rejected `fn` still releases the next waiter.
 */
let instanceAcmeWindowTail: Promise<void> = Promise.resolve();

export async function withInstanceAcmeWindowLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const previous = instanceAcmeWindowTail;
  let release: () => void = () => {};
  instanceAcmeWindowTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
  } catch {
    // A failed window must not block the next one.
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** The account the panel's Caddy runs as; it must be able to read its key. */
export const CONTROL_PLANE_CADDY_USER = "tpcaddy";

export async function reloadControlPlaneCaddy(
  deps: { run?: InstanceAcmeCommand } = {},
): Promise<void> {
  const run = deps.run ?? defaultCommand;
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "reload",
      CONTROL_PLANE_CADDY_SERVICE,
    ]),
  );
  if (!result.ok) {
    throw new Error(
      result.stderr.trim() || "control-plane Caddy reload failed",
    );
  }
}

/** Hosting site fragments tenant sweeps must never delete. */
export const DAEMON_RESERVED_HOSTING_SITES = new Set([
  "00-empty.caddy",
  INSTANCE_ACME_HTTP01_SITE,
]);

export const INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX =
  "Let's Encrypt HTTP-01 preflight failed for ";

const CHALLENGE_PREFIX = "/.well-known/acme-challenge/";
const PREFLIGHT_TIMEOUT_MS = 8_000;
const POLL_MS = 500;
/**
 * `Type=simple` reports hosting Caddy active as soon as `caddy run` is
 * forked. `:80` (and the admin socket) bind a few milliseconds later. Bounded
 * by attempts so an injected `sleep` keeps tests instant.
 */
const HOSTING_CADDY_READY_ATTEMPTS = 20;
const HOSTING_CADDY_READY_INTERVAL_MS = 50;

export function isDaemonReservedHostingSite(name: string): boolean {
  return DAEMON_RESERVED_HOSTING_SITES.has(name);
}

export function port80HeldMessage(processName: string): string {
  return `port 80 is held by ${processName}`;
}

export type Port80Listener = { process: string; pid: number };

export type Port80Holder =
  | { kind: "free" }
  | { kind: "hosting-caddy" }
  | { kind: "other"; process: string };

export function parseSsListeners(text: string): Port80Listener[] {
  const byPid = new Map<number, string>();
  const unknown: Port80Listener[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const matches = [...line.matchAll(/\("([^"]+)",pid=(\d+)/g)];
    if (matches.length === 0) {
      unknown.push({ process: "unknown", pid: -(unknown.length + 1) });
      continue;
    }
    for (const match of matches) {
      const name = match[1];
      const pid = Number(match[2]);
      if (!name || !Number.isInteger(pid)) continue;
      byPid.set(pid, name);
    }
  }
  const listeners = [...byPid.entries()].map(([pid, process]) => ({
    process,
    pid,
  }));
  listeners.sort((a, b) => a.pid - b.pid);
  return listeners.concat(unknown);
}

export function classifyPort80(
  listeners: readonly Port80Listener[],
  hostingPid: number | null,
): Port80Holder {
  if (listeners.length === 0) return { kind: "free" };
  if (hostingPidOwns(listeners, hostingPid)) return { kind: "hosting-caddy" };
  const names = [...new Set(listeners.map((item) => item.process))];
  names.sort((a, b) => a.localeCompare(b));
  return { kind: "other", process: names.join(", ") };
}

function hostingPidOwns(
  listeners: readonly Port80Listener[],
  hostingPid: number | null,
): boolean {
  if (hostingPid === null || hostingPid <= 0) return false;
  return listeners.every((item) => item.pid === hostingPid);
}

export type CommandResult = { ok: boolean; stdout: string; stderr: string };

export type InstanceAcmeCommand = (
  program: string,
  args: readonly string[],
  stdin?: string,
) => Promise<CommandResult>;

async function defaultCommand(
  program: string,
  args: readonly string[],
  stdin?: string,
): Promise<CommandResult> {
  const cmd = new Deno.Command(program, {
    args: [...args],
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  if (stdin !== undefined) {
    const pipe = child.stdin;
    if (!pipe) throw new TypeError(`${program} stdin was not piped`);
    const writer = pipe.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const result = await child.output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    ok: result.success,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

async function inspectPort80(run: InstanceAcmeCommand): Promise<Port80Holder> {
  const sudo = await run(
    "sudo",
    hostSudoArgs(["-n", "ss", "-H", "-ltnp", "sport = :80"]),
  );
  const listed = sudo.ok
    ? sudo
    : await run("ss", ["-H", "-ltnp", "sport = :80"]);
  if (!sudo.ok && !listed.ok) {
    throw new Error("port 80 inspection failed");
  }
  const pidText = await run("systemctl", [
    "show",
    "-p",
    "MainPID",
    "--value",
    HOSTING_CADDY_SERVICE,
  ]);
  return classifyPort80(
    parseSsListeners(listed.stdout),
    hostingPid(pidText.stdout),
  );
}

function hostingPid(text: string): number | null {
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

function hostingSitesDir(layout: LayoutPaths): string {
  return join(layout.configDir, "hosting", "sites");
}

export function renderInstanceAcmeHttp01Site(
  hosts: readonly string[],
  socketPath: string,
): string {
  const blocks = [...hosts].sort((a, b) => a.localeCompare(b)).map((host) =>
    http01Block(host, socketPath)
  );
  return blocks.join("\n");
}

function http01Block(host: string, socketPath: string): string {
  return `http://${host} {
	handle /.well-known/acme-challenge/* {
		reverse_proxy unix/${socketPath} {
			header_up Host {http.request.host}
		}
	}
	handle {
		respond 404
	}
}
`;
}

async function ensureHostingCaddy(layout: LayoutPaths): Promise<void> {
  const mod = await import("./ingress.ts");
  await mod.ensureHostingCaddyRuntime(layout);
}

export async function openInstanceAcmeWindow(
  layout: LayoutPaths,
  hosts: readonly string[],
  deps: {
    run?: InstanceAcmeCommand;
    ensureHostingCaddyRuntime?: (layout: LayoutPaths) => Promise<void>;
    inspect?: () => Promise<Port80Holder>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const run = deps.run ?? defaultCommand;
  const inspect = deps.inspect ?? (() => inspectPort80(run));
  const ensure = deps.ensureHostingCaddyRuntime ?? ensureHostingCaddy;
  const sleepFn = deps.sleep ?? delay;
  const dest = join(hostingSitesDir(layout), INSTANCE_ACME_HTTP01_SITE);
  let startedRuntime = false;
  let wroteSite = false;
  try {
    const holder = await inspect();
    if (holder.kind === "other") {
      throw new Error(port80HeldMessage(holder.process));
    }
    // Write before start: the unit is Type=simple, so enable --now returns
    // before the admin socket exists. ExecReload then fails with connection
    // refused. A first start must load this snippet as the initial config.
    wroteSite = true;
    await writeTextPrivileged(
      dest,
      renderInstanceAcmeHttp01Site(hosts, instanceAcmeSocketPath(layout)),
      run,
    );
    startedRuntime = await activateHostingCaddyForWindow(
      holder,
      layout,
      ensure,
      run,
    );
    const after = await waitForHostingCaddyOn80(inspect, sleepFn);
    if (after.kind === "other") {
      throw new Error(port80HeldMessage(after.process));
    }
    if (after.kind !== "hosting-caddy") {
      throw new Error("hosting Caddy is not listening on port 80");
    }
  } catch (err) {
    await rollbackOpenedWindow(dest, startedRuntime, wroteSite, run);
    throw err;
  }
}

async function activateHostingCaddyForWindow(
  holder: Port80Holder,
  layout: LayoutPaths,
  ensure: (layout: LayoutPaths) => Promise<void>,
  run: InstanceAcmeCommand,
): Promise<boolean> {
  if (holder.kind === "hosting-caddy") {
    await reloadHostingCaddy(run);
    return false;
  }
  await ensure(layout);
  return true;
}

async function waitForHostingCaddyOn80(
  inspect: () => Promise<Port80Holder>,
  sleepFn: (ms: number) => Promise<void>,
  attempt = 0,
): Promise<Port80Holder> {
  const last = await inspect();
  if (last.kind !== "free" || attempt >= HOSTING_CADDY_READY_ATTEMPTS - 1) {
    return last;
  }
  await sleepFn(HOSTING_CADDY_READY_INTERVAL_MS);
  return waitForHostingCaddyOn80(inspect, sleepFn, attempt + 1);
}

async function rollbackOpenedWindow(
  dest: string,
  startedRuntime: boolean,
  wroteSite: boolean,
  run: InstanceAcmeCommand,
): Promise<void> {
  if (wroteSite) {
    try {
      await removeSite(dest);
    } catch (err) {
      logWarn("deploy", "instance ACME site rollback failed:", err);
    }
  }
  if (!startedRuntime) return;
  try {
    await disableHostingCaddy(run);
  } catch (err) {
    logWarn("deploy", "instance ACME runtime rollback failed:", err);
  }
}

export async function closeInstanceAcmeWindow(
  layout: LayoutPaths,
  deps: { run?: InstanceAcmeCommand } = {},
): Promise<void> {
  const run = deps.run ?? defaultCommand;
  const sitesDir = hostingSitesDir(layout);
  if (!(await directoryExists(sitesDir))) return;
  await removeSite(join(sitesDir, INSTANCE_ACME_HTTP01_SITE));
  if (await sitesHoldOnlyReserved(sitesDir)) {
    await disableHostingCaddy(run);
    // A tenant deploy does not take the window lock: it may have written its
    // site between the check above and the disable. Look again and put hosting
    // Caddy back rather than leave that site offline (the deploy side also
    // enables Caddy after writing a site, so either order ends running).
    if (!(await sitesHoldOnlyReserved(sitesDir))) {
      await enableHostingCaddy(run);
    }
    return;
  }
  await reloadHostingCaddy(run);
}

async function sitesHoldOnlyReserved(dir: string): Promise<boolean> {
  for await (const entry of Deno.readDir(dir)) {
    if (!isDaemonReservedHostingSite(entry.name)) return false;
  }
  return true;
}

async function reloadHostingCaddy(run: InstanceAcmeCommand): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "reload",
      HOSTING_CADDY_SERVICE,
    ]),
  );
  if (!result.ok) {
    throw new Error(result.stderr.trim() || "hosting Caddy reload failed");
  }
}

async function enableHostingCaddy(run: InstanceAcmeCommand): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "enable",
      "--now",
      HOSTING_CADDY_SERVICE,
    ]),
  );
  if (!result.ok) {
    throw new Error(result.stderr.trim() || "hosting Caddy enable failed");
  }
}

async function disableHostingCaddy(run: InstanceAcmeCommand): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "disable",
      "--now",
      HOSTING_CADDY_SERVICE,
    ]),
  );
  if (!result.ok) {
    throw new Error(result.stderr.trim() || "hosting Caddy disable failed");
  }
}

export class InstanceAcmeHttp01PreflightError extends Error {
  constructor(hostname: string, detail: string) {
    super(`${INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX}${hostname}: ${detail}`);
    this.name = "InstanceAcmeHttp01PreflightError";
  }
}

export function instanceAcmePreflightDetail(
  url: string,
  reason: string,
): string {
  return `${url} ${INSTANCE_ACME_HTTP01_ISSUER_UNREACHABLE} (${reason})`;
}

export function instanceAcmePreflightNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function preflightHttpResponse(
  path: string,
  nonce: string,
): { status: number; body: string } {
  if (path === `${CHALLENGE_PREFIX}${nonce}`) {
    return { status: 200, body: nonce };
  }
  return { status: 404, body: "" };
}

export function letsEncryptHostnames(
  hostnames: readonly { host: string; source: string }[],
): string[] {
  const hosts: string[] = [];
  for (const entry of hostnames) {
    if (entry.source !== "lets-encrypt") continue;
    const hostname = instanceSiteHostname(entry.host);
    if (!hostname) {
      throw new InstanceAcmeHttp01PreflightError(
        entry.host,
        instanceAcmePreflightDetail(
          `http://${entry.host}${CHALLENGE_PREFIX}`,
          "hostname is not a DNS name",
        ),
      );
    }
    hosts.push(hostname);
  }
  return hosts;
}

type ChallengeRead = { ok: true; body: string } | {
  ok: false;
  summary: string;
};

function challengeMismatch(read: ChallengeRead, nonce: string): string | null {
  if (!read.ok) return read.summary;
  if (read.body !== nonce) return "body did not match the nonce";
  return null;
}

async function readChallenge(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<ChallengeRead> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.text()).trim();
    if (res.status !== 200) return { ok: false, summary: `HTTP ${res.status}` };
    return { ok: true, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: message };
  }
}

export async function verifyInstanceAcmeHttp01Reachability(
  hostname: string,
  nonce: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const publicUrl = `http://${hostname}${CHALLENGE_PREFIX}${nonce}`;
  const remote = await readChallenge(fetchImpl, publicUrl, timeoutMs);
  const mismatch = challengeMismatch(remote, nonce);
  if (!mismatch) return;
  throw new InstanceAcmeHttp01PreflightError(
    hostname,
    instanceAcmePreflightDetail(publicUrl, mismatch),
  );
}

/**
 * The one ACL entry that lets hosting Caddy ({@link HOSTING_CADDY_USER}, not
 * in group tp) connect to the issuer socket. Connecting needs write on the
 * socket inode; the hosting-caddy role grants traverse (`x`) on the run
 * directory, and nothing else in it.
 */
export const INSTANCE_ACME_SOCKET_ACL = `u:${HOSTING_CADDY_USER}:rw`;

/**
 * Let hosting Caddy reach the issuer socket. Whoever binds it (the daemon's
 * preflight listener, or the issuer Caddy as tpcaddy) is not root and cannot
 * name another user in an ACL, so tp-host adds exactly this entry, waiting
 * briefly for the issuer to bind. `-P`: a swapped-in symlink is never followed.
 */
export async function grantInstanceAcmeSocket(
  socketPath: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "setfacl",
      "-P",
      "-m",
      INSTANCE_ACME_SOCKET_ACL,
      socketPath,
    ]),
  );
  if (!result.ok) {
    throw new Error(
      result.stderr.trim() ||
        `could not let ${HOSTING_CADDY_USER} reach ${socketPath}`,
    );
  }
}

async function withPreflightServer(
  socketPath: string,
  nonce: string,
  run: InstanceAcmeCommand,
  body: () => Promise<void>,
): Promise<void> {
  await removeSite(socketPath);
  const listener = Deno.listen({ transport: "unix", path: socketPath });
  await Deno.chmod(socketPath, 0o660).catch(() => undefined);
  const serving = acceptPreflight(listener, nonce);
  try {
    await grantInstanceAcmeSocket(socketPath, run);
    await body();
  } finally {
    listener.close();
    await serving.catch(() => undefined);
    await removeSite(socketPath);
  }
}

async function acceptPreflight(
  listener: Deno.Listener,
  nonce: string,
): Promise<void> {
  let conn: Deno.Conn;
  try {
    conn = await listener.accept();
  } catch {
    return;
  }
  try {
    await answerPreflight(conn, nonce);
  } finally {
    conn.close();
  }
  return acceptPreflight(listener, nonce);
}

async function answerPreflight(conn: Deno.Conn, nonce: string): Promise<void> {
  const path = await readRequestPath(conn);
  const response = preflightHttpResponse(path, nonce);
  const reason = response.status === 200 ? "OK" : "Not Found";
  const payload =
    `HTTP/1.1 ${response.status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${response.body.length}\r\nConnection: close\r\n\r\n${response.body}`;
  await conn.write(new TextEncoder().encode(payload));
}

async function readRequestPath(conn: Deno.Conn): Promise<string> {
  const buf = new Uint8Array(4096);
  let text = "";
  while (!text.includes("\r\n\r\n") && text.length < 8192) {
    const n = await conn.read(buf);
    if (n === null) break;
    text += new TextDecoder().decode(buf.subarray(0, n));
  }
  const line = text.split("\r\n", 1)[0] ?? "";
  const match = /^[A-Z]+\s+(\S+)\s+HTTP\//.exec(line);
  const path = match?.[1] ?? "";
  const query = path.indexOf("?");
  if (query < 0) return path;
  return path.slice(0, query);
}

export type InstanceAcmeHttp01PreflightDeps = {
  run?: InstanceAcmeCommand;
  fetchImpl?: typeof fetch;
  nonce?: () => string;
  timeoutMs?: number;
};

/**
 * Prove `http://<host>/.well-known/acme-challenge/<nonce>` reaches the
 * issuer socket through hosting Caddy. The nonce is served on the socket
 * only for this check.
 */
export async function preflightInstanceLetsEncryptHttp01(
  hostnames: readonly { host: string; source: string }[],
  layout: LayoutPaths,
  deps: InstanceAcmeHttp01PreflightDeps = {},
): Promise<void> {
  const hosts = letsEncryptHostnames(hostnames);
  const socketPath = instanceAcmeSocketPath(layout);
  const run = deps.run ?? defaultCommand;
  // One shared issuer socket: hosts are probed one at a time, stopping at the
  // first failure.
  await forEachSequential(hosts, async (host) => {
    const nonce = deps.nonce?.() ?? instanceAcmePreflightNonce();
    await withPreflightServer(socketPath, nonce, run, async () => {
      await verifyInstanceAcmeHttp01Reachability(host, nonce, {
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs,
      });
    });
  });
}

export type InstanceAcmeIssueDeps = {
  run?: InstanceAcmeCommand;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  readLog?: () => Promise<string>;
  closeWindow?: typeof closeInstanceAcmeWindow;
};

export async function issueInstanceLetsEncryptCertificates(
  layout: LayoutPaths,
  hosts: readonly string[],
  instanceAcme: InstanceAcmeWireSettings,
  certsDir: string,
  deps: InstanceAcmeIssueDeps = {},
): Promise<void> {
  if (hosts.length === 0) return;
  const run = deps.run ?? defaultCommand;
  const configText = renderInstanceAcmeIssuerConfig({
    hosts,
    instanceAcme,
    socketPath: instanceAcmeSocketPath(layout),
    logFile: instanceAcmeLogPath(layout),
  });
  await writeTextPrivileged(
    instanceAcmeSettingsPath(layout),
    renderInstanceAcmeSettings(instanceAcme),
    run,
  );
  await writeTextPrivileged(
    instanceAcmeConfigPath(layout),
    configText,
    run,
  );
  const now = deps.now ?? Date.now;
  const issuerKey = instanceAcmeIssuerKey(instanceAcme);
  const had = await snapshotIssued(layout, hosts, now(), issuerKey, run);
  await startIssuer(run);
  let failed = true;
  let stopError: Error | null = null;
  try {
    await grantInstanceAcmeSocket(instanceAcmeSocketPath(layout), run);
    await waitForCertificates(layout, hosts, had, issuerKey, deps, run);
    await forEachSequential(
      hosts,
      (host) =>
        publishIssuedCertificate(layout, host, certsDir, issuerKey, run),
    );
    failed = false;
  } finally {
    stopError = await stopIssuer(run);
    await closeWindowQuietly(layout, deps.closeWindow, run, failed);
  }
  if (stopError && !failed) throw stopError;
}

async function snapshotIssued(
  layout: LayoutPaths,
  hosts: readonly string[],
  nowMs: number,
  issuerKey: string,
  run: InstanceAcmeCommand,
): Promise<Map<string, InstanceAcmeCertificateBaseline>> {
  const had = new Map<string, InstanceAcmeCertificateBaseline>();
  await forEachSequential(hosts, async (host) => {
    had.set(host, await baselineForHost(layout, host, nowMs, issuerKey, run));
  });
  return had;
}

async function baselineForHost(
  layout: LayoutPaths,
  host: string,
  nowMs: number,
  issuerKey: string,
  run: InstanceAcmeCommand,
): Promise<InstanceAcmeCertificateBaseline> {
  const current = await readIssuerInspection(
    layout,
    host,
    nowMs,
    issuerKey,
    run,
  );
  if (!current) return { identity: null, due: true };
  return {
    identity: current.identity,
    due: current.due || !current.valid,
  };
}

function waitForCertificates(
  layout: LayoutPaths,
  hosts: readonly string[],
  had: ReadonlyMap<string, InstanceAcmeCertificateBaseline>,
  issuerKey: string,
  deps: InstanceAcmeIssueDeps,
  run: InstanceAcmeCommand,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const timeoutMs = deps.timeoutMs ?? INSTANCE_ACME_ISSUE_TIMEOUT_MS;
  const started = now();
  const poll = async (): Promise<void> => {
    const elapsed = now() - started;
    const log = await (deps.readLog ?? (() => readIssuerLog(layout)))();
    const failure = instanceAcmeIssuerFailureLine(log);
    if (failure) throw new Error(`instance ACME issuer failed: ${failure}`);
    if (
      await everyHostSettled(
        layout,
        hosts,
        had,
        issuerKey,
        log,
        elapsed,
        now(),
        run,
      )
    ) {
      return;
    }
    if (elapsed >= timeoutMs) throw new Error("instance ACME issuer timed out");
    await sleep(POLL_MS);
    return poll();
  };
  return poll();
}

async function everyHostSettled(
  layout: LayoutPaths,
  hosts: readonly string[],
  had: ReadonlyMap<string, InstanceAcmeCertificateBaseline>,
  issuerKey: string,
  log: string,
  elapsed: number,
  nowMs: number,
  run: InstanceAcmeCommand,
): Promise<boolean> {
  for (const host of hosts) {
    const current = await readIssuerInspection(
      layout,
      host,
      nowMs,
      issuerKey,
      run,
    );
    const baseline = had.get(host) ?? { identity: null, due: true };
    const settled = instanceAcmeHostSettled(log, host, baseline, elapsed, {
      identity: current?.identity ?? null,
      valid: current?.valid === true,
    });
    if (!settled) return false;
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readIssuerLog(layout: LayoutPaths): Promise<string> {
  try {
    return await Deno.readTextFile(instanceAcmeLogPath(layout));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

async function startIssuer(run: InstanceAcmeCommand): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "start",
      INSTANCE_ACME_SERVICE,
    ]),
  );
  if (!result.ok) {
    throw new Error(
      result.stderr.trim() || "instance ACME issuer did not start",
    );
  }
}

async function stopIssuer(run: InstanceAcmeCommand): Promise<Error | null> {
  const result = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "systemctl",
      "stop",
      INSTANCE_ACME_SERVICE,
    ]),
  );
  if (result.ok) return null;
  return new Error(result.stderr.trim() || "instance ACME issuer did not stop");
}

async function closeWindowQuietly(
  layout: LayoutPaths,
  closeWindow: InstanceAcmeIssueDeps["closeWindow"],
  run: InstanceAcmeCommand,
  failed: boolean,
): Promise<void> {
  try {
    await (closeWindow ?? closeInstanceAcmeWindow)(layout, { run });
  } catch (err) {
    if (!failed) throw err;
    logWarn("deploy", "instance ACME window close failed:", err);
  }
}

async function publishIssuedCertificate(
  layout: LayoutPaths,
  host: string,
  certsDir: string,
  issuerKey: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error(`refusing certificate name ${host}`);
  }
  const found = await findIssuedPair(
    instanceAcmeCertificateRoot(layout),
    host,
    issuerKey,
  );
  if (!found) throw new Error(`issuer storage has no certificate for ${host}`);
  await installLeaf(
    found.crt,
    found.key,
    join(certsDir, `letsencrypt-${host}.crt`),
    join(certsDir, `letsencrypt-${host}.key`),
    run,
  );
}

export function groupIdFromGroupFile(
  text: string,
  name: string,
): number | null {
  for (const line of text.split("\n")) {
    const parts = line.split(":");
    if (parts[0] !== name) continue;
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return null;
    return id;
  }
  return null;
}

async function chgrp(path: string): Promise<void> {
  try {
    const text = await Deno.readTextFile("/etc/group");
    const gid = groupIdFromGroupFile(text, INSTANCE_ACME_CERT_GROUP);
    if (gid === null) return;
    await Deno.chown(path, null, gid);
  } catch (err) {
    if (needsRoot(err) || err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

export async function findIssuedPair(
  root: string,
  host: string,
  issuerKey: string,
): Promise<{ crt: string; key: string } | null> {
  const issuers: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) issuers.push(entry.name);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    if (needsRoot(err)) {
      return await findIssuedPairViaSudo(root, host, issuerKey);
    }
    throw err;
  }
  for (const issuer of issuers) {
    if (issuer !== issuerKey) continue;
    const crt = join(root, issuer, host, `${host}.crt`);
    const key = join(root, issuer, host, `${host}.key`);
    if (await isFile(crt) && await isFile(key)) return { crt, key };
  }
  return null;
}

/**
 * The tp-host argv (verb first) that lists `<root>/<issuer>/<host>/<host>.crt`.
 * tp-host accepts exactly this shape; its test runs this builder's output
 * through the real script, so the two cannot drift apart again.
 */
export function issuedCertificateFindArgs(
  root: string,
  host: string,
): string[] {
  return [
    "find",
    root,
    "-mindepth",
    "3",
    "-maxdepth",
    "3",
    "-type",
    "f",
    "-name",
    `${host}.crt`,
  ];
}

export async function findIssuedPairViaSudo(
  root: string,
  host: string,
  issuerKey: string,
): Promise<{ crt: string; key: string } | null> {
  if (/[*?[\]]/.test(host)) return null;
  const stdout = await sudoBytes([
    "-n",
    ...issuedCertificateFindArgs(root, host),
  ]);
  if (!stdout) return null;
  return issuedPairFromFindOutput(
    new TextDecoder().decode(stdout),
    host,
    issuerKey,
  );
}

/**
 * The `<host>.crt` under the configured CA's folder in the tp-host find
 * listing, and its sibling `.key`; null when that CA has none. Another CA's
 * pair (a staging certificate under production settings) is never returned.
 */
export function issuedPairFromFindOutput(
  listing: string,
  host: string,
  issuerKey: string,
): { crt: string; key: string } | null {
  const paths = listing.split("\n").map((line) => line.trim()).filter((
    line,
  ) => line.endsWith(`/${issuerKey}/${host}/${host}.crt`));
  paths.sort((a, b) => a.localeCompare(b));
  const crt = paths[0];
  if (!crt) return null;
  return { crt, key: `${crt.slice(0, -".crt".length)}.key` };
}

function needsRoot(err: unknown): boolean {
  return err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.NotCapable;
}

async function installLeaf(
  sourceCrt: string,
  sourceKey: string,
  destCrt: string,
  destKey: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  await copyIfChanged(sourceCrt, destCrt, 0o640, "root", run);
  // The panel Caddy (tpcaddy, group tp) loads this key, exactly as the apply
  // playbook's "Harden Let's Encrypt keys" step leaves it (tpcaddy:tp 0600).
  // A root-owned 0600 key would break the next Caddy reload or restart.
  await copyIfChanged(sourceKey, destKey, 0o600, CONTROL_PLANE_CADDY_USER, run);
}

async function copyIfChanged(
  source: string,
  dest: string,
  mode: number,
  owner: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  const next = await readFilePrivileged(source, run);
  const current = await readDestBytes(dest, run);
  if (current && bytesEqual(current, next)) {
    await ensureInstalledMode(dest, mode, owner, run);
    return;
  }
  await stageAndInstall(dest, next, mode, owner, run);
}

async function stageAndInstall(
  dest: string,
  bytes: Uint8Array,
  mode: number,
  owner: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  try {
    await Deno.mkdir(dirname(dest), { recursive: true, mode: 0o750 });
    const tmp = `${dest}.tmp`;
    await Deno.writeFile(tmp, bytes, { mode });
    await Deno.rename(tmp, dest);
    await Deno.chmod(dest, mode);
    await chgrp(dest);
    return;
  } catch (err) {
    if (!needsRoot(err)) throw err;
    await Deno.remove(`${dest}.tmp`).catch(() => undefined);
  }
  const staged = await Deno.makeTempFile({ prefix: "tp-instance-acme-" });
  try {
    await Deno.writeFile(staged, bytes, { mode: 0o600 });
    const installed = await run(
      "sudo",
      hostSudoArgs([
        "-n",
        "install",
        "-m",
        modeText(mode),
        "-o",
        owner,
        "-g",
        INSTANCE_ACME_CERT_GROUP,
        "--",
        staged,
        dest,
      ]),
    );
    if (!installed.ok) {
      throw new Error(installed.stderr.trim() || `failed to install ${dest}`);
    }
  } finally {
    await Deno.remove(staged).catch(() => undefined);
  }
}

async function ensureInstalledMode(
  dest: string,
  mode: number,
  owner: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  try {
    await Deno.chmod(dest, mode);
    await chgrp(dest);
    return;
  } catch (err) {
    if (!needsRoot(err)) throw err;
  }
  const grouped = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "chown",
      `${owner === "root" ? "" : owner}:${INSTANCE_ACME_CERT_GROUP}`,
      dest,
    ]),
  );
  if (!grouped.ok) {
    throw new Error(grouped.stderr.trim() || `failed to chgrp ${dest}`);
  }
  const chmod = await run(
    "sudo",
    hostSudoArgs(["-n", "chmod", modeText(mode), dest]),
  );
  if (!chmod.ok) {
    throw new Error(chmod.stderr.trim() || `failed to chmod ${dest}`);
  }
}

function modeText(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function readFilePrivileged(
  path: string,
  run: InstanceAcmeCommand,
): Promise<Uint8Array> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (!needsRoot(err)) throw err;
    const result = await run("sudo", hostSudoArgs(["-n", "cat", "--", path]));
    if (!result.ok) throw err;
    return new TextEncoder().encode(result.stdout);
  }
}

async function readDestBytes(
  path: string,
  run: InstanceAcmeCommand,
): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    if (!needsRoot(err)) throw err;
  }
  const result = await run("sudo", hostSudoArgs(["-n", "cat", "--", path]));
  if (result.ok) return new TextEncoder().encode(result.stdout);
  if (isAbsentFile(result.stderr)) return null;
  throw new Error(result.stderr.trim() || `failed to read ${path}`);
}

function isAbsentFile(stderr: string): boolean {
  return stderr.includes("No such file") || stderr.includes("not found");
}

async function readIssuerInspection(
  layout: LayoutPaths,
  host: string,
  nowMs: number,
  issuerKey: string,
  run: InstanceAcmeCommand,
) {
  const found = await findIssuedPair(
    instanceAcmeCertificateRoot(layout),
    host,
    issuerKey,
  );
  if (!found) return null;
  const pem = new TextDecoder().decode(
    await readFilePrivileged(found.crt, run),
  );
  return inspectIssuerCertificatePem(pem, nowMs);
}

async function sudoBytes(args: readonly string[]): Promise<Uint8Array | null> {
  try {
    const cmd = new Deno.Command("sudo", {
      args: hostSudoArgs([...args]),
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (!result.success) return null;
    return result.stdout;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function writeTextPrivileged(
  path: string,
  text: string,
  run: InstanceAcmeCommand,
): Promise<void> {
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(path, text);
    await Deno.chmod(path, 0o640);
    return;
  } catch (err) {
    if (!needsRoot(err)) throw err;
  }
  const tee = await run("sudo", hostSudoArgs(["-n", "tee", path]), text);
  if (!tee.ok) throw new Error(tee.stderr.trim() || `failed to write ${path}`);
  const chown = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "chown",
      `root:${INSTANCE_ACME_CERT_GROUP}`,
      path,
    ]),
  );
  if (!chown.ok) {
    throw new Error(chown.stderr.trim() || `failed to chown ${path}`);
  }
  const chmod = await run("sudo", hostSudoArgs(["-n", "chmod", "0640", path]));
  if (!chmod.ok) {
    throw new Error(chmod.stderr.trim() || `failed to chmod ${path}`);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function removeSite(dest: string): Promise<boolean> {
  try {
    await Deno.remove(dest);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
