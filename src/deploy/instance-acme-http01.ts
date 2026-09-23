/**
 * Publish the control plane's public edge on hosting Caddy.
 *
 * Hosting Caddy owns `:80` and `:443` whenever its sites directory exists.
 * This reserved file is the agreed route for control-plane names on that
 * host: Let's Encrypt HTTP-01 is forwarded to control-plane Caddy on
 * `:8880`, and public `:443` reverse-proxies to the listener that holds the
 * certificate (`:8443` for an uploaded pair, loopback `:8444` for a Let's
 * Encrypt leaf this process obtained). Tenant teardown
 * ({@link removeHostingCaddySite}) skips the file by name. When hosting
 * Caddy is not installed, this is a no-op: a dedicated control-plane host
 * binds explicit `:443` itself.
 */

import { dirname, join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";
import {
  type InstanceEdgeHostname,
  instanceSiteHostname,
  readInstanceEdgeHostnames,
} from "../instance/instance-acme-observe.ts";

export const INSTANCE_ACME_HTTP01_SITE = "00-instance-acme-http01.caddy";

/** Hosting site fragments tenant sweeps must never delete. */
export const DAEMON_RESERVED_HOSTING_SITES = new Set([
  "00-empty.caddy",
  INSTANCE_ACME_HTTP01_SITE,
]);

/** Keep in step with `caddy_http_port` / `caddy_port` / `caddy_internal_https_port`. */
export const CONTROL_PLANE_HTTP_PORT = 8880;
export const CONTROL_PLANE_PUBLIC_HTTPS_PORT = 8443;
export const CONTROL_PLANE_INTERNAL_HTTPS_PORT = 8444;

const UPLOADED_CERT_ID = /^[0-9a-f-]{36}$/i;

export function isDaemonReservedHostingSite(name: string): boolean {
  return DAEMON_RESERVED_HOSTING_SITES.has(name);
}

function hostingSitesDir(layout: LayoutPaths): string {
  return join(layout.configDir, "hosting", "sites");
}

export function renderInstanceAcmeHttp01Site(hosts: readonly string[]): string {
  const blocks = hosts.map((host) =>
    `http://${host} {
	# Daemon-reserved. Forwards instance HTTP-01 to control-plane Caddy.
	handle /.well-known/acme-challenge/* {
		reverse_proxy 127.0.0.1:${CONTROL_PLANE_HTTP_PORT}
	}
}
`
  );
  return blocks.join("\n");
}

function uploadedEdgeBlocks(host: string, pair: LeafPaths): string[] {
  return [
    httpRedirectBlock(host).trimEnd(),
    httpsEdgeBlock(
      host,
      pair.certFile,
      pair.keyFile,
      CONTROL_PLANE_PUBLIC_HTTPS_PORT,
    ).trimEnd(),
  ];
}

function httpRedirectBlock(host: string): string {
  return `http://${host} {
	redir https://{host}{uri} permanent
}
`;
}

function httpsEdgeBlock(
  host: string,
  certFile: string,
  keyFile: string,
  upstreamPort: number,
): string {
  const serverName = host.includes("*")
    ? ""
    : `\n\t\t\ttls_server_name ${host}`;
  return `${host} {
	tls ${certFile} ${keyFile}
	reverse_proxy https://127.0.0.1:${upstreamPort} {
		header_up Host {http.request.host}
		transport http {
			tls_insecure_skip_verify${serverName}
		}
	}
}
`;
}

type LeafPaths = { certFile: string; keyFile: string };

type PublishedLeaf = LeafPaths & { changed: boolean };

type EdgeSite = { text: string; certsChanged: boolean };

/**
 * Install or remove the reserved public-edge site. No-op when hosting
 * Caddy's sites directory does not exist yet. Reloads only when the site
 * text or a copied Let's Encrypt leaf changed.
 */
export async function syncInstanceAcmeHttp01Site(
  layout: LayoutPaths,
  deps: {
    reload?: () => Promise<void>;
    /** Pending names, used before the sidecar exists. */
    entries?: readonly InstanceEdgeHostname[];
  } = {},
): Promise<void> {
  const sitesDir = hostingSitesDir(layout);
  try {
    await Deno.stat(sitesDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  const dest = join(sitesDir, INSTANCE_ACME_HTTP01_SITE);
  const entries = deps.entries ?? await readInstanceEdgeHostnames(layout);
  const rendered = await buildInstancePublicEdgeSite(layout, entries);
  const previous = await readTextOrEmpty(dest);
  if (rendered.text.length === 0) {
    if (await removeSite(dest)) {
      await (deps.reload ?? reloadHostingCaddy)();
    }
    return;
  }
  const textChanged = rendered.text !== previous;
  if (textChanged) {
    await Deno.writeTextFile(dest, rendered.text, { mode: 0o640 });
  }
  if (textChanged || rendered.certsChanged) {
    await (deps.reload ?? reloadHostingCaddy)();
  }
}

/**
 * Hosting Caddy site for a tenant-hosting host. Let's Encrypt names without
 * a leaf yet only forward HTTP-01, so this file does not open `:443` for
 * them before the certificate exists.
 */
export async function renderInstancePublicEdgeSite(
  layout: LayoutPaths,
  entries: readonly InstanceEdgeHostname[],
): Promise<string> {
  return (await buildInstancePublicEdgeSite(layout, entries)).text;
}

async function buildInstancePublicEdgeSite(
  layout: LayoutPaths,
  entries: readonly InstanceEdgeHostname[],
): Promise<EdgeSite> {
  const letsEncrypt = entries.filter((entry) =>
    entry.source === "lets-encrypt"
  );
  const uploaded = entries.filter((entry) => entry.source === "uploaded");
  const blocks: string[] = [];
  let certsChanged = false;
  if (letsEncrypt.length > 0) {
    blocks.push(
      renderInstanceAcmeHttp01Site(letsEncrypt.map((entry) => entry.host))
        .trimEnd(),
    );
  }
  for (const entry of letsEncrypt) {
    const issued = await publishedIssuedLeaf(layout, entry.host);
    if (!issued) continue;
    if (issued.changed) certsChanged = true;
    blocks.push(
      httpsEdgeBlock(
        entry.host,
        issued.certFile,
        issued.keyFile,
        CONTROL_PLANE_INTERNAL_HTTPS_PORT,
      ).trimEnd(),
    );
  }
  for (const entry of uploaded) {
    const pair = await uploadedLeaf(layout, entry);
    if (!pair) continue;
    blocks.push(...uploadedEdgeBlocks(entry.host, pair));
  }
  return { text: edgeSiteText(blocks, letsEncrypt, uploaded), certsChanged };
}

function edgeSiteText(
  blocks: readonly string[],
  letsEncrypt: readonly InstanceEdgeHostname[],
  uploaded: readonly InstanceEdgeHostname[],
): string {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && letsEncrypt.length > 0 && uploaded.length === 0) {
    return renderInstanceAcmeHttp01Site(letsEncrypt.map((entry) => entry.host));
  }
  return `${blocks.join("\n\n")}\n`;
}

async function publishedIssuedLeaf(
  layout: LayoutPaths,
  host: string,
): Promise<PublishedLeaf | null> {
  if (!layout.stateDir || host.includes("/") || host.includes("..")) {
    return null;
  }
  const root = join(
    layout.stateDir,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
  );
  try {
    const found = await findIssuedPair(root, host);
    if (!found) return null;
    const dest = publicEdgePaths(layout, host);
    const changed = await installLeaf(
      found.crt,
      found.key,
      dest.certFile,
      dest.keyFile,
    );
    return { ...dest, changed };
  } catch (err) {
    logWarn(
      "deploy",
      `instance public edge skipped ${host}: issued certificate could not be copied:`,
      err,
    );
    return null;
  }
}

function publicEdgePaths(layout: LayoutPaths, host: string): LeafPaths {
  const dir = join(layout.stateDir, "caddy", "public-edge");
  const safe = host.replaceAll("*", "_");
  return {
    certFile: join(dir, `${safe}.crt`),
    keyFile: join(dir, `${safe}.key`),
  };
}

async function findIssuedPair(
  root: string,
  host: string,
): Promise<{ crt: string; key: string } | null> {
  const issuers: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) issuers.push(entry.name);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    if (needsRootRead(err)) return await findIssuedPairViaSudo(root, host);
    throw err;
  }
  issuers.sort((a, b) => a.localeCompare(b));
  for (const issuer of issuers) {
    const crt = join(root, issuer, host, `${host}.crt`);
    const key = join(root, issuer, host, `${host}.key`);
    if (await isFile(crt) && await isFile(key)) return { crt, key };
  }
  return null;
}

async function findIssuedPairViaSudo(
  root: string,
  host: string,
): Promise<{ crt: string; key: string } | null> {
  if (/[*?[\]]/.test(host)) return null;
  const stdout = await sudoBytes([
    "-n",
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
  ]);
  if (!stdout) return null;
  const paths = new TextDecoder().decode(stdout).split("\n").map((line) =>
    line.trim()
  ).filter((line) => line.endsWith(`/${host}.crt`));
  paths.sort((a, b) => a.localeCompare(b));
  const crt = paths[0];
  if (!crt) return null;
  return { crt, key: `${crt.slice(0, -".crt".length)}.key` };
}

function needsRootRead(err: unknown): boolean {
  return err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.NotCapable;
}

async function readFilePrivileged(path: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (!needsRootRead(err)) throw err;
    const bytes = await sudoBytes(["-n", "cat", "--", path]);
    if (!bytes) throw err;
    return bytes;
  }
}

async function sudoBytes(
  args: readonly string[],
): Promise<Uint8Array | null> {
  try {
    const cmd = new Deno.Command("sudo", {
      args: [...args],
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

async function uploadedLeaf(
  layout: LayoutPaths,
  entry: InstanceEdgeHostname,
): Promise<LeafPaths | null> {
  if (!layout.stateDir) return null;
  const names = uploadedLeafNames(entry.certId);
  if (!names) {
    logWarn(
      "deploy",
      `instance public edge skipped ${entry.host}: certificate id is not a uuid`,
    );
    return null;
  }
  const certFile = join(layout.stateDir, "tls", "certs", names.crt);
  const keyFile = join(layout.stateDir, "tls", "certs", names.key);
  if (await isFile(certFile) && await isFile(keyFile)) {
    return { certFile, keyFile };
  }
  logWarn(
    "deploy",
    `instance public edge skipped ${entry.host}: uploaded certificate files are missing`,
  );
  return null;
}

function uploadedLeafNames(
  certId: string,
): { crt: string; key: string } | null {
  if (certId.length === 0) {
    return { crt: "uploaded.crt", key: "uploaded.key" };
  }
  if (!UPLOADED_CERT_ID.test(certId)) return null;
  return { crt: `uploaded-${certId}.crt`, key: `uploaded-${certId}.key` };
}

async function installLeaf(
  sourceCrt: string,
  sourceKey: string,
  destCrt: string,
  destKey: string,
): Promise<boolean> {
  await Deno.mkdir(dirname(destCrt), { recursive: true, mode: 0o750 });
  const certChanged = await copyIfChanged(sourceCrt, destCrt, 0o640);
  const keyChanged = await copyIfChanged(sourceKey, destKey, 0o600);
  return certChanged || keyChanged;
}

async function copyIfChanged(
  source: string,
  dest: string,
  mode: number,
): Promise<boolean> {
  const next = await readFilePrivileged(source);
  const current = await readBytesOrNull(dest);
  if (current && bytesEqual(current, next)) return false;
  const tmp = `${dest}.tmp`;
  await Deno.writeFile(tmp, next, { mode });
  await Deno.rename(tmp, dest);
  await Deno.chmod(dest, mode);
  return true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
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

export const INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX =
  "Let's Encrypt HTTP-01 preflight failed for ";

const CHALLENGE_PREFIX = "/.well-known/acme-challenge/";
const PREFLIGHT_TIMEOUT_MS = 8_000;

export class InstanceAcmeHttp01PreflightError extends Error {
  constructor(hostname: string, detail: string) {
    super(`${INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX}${hostname}: ${detail}`);
    this.name = "InstanceAcmeHttp01PreflightError";
  }
}

export function instanceAcmePreflightRoot(layout: LayoutPaths): string {
  return join(layout.configDir, "caddy", "acme-preflight");
}

export function withInstanceAcmePreflightHandle(
  caddyfile: string,
  preflightRoot: string,
): string {
  if (caddyfile.includes(preflightRoot)) return caddyfile;
  const lines = caddyfile.split("\n");
  const index = lines.findIndex((line) => isHttp01SiteOpen(line));
  if (index < 0) return caddyfile;
  lines.splice(index + 1, 0, ...preflightHandleLines(preflightRoot));
  return lines.join("\n");
}

function isHttp01SiteOpen(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.endsWith("{")) return false;
  return trimmed.includes("8880") || trimmed.includes("caddy_http_port");
}

function preflightHandleLines(root: string): string[] {
  return [
    "\thandle /.well-known/acme-challenge/* {",
    `\t\troot * ${root}`,
    "\t\tfile_server {",
    "\t\t\tpass_thru",
    "\t\t}",
    "\t}",
  ];
}

export function instanceAcmePreflightNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
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
  headers: HeadersInit | undefined,
  timeoutMs: number,
): Promise<ChallengeRead> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers,
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
  const local = await readChallenge(
    fetchImpl,
    `http://127.0.0.1:${CONTROL_PLANE_HTTP_PORT}${CHALLENGE_PREFIX}${nonce}`,
    { host: hostname },
    timeoutMs,
  );
  const localMismatch = challengeMismatch(local, nonce);
  if (localMismatch) {
    throw new InstanceAcmeHttp01PreflightError(
      hostname,
      `${publicUrl} did not reach 127.0.0.1:${CONTROL_PLANE_HTTP_PORT} (solver ${localMismatch})`,
    );
  }
  const remote = await readChallenge(
    fetchImpl,
    publicUrl,
    undefined,
    timeoutMs,
  );
  const remoteMismatch = challengeMismatch(remote, nonce);
  if (remoteMismatch) {
    throw new InstanceAcmeHttp01PreflightError(
      hostname,
      `${publicUrl} did not reach 127.0.0.1:${CONTROL_PLANE_HTTP_PORT} (${remoteMismatch})`,
    );
  }
}

function letsEncryptEdgeEntries(
  hostnames: readonly { host: string; source: string }[],
): InstanceEdgeHostname[] {
  const entries: InstanceEdgeHostname[] = [];
  for (const entry of hostnames) {
    if (entry.source !== "lets-encrypt") continue;
    const hostname = instanceSiteHostname(entry.host);
    if (!hostname) {
      throw new InstanceAcmeHttp01PreflightError(
        entry.host,
        `http://${entry.host}${CHALLENGE_PREFIX} did not reach 127.0.0.1:${CONTROL_PLANE_HTTP_PORT} (hostname is not a DNS name)`,
      );
    }
    entries.push({ host: hostname, source: "lets-encrypt", certId: "" });
  }
  return entries;
}

async function publishPreflightNonce(
  root: string,
  nonce: string,
): Promise<string> {
  const dir = join(root, ".well-known", "acme-challenge");
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const file = join(dir, nonce);
  await Deno.writeTextFile(file, nonce, { mode: 0o640 });
  return file;
}

async function ensurePreflightHandler(
  layout: LayoutPaths,
  reload: () => Promise<void>,
): Promise<void> {
  const caddyfile = join(layout.configDir, "caddy", "Caddyfile");
  let current: string;
  try {
    current = await Deno.readTextFile(caddyfile);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  const next = withInstanceAcmePreflightHandle(
    current,
    instanceAcmePreflightRoot(layout),
  );
  if (next !== current) {
    await Deno.writeTextFile(caddyfile, next, { mode: 0o640 });
  }
  await reload();
}

export type InstanceAcmeHttp01PreflightDeps = {
  fetchImpl?: typeof fetch;
  syncChallenge?: typeof syncInstanceAcmeHttp01Site;
  reloadControlPlane?: () => Promise<void>;
  nonce?: () => string;
  timeoutMs?: number;
};

/**
 * Publish a nonce per Let's Encrypt hostname and require
 * `http://<hostname>/.well-known/acme-challenge/<nonce>` to come back from
 * `127.0.0.1:8880` before issuance starts.
 */
export async function preflightInstanceLetsEncryptHttp01(
  hostnames: readonly { host: string; source: string }[],
  layout: LayoutPaths,
  deps: InstanceAcmeHttp01PreflightDeps = {},
): Promise<void> {
  const entries = letsEncryptEdgeEntries(hostnames);
  if (entries.length === 0) return;
  const sync = deps.syncChallenge ?? syncInstanceAcmeHttp01Site;
  await sync(layout, { entries });
  await ensurePreflightHandler(
    layout,
    deps.reloadControlPlane ?? reloadControlPlaneCaddy,
  );
  const files: string[] = [];
  try {
    for (const entry of entries) {
      const nonce = deps.nonce?.() ?? instanceAcmePreflightNonce();
      files.push(
        await publishPreflightNonce(instanceAcmePreflightRoot(layout), nonce),
      );
      await verifyInstanceAcmeHttp01Reachability(entry.host, nonce, {
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs,
      });
    }
  } finally {
    await Promise.all(
      files.map((file) => Deno.remove(file).catch(() => undefined)),
    );
  }
}

async function reloadControlPlaneCaddy(): Promise<void> {
  try {
    const cmd = new Deno.Command("sudo", {
      args: ["-n", "systemctl", "reload", "turbopanel-caddy.service"],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (!result.success) {
      logWarn("deploy", "instance ACME preflight reload skipped");
    }
  } catch (err) {
    logWarn("deploy", "instance ACME preflight reload skipped:", err);
  }
}

async function reloadHostingCaddy(): Promise<void> {
  try {
    const cmd = new Deno.Command("sudo", {
      args: [
        "-n",
        "systemctl",
        "reload",
        "turbopanel-hosting-caddy.service",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      logWarn("deploy", `instance ACME HTTP-01 reload skipped: ${stderr}`);
    }
  } catch (err) {
    logWarn("deploy", "instance ACME HTTP-01 reload skipped:", err);
  }
}
