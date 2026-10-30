/**
 * Passing the HTTP-proof path on to the server that places a certificate order.
 *
 * The certificate authority checks `http://<name>/.well-known/acme-challenge/<token>`
 * from several places and may land on any server the name's DNS points at. A
 * server that is not placing the order therefore answers that one path by
 * forwarding it to the issuing server's public address (keeping the `Host`
 * header), and the issuing server answers it from its own one-shot issuer.
 *
 * Every tenant site already writes its own `http://<host>` block. A second block
 * for the same host would be a duplicate-site error, so the handler goes inside
 * that block: the block imports `<config>/hosting/proof/<host>.proof*` (a glob, so
 * a missing file is a no-op) and this module writes that file. Only a name with
 * no site block yet gets a small reserved site of its own
 * (`00-tenant-acme-proof-<request>.caddy`).
 *
 * Each snippet starts with a header line naming the request and when it stops
 * being valid, so the file is its own record: an end message, an expiry timer
 * and the sweep at start-up all find and remove it from the file alone.
 */

import { isIP } from "node:net";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import {
  activateHostingCaddyForWindow,
  defaultCommand,
  disableHostingCaddy,
  enableHostingCaddy,
  hostingSitesDir,
  inspectPort80,
  type InstanceAcmeCommand,
  port80HeldMessage,
  type Port80Holder,
  reloadHostingCaddy,
  removeSite,
  sitesHoldOnlyReserved,
  TENANT_PROOF_SITE_PREFIX,
  waitForHostingCaddyOn80,
} from "./instance-acme-http01.ts";

export const PROOF_CHALLENGE_PATH = "/.well-known/acme-challenge/*";
const HEADER_PREFIX = "# tp-proof-forward ";
const FILE_SUFFIX = ".proof";

/** Where the per-host handler files live; the hosting Caddy reads them through the folder's default ACL. */
export function proofDir(layout: LayoutPaths): string {
  return join(layout.configDir, "hosting", "proof");
}

/** The glob a site's `http://<host>` block imports; null for a name a glob could misread. */
export function proofImportPattern(
  dir: string,
  host: string,
): string | null {
  if (/[*?[\]{}\s]/.test(host)) return null;
  return `${dir}/${host}${FILE_SUFFIX}*`;
}

/**
 * A usable forward target: a real address that is not loopback, unspecified,
 * link-local or multicast. Returns the lower-case address, or null.
 */
export function normalizeProofTarget(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  const family = isIP(text);
  if (family === 4) {
    const [a, b] = text.split(".").map(Number);
    if (a === 0 || a === 127 || a >= 224) return null;
    if (a === 169 && b === 254) return null;
    return text;
  }
  if (family === 6) {
    if (text === "::" || text === "::1") return null;
    if (/^fe[89ab]/.test(text) || text.startsWith("ff")) return null;
    // An IPv4 address in IPv6 clothes could name loopback or a private host.
    if (text.startsWith("::ffff:") || text.startsWith("64:ff9b:")) return null;
    return text;
  }
  return null;
}

/** `http://1.2.3.4:80` or `http://[::1]:80`. */
export function proofTargetUpstream(address: string): string {
  return isIP(address) === 6
    ? `http://[${address}]:80`
    : `http://${address}:80`;
}

function header(requestId: string, expiresAtIso: string): string {
  return `${HEADER_PREFIX}request=${requestId} expires=${expiresAtIso}\n`;
}

/** The handler a site block imports: the challenge path goes to `upstream`, Host kept. */
export function renderProofHandler(
  requestId: string,
  expiresAtIso: string,
  upstream: string,
): string {
  return `${header(requestId, expiresAtIso)}handle ${PROOF_CHALLENGE_PATH} {
	reverse_proxy ${upstream} {
		header_up Host {http.request.host}
	}
}
`;
}

/** A standalone site for names with no site block yet. */
export function renderProofReservedSite(
  requestId: string,
  expiresAtIso: string,
  hosts: readonly string[],
  upstream: string,
): string {
  const blocks = [...hosts].sort((a, b) => a.localeCompare(b)).map((host) =>
    `http://${host} {
	handle ${PROOF_CHALLENGE_PATH} {
		reverse_proxy ${upstream} {
			header_up Host {http.request.host}
		}
	}
	handle {
		respond 404
	}
}
`
  );
  return header(requestId, expiresAtIso) + blocks.join("\n");
}

/** The request id and expiry a snippet records, or null for any other file. */
export function parseProofHeader(
  text: string,
): { requestId: string; expiresAtMs: number } | null {
  const first = text.split("\n", 1)[0] ?? "";
  if (!first.startsWith(HEADER_PREFIX)) return null;
  const match = /^request=([A-Za-z0-9_-]{1,64}) expires=(\S+)$/.exec(
    first.slice(HEADER_PREFIX.length),
  );
  if (!match) return null;
  const expiresAtMs = Date.parse(match[2]);
  if (!Number.isFinite(expiresAtMs)) return null;
  return { requestId: match[1], expiresAtMs };
}

export function reservedProofSiteName(requestId: string): string {
  return `${TENANT_PROOF_SITE_PREFIX}${requestId}.caddy`;
}

export type ProofSiteState = "imports" | "stale" | "none";

/**
 * What the live site files say about one host: `imports` (a block that imports
 * the proof file), `stale` (a block written before the import existed, so it
 * needs a redeploy) or `none` (no block yet).
 */
export function proofSiteState(
  siteFiles: readonly string[],
  host: string,
  importPattern: string | null,
): ProofSiteState {
  const open = `http://${host} {`;
  let found = false;
  for (const text of siteFiles) {
    for (const line of text.split("\n")) {
      if (line.trim() !== open) continue;
      found = true;
      if (importPattern !== null && text.includes(`import ${importPattern}`)) {
        return "imports";
      }
    }
  }
  return found ? "stale" : "none";
}

async function readSiteFiles(sitesDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(sitesDir)) {
      if (!entry.isFile || !entry.name.endsWith(".caddy")) continue;
      if (entry.name.startsWith(TENANT_PROOF_SITE_PREFIX)) continue;
      out.push(await Deno.readTextFile(join(sitesDir, entry.name)));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out;
}

export type ProofForwardDeps = {
  run?: InstanceAcmeCommand;
  now?: () => number;
  ensureHostingCaddyRuntime?: (layout: LayoutPaths) => Promise<void>;
  inspect?: () => Promise<Port80Holder>;
  sleep?: (ms: number) => Promise<void>;
  /** This server's own addresses, so a forward never points back at itself. */
  localAddresses?: () => string[];
};

export type ProofForwardRequest = {
  requestId: string;
  names: readonly string[];
  /** Where the challenge path goes: `http://host:80` or `unix/<socket>`. */
  upstream: string;
  expiresAtIso: string;
};

export type ProofForwardResult = { ok: true } | { ok: false; reason: string };

/** This server's own addresses (empty when the runtime may not list them). */
export function localInterfaceAddresses(): string[] {
  try {
    return Deno.networkInterfaces().map((nic) => nic.address.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Write the handler for every name and make hosting Caddy load it. Used by a
 * helper (upstream = the issuing server) and by the issuing server itself
 * (upstream = its issuer socket). On any failure nothing stays written.
 */
export async function applyProofRoutes(
  layout: LayoutPaths,
  request: ProofForwardRequest,
  deps: ProofForwardDeps = {},
): Promise<ProofForwardResult> {
  const run = deps.run ?? defaultCommand;
  const dir = proofDir(layout);
  const sitesDir = hostingSitesDir(layout);
  const siteFiles = await readSiteFiles(sitesDir);
  const written: string[] = [];
  const orphans: string[] = [];
  const handler = renderProofHandler(
    request.requestId,
    request.expiresAtIso,
    request.upstream,
  );
  try {
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    const hostFiles: string[] = [];
    for (const host of request.names) {
      const state = proofSiteState(
        siteFiles,
        host,
        proofImportPattern(dir, host),
      );
      if (state === "stale") {
        throw new Error(
          `the site for ${host} was written by an older version; deploy it again`,
        );
      }
      if (state === "none") orphans.push(host);
      else hostFiles.push(host);
    }
    // Recorded before the writes, so a failed write is rolled back too.
    written.push(
      ...hostFiles.map((host) => join(dir, `${host}${FILE_SUFFIX}`)),
    );
    await Promise.all(
      written.map((path) => Deno.writeTextFile(path, handler, { mode: 0o640 })),
    );
    if (orphans.length > 0) {
      const path = join(sitesDir, reservedProofSiteName(request.requestId));
      written.push(path);
      await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });
      await Deno.writeTextFile(
        path,
        renderProofReservedSite(
          request.requestId,
          request.expiresAtIso,
          orphans,
          request.upstream,
        ),
        { mode: 0o640 },
      );
    }
    await loadIntoHostingCaddy(layout, run, deps);
    return { ok: true };
  } catch (err) {
    await Promise.all(
      written.map((path) => removeSite(path).catch(() => undefined)),
    );
    await releaseHostingCaddy(layout, run).catch((releaseErr) =>
      logWarn("deploy", "proof forward rollback reload failed:", releaseErr)
    );
    return { ok: false, reason: failureReason(err) };
  }
}

function failureReason(err: unknown): string {
  const text = err instanceof Error ? err.message.trim() : "";
  return text.slice(0, 300) || "could not pass the check along";
}

async function loadIntoHostingCaddy(
  layout: LayoutPaths,
  run: InstanceAcmeCommand,
  deps: ProofForwardDeps,
): Promise<void> {
  const inspect = deps.inspect ?? (() => inspectPort80(run));
  const holder = await inspect();
  if (holder.kind === "other") {
    throw new Error(port80HeldMessage(holder.process));
  }
  const ensure = deps.ensureHostingCaddyRuntime ?? defaultEnsureRuntime;
  await activateHostingCaddyForWindow(holder, layout, ensure, run);
  const after = await waitForHostingCaddyOn80(
    inspect,
    deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  );
  if (after.kind === "other") throw new Error(port80HeldMessage(after.process));
  if (after.kind !== "hosting-caddy") {
    throw new Error("hosting Caddy is not listening on port 80");
  }
}

async function defaultEnsureRuntime(layout: LayoutPaths): Promise<void> {
  const mod = await import("./ingress.ts");
  await mod.ensureHostingCaddyRuntime(layout);
}

/** After files were removed: reload, or switch hosting Caddy off when nothing else needs it. */
export async function releaseHostingCaddy(
  layout: LayoutPaths,
  run: InstanceAcmeCommand,
): Promise<void> {
  const sitesDir = hostingSitesDir(layout);
  if (await sitesHoldOnlyReserved(sitesDir)) {
    await disableHostingCaddy(run);
    if (!(await sitesHoldOnlyReserved(sitesDir))) await enableHostingCaddy(run);
    return;
  }
  await reloadHostingCaddy(run);
}

/**
 * A helper's side of `acme-proof-forward`: refuse a bad or self-pointing target,
 * then pass the proof path on to the issuing server.
 */
export async function startProofForward(
  layout: LayoutPaths,
  message: {
    requestId: string;
    names: readonly string[];
    targetAddress: string;
    expiresAtIso: string;
  },
  deps: ProofForwardDeps = {},
): Promise<ProofForwardResult> {
  const target = normalizeProofTarget(message.targetAddress);
  if (target === null) {
    return { ok: false, reason: "the issuing server's address is not usable" };
  }
  const own = (deps.localAddresses ?? localInterfaceAddresses)();
  if (own.includes(target)) {
    return { ok: false, reason: "the issuing server's address is this server" };
  }
  const now = (deps.now ?? Date.now)();
  if (Date.parse(message.expiresAtIso) <= now) {
    return { ok: false, reason: "the request has already expired" };
  }
  return await applyProofRoutes(layout, {
    requestId: message.requestId,
    names: message.names,
    upstream: proofTargetUpstream(target),
    expiresAtIso: message.expiresAtIso,
  }, deps);
}

/**
 * Remove every handler written for `requestId` (or, with `onlyExpiredBefore`,
 * every handler whose stated time has passed) and reload. Returns how many
 * files went.
 */
export async function withdrawProofForwards(
  layout: LayoutPaths,
  match: { requestId: string } | { expiredBeforeMs: number },
  deps: Pick<ProofForwardDeps, "run"> = {},
): Promise<number> {
  const run = deps.run ?? defaultCommand;
  const doomed: string[] = [];
  const consider = async (path: string) => {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    const parsed = parseProofHeader(text);
    if (parsed === null) return;
    const wanted = "requestId" in match
      ? parsed.requestId === match.requestId
      : parsed.expiresAtMs <= match.expiredBeforeMs;
    if (wanted) doomed.push(path);
  };
  await listFiles(proofDir(layout), () => true, consider);
  await listFiles(
    hostingSitesDir(layout),
    (name) => name.startsWith(TENANT_PROOF_SITE_PREFIX),
    consider,
  );
  if (doomed.length === 0) return 0;
  await forEachSequential(doomed, (path) => removeSite(path).then(() => {}));
  await releaseHostingCaddy(layout, run);
  return doomed.length;
}

/** Every forward still on disk, with the time it stops being valid. */
export async function listProofForwards(
  layout: LayoutPaths,
): Promise<Array<{ requestId: string; expiresAtMs: number }>> {
  const found = new Map<string, number>();
  const consider = async (path: string) => {
    const parsed = parseProofHeader(await Deno.readTextFile(path));
    if (parsed !== null) found.set(parsed.requestId, parsed.expiresAtMs);
  };
  await listFiles(proofDir(layout), () => true, consider);
  await listFiles(
    hostingSitesDir(layout),
    (name) => name.startsWith(TENANT_PROOF_SITE_PREFIX),
    consider,
  );
  return [...found].map(([requestId, expiresAtMs]) => ({
    requestId,
    expiresAtMs,
  }));
}

async function listFiles(
  dir: string,
  keep: (name: string) => boolean,
  each: (path: string) => Promise<void>,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && keep(entry.name)) await each(join(dir, entry.name));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * A deploy that brings its own block for a name takes that name over from any
 * reserved proof site: both would claim the same host and Caddy refuses a
 * duplicate site. The deploy reloads right after, and its block imports the
 * per-host handler; the forward for that name is simply sent again if needed.
 */
export async function dropReservedProofSitesFor(
  sitesDir: string,
  wanted: ReadonlySet<string>,
): Promise<void> {
  await listFiles(
    sitesDir,
    (name) => name.startsWith(TENANT_PROOF_SITE_PREFIX),
    async (path) => {
      const text = await Deno.readTextFile(path);
      const claimed = text.split("\n").map((line) =>
        /^http:\/\/(\S+) \{$/.exec(line.trim())?.[1]
      );
      if (claimed.some((host) => host !== undefined && wanted.has(host))) {
        await removeSite(path);
      }
    },
  );
}
