/**
 * What the daemon remembers of the last `server.tunnel.routes`: the table
 * (never the key) in `<config>/hosting/tunnel-routes.json`, and which folder of
 * peer material it uses. The reserved site file is always rendered from this,
 * so an environment deploy that changes which names run here can re-render it
 * without waiting for the control plane.
 */
import { join } from "@std/path";
import type { TunnelRoute } from "../contracts/commands-contracts.ts";
import { isDaemonReservedHostingSite } from "./instance-acme-http01.ts";
import { snippetSiteAddresses } from "./caddy-snippet.ts";
import { foldHostname } from "./hostname-fold.ts";
import {
  type RenderedTunnelFile,
  renderTunnelFile,
  TUNNEL_SITE_FILE,
  TUNNEL_STATE_FILE,
  type TunnelFileInputs,
  tunnelPeerPaths,
} from "./tunnel-caddy.ts";

/** The last accepted table. `peerId` names the folder under `hosting/peer/`. */
export type TunnelState = {
  hash: string;
  routes: TunnelRoute[];
  peerAddresses: string[];
  listenAddresses?: string[];
  peerId?: string;
};

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/** The stored table, or `undefined` when there is none or it cannot be read. */
export async function readTunnelState(
  hostingDir: string,
): Promise<TunnelState | undefined> {
  const text = await readTextIfPresent(join(hostingDir, TUNNEL_STATE_FILE));
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<TunnelState>;
    if (
      typeof value.hash === "string" && Array.isArray(value.routes) &&
      Array.isArray(value.peerAddresses)
    ) {
      return value as TunnelState;
    }
  } catch {
    // A table that cannot be read is no table: the next command rewrites it.
  }
  return undefined;
}

export async function writeTunnelState(
  hostingDir: string,
  state: TunnelState,
): Promise<void> {
  const path = join(hostingDir, TUNNEL_STATE_FILE);
  const next = `${path}.tpnew`;
  await Deno.writeTextFile(next, JSON.stringify(state), { mode: 0o640 });
  await Deno.rename(next, path);
}

export async function removeTunnelState(hostingDir: string): Promise<void> {
  await Deno.remove(join(hostingDir, TUNNEL_STATE_FILE)).catch(() => {});
}

/** The paths and addresses the renderer needs for a stored table. */
export function tunnelInputs(
  hostingDir: string,
  state: TunnelState,
): TunnelFileInputs {
  const material = state.peerId
    ? tunnelPeerPaths(hostingDir, state.peerId)
    : undefined;
  return {
    peerAddresses: state.peerAddresses,
    ...(state.listenAddresses
      ? { listenAddresses: state.listenAddresses }
      : {}),
    ...(material ? { material } : {}),
  };
}

/**
 * Every name a site file in the folder serves, except the files in `skip`
 * (the one being replaced) and the daemon's own reserved files.
 */
export async function servedNames(
  sitesDir: string,
  skip: ReadonlySet<string>,
): Promise<Set<string>> {
  const names = new Set<string>();
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(sitesDir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return names;
    throw err;
  }
  for (const entry of entries) {
    if (
      !entry.isFile || !entry.name.endsWith(".caddy") ||
      skip.has(entry.name) || isDaemonReservedHostingSite(entry.name)
    ) continue;
    const text = await Deno.readTextFile(join(sitesDir, entry.name));
    for (const address of snippetSiteAddresses(text)) {
      names.add(foldHostname(address));
    }
  }
  return names;
}

/** A site file about to replace the one of the same name on disk. */
export type OwnSiteFile = Readonly<{ file: string; contents: string }>;

/**
 * The reserved file for the stored table, given which names the site files
 * serve (with `own` standing in for its file's old content).
 */
export async function renderStoredTunnelFile(
  hostingDir: string,
  sitesDir: string,
  state: TunnelState,
  own?: OwnSiteFile,
): Promise<RenderedTunnelFile> {
  const names = await servedNames(
    sitesDir,
    new Set(own ? [own.file] : []),
  );
  if (own) {
    for (const address of snippetSiteAddresses(own.contents)) {
      names.add(foldHostname(address));
    }
  }
  return renderTunnelFile(state.routes, tunnelInputs(hostingDir, state), names);
}

/**
 * What the reserved file should hold after a site file changes, or `undefined`
 * when there is no stored table or the file is already right. A table that
 * cannot be rendered is left alone (the caller keeps the file it has).
 */
export async function plannedTunnelContents(
  hostingDir: string,
  sitesDir: string,
  own?: OwnSiteFile,
): Promise<string | undefined> {
  const state = await readTunnelState(hostingDir);
  if (!state) return undefined;
  const rendered = await renderStoredTunnelFile(
    hostingDir,
    sitesDir,
    state,
    own,
  );
  const live = await readTextIfPresent(join(sitesDir, TUNNEL_SITE_FILE));
  return rendered.contents === (live ?? "") ? undefined : rendered.contents;
}

/** The first 16 hex characters of the digest of the certificate and the trust bundle. */
export async function peerMaterialId(
  certificatePem: string,
  trustPem: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${certificatePem}\n${trustPem}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("").slice(0, 16);
}
