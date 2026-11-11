/**
 * What the daemon remembers of the last `server.tunnel.routes`: the table
 * (never the key) in `<config>/hosting/tunnel-routes.json`, and which folder of
 * peer material it uses. The reserved site file is always rendered from this,
 * so an environment deploy that changes which names run here can re-render it
 * without waiting for the control plane.
 */
import { join } from "@std/path";
import type {
  TunnelInbound,
  TunnelRoute,
} from "../contracts/commands-contracts.ts";
import { errorText, logWarn } from "../util/logger.ts";
import { isDaemonReservedHostingSite } from "./instance-acme-http01.ts";
import { snippetSiteAddresses } from "./caddy-snippet.ts";
import { foldHostname } from "./hostname-fold.ts";
import { inboundPeers, relockSiteText } from "./tunnel-lock.ts";
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
  /** Tunnel names that run here and who may forward them (absent from an older control plane). */
  inbound?: TunnelInbound[];
  /** Generation of the table this was applied from (`tunnel-table-generation-v1`). */
  generation?: number;
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

/** Where the highest applied table generation is kept (outlives an emptied table). */
export const TUNNEL_GENERATION_FILE = "tunnel-generation.json";

/** The highest table generation applied here, or `undefined` when none was ever recorded. */
export async function readTunnelGeneration(
  hostingDir: string,
): Promise<number | undefined> {
  try {
    const text = await readTextIfPresent(
      join(hostingDir, TUNNEL_GENERATION_FILE),
    );
    if (text === undefined) return undefined;
    const value = (JSON.parse(text) as { generation?: unknown }).generation;
    if (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) {
      return value;
    }
  } catch {
    // A record that cannot be read (or parsed) counts as none: the next table rewrites it.
  }
  return undefined;
}

/** Keep `generation` when it is higher than the one on record; `undefined` changes nothing. */
export async function recordTunnelGeneration(
  hostingDir: string,
  generation: number | undefined,
): Promise<void> {
  if (generation === undefined) return;
  const last = await readTunnelGeneration(hostingDir);
  if (last !== undefined && last >= generation) return;
  const path = join(hostingDir, TUNNEL_GENERATION_FILE);
  const next = `${path}.tpnew`;
  await Deno.writeTextFile(next, JSON.stringify({ generation }), {
    mode: 0o640,
  });
  await Deno.rename(next, path);
}

/** Best effort: a record that cannot be written only costs the ordering guard. */
export async function tryRecordTunnelGeneration(
  hostingDir: string,
  generation: number | undefined,
): Promise<void> {
  try {
    await recordTunnelGeneration(hostingDir, generation);
  } catch (err) {
    logWarn(
      "tunnels",
      `tunnel table generation not recorded: ${errorText(err)}`,
    );
  }
}

/** Forget the high-water record (a table with no generation: the way back from a reset counter). */
export async function clearTunnelGeneration(hostingDir: string): Promise<void> {
  await Deno.remove(join(hostingDir, TUNNEL_GENERATION_FILE)).catch(() => {});
}

/** The highest generation known: the record, or the stored table's own after a crash between the two writes. */
export async function knownTunnelGeneration(
  hostingDir: string,
  state: TunnelState | undefined,
): Promise<number | undefined> {
  const recorded = await readTunnelGeneration(hostingDir);
  const own = state?.generation;
  if (recorded === undefined || own === undefined) return recorded ?? own;
  return Math.max(recorded, own);
}

/**
 * Whether a table of `generation` is older than what was applied. Without a
 * generation on either side nothing is older.
 */
export async function isStaleTunnelGeneration(
  hostingDir: string,
  generation: number | undefined,
  state: TunnelState | undefined,
): Promise<boolean> {
  if (generation === undefined) return false;
  const known = await knownTunnelGeneration(hostingDir, state);
  return known !== undefined && generation < known;
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
  const files = entries.filter((entry) =>
    entry.isFile && entry.name.endsWith(".caddy") && !skip.has(entry.name) &&
    !isDaemonReservedHostingSite(entry.name)
  );
  const texts = await Promise.all(
    files.map((entry) => Deno.readTextFile(join(sitesDir, entry.name))),
  );
  for (const text of texts) {
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

/**
 * The highest tunnel `generation` among a deploy's hostings, or `undefined`
 * when none carries one (an older control plane).
 */
export function deployTunnelGeneration(
  hostings: readonly { tunnel?: { generation?: number } }[],
): number | undefined {
  const found = hostings.flatMap((hosting) => hosting.tunnel?.generation ?? []);
  return found.length === 0 ? undefined : Math.max(...found);
}

/** `contents` with the tunnel peers of the stored table; as it was when there is no table or no `inbound`. */
export function relockWithStoredPeers(
  state: TunnelState | undefined,
  contents: string,
): string {
  if (!state?.inbound) return contents;
  return relockSiteText(
    contents,
    inboundPeers(state.inbound),
    state.listenAddresses ?? [],
  );
}

/**
 * The site files whose tunnel lock differs from the stored table, with their
 * new text. The daemon's own reserved files are never touched. Empty when the
 * table has no `inbound`.
 */
export async function plannedRelocks(
  sitesDir: string,
  state: TunnelState,
): Promise<OwnSiteFile[]> {
  if (!state.inbound) return [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(sitesDir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const files = entries
    .filter((entry) =>
      entry.isFile && entry.name.endsWith(".caddy") &&
      !isDaemonReservedHostingSite(entry.name)
    )
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b));
  const texts = await Promise.all(
    files.map((file) => Deno.readTextFile(join(sitesDir, file))),
  );
  return files.flatMap((file, i) => {
    const next = relockWithStoredPeers(state, texts[i]!);
    return next === texts[i] ? [] : [{ file, contents: next }];
  });
}
