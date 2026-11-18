/**
 * Make this host's reserved tunnel file match a `server.tunnel.routes` table.
 *
 * The same discipline as an environment deploy: the new file is staged outside
 * the live glob and judged with the pinned `caddy validate` as part of the
 * whole set, swapped in with an atomic rename, and Caddy is reloaded once (put
 * back when it refuses). The peer certificate material is written to a folder
 * named by what is in it, so a table that is refused never touches the files
 * the running Caddy uses.
 */
import { join } from "@std/path";
import type {
  TunnelPeerMaterial,
  TunnelRoutesPayload,
  TunnelRoutesResult,
} from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { errorText, logInfo, logWarn } from "../util/logger.ts";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import { grantHostingCaddyRead } from "./ensure-hosting-caddy.ts";
import {
  activateHostingSites,
  enableHostingCaddy,
  validateHostingCaddyCandidate,
  withHostingSitesLock,
} from "./ingress.ts";
import {
  TUNNEL_PEER_DIR,
  TUNNEL_SITE_FILE,
  tunnelPeerPaths,
} from "./tunnel-caddy.ts";
import {
  isStaleTunnelGeneration,
  type OwnSiteFile,
  peerMaterialId,
  plannedRelocks,
  readTunnelState,
  removeTunnelState,
  renderStoredTunnelFile,
  tryRecordTunnelGeneration,
  type TunnelState,
  writeTunnelState,
} from "./tunnel-state.ts";
import {
  type PeerClientAuthPlan,
  planPeerClientAuth,
} from "./tunnel-peer-cert.ts";

export type ApplyTunnelRoutesDeps = {
  decryptSecrets: DecryptSecretsFn;
  grantRead?: (hostingDir: string) => Promise<void>;
};

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

/**
 * Whether the private key is needed at all: the peer-facing site presents it
 * (a table with peer addresses), and a forward block presents it as a client
 * key. A server that only carries a tunnel, with no peer addresses and no
 * forwarded name, never uses it, so it is not written there.
 */
function peerKeyNeeded(
  table: Pick<TunnelState, "peerAddresses" | "routes" | "presentCertificate">,
): boolean {
  return table.peerAddresses.length > 0 ||
    (table.presentCertificate === true &&
      table.routes.some((route) => !route.local));
}

/**
 * The folder holds what the table needs: the certificate and the trust bundle
 * always, the private key when {@link peerKeyNeeded}. With `exact`, a key the
 * table does not need counts as not present (it is dropped after the table is
 * in place, see {@link dropUnusedKey}).
 */
async function peerFilesPresent(
  hostingDir: string,
  id: string,
  withKey: boolean,
  exact = false,
): Promise<boolean> {
  const paths = tunnelPeerPaths(hostingDir, id);
  const [certificate, key, trust] = await Promise.all([
    exists(paths.certificate),
    exists(paths.key),
    exists(paths.trust),
  ]);
  return certificate && trust && (exact ? key === withKey : key || !withKey);
}

/**
 * Remove a key the table in place no longer uses. Only after the swap: until
 * then the running Caddy and a failed table still point at it.
 */
async function dropUnusedKey(hostingDir: string, id: string): Promise<void> {
  await Deno.remove(tunnelPeerPaths(hostingDir, id).key).catch(() => {});
}

/**
 * Write the certificate, the trust bundle and, when the table uses it, the
 * unsealed key into `hosting/peer/<id>/` through a sibling folder renamed into
 * place. Returns true when the folder was made by this call. The certificate
 * and trust bundle are 0640 (public, read by the hosting Caddy account through
 * the folder's access list, like the site files). The key is created 0600 and
 * the hosting grant (`grantHostingCaddyRead`) then gives it the Caddy entry
 * and empties its group entry, so only the daemon account and the hosting
 * Caddy account read it.
 */
async function ensurePeerMaterial(
  hostingDir: string,
  id: string,
  material: TunnelPeerMaterial,
  decryptSecrets: DecryptSecretsFn,
  withKey: boolean,
): Promise<boolean> {
  if (await peerFilesPresent(hostingDir, id, withKey)) return false;
  let key: string | null | undefined;
  if (withKey) {
    [key] = await decryptSecrets([material.privateKeyEnvelope]);
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("could not unseal the peer certificate key");
    }
  }
  const paths = tunnelPeerPaths(hostingDir, id);
  const staging = `${paths.dir}.tpnew`;
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await Deno.mkdir(staging, { recursive: true, mode: 0o750 });
  const write = (name: string, text: string, mode: number) =>
    Deno.writeTextFile(join(staging, name), text, { mode });
  await write("leaf.pem", material.certificatePem, 0o640);
  if (typeof key === "string") await write("leaf.key", key, 0o600);
  await write("ca.pem", material.caCertPem, 0o640);
  await Deno.remove(paths.dir, { recursive: true }).catch(() => {});
  await Deno.rename(staging, paths.dir);
  return true;
}

/** Remove every peer material folder except the one in use (all of them when none). */
async function prunePeerMaterial(
  hostingDir: string,
  keep: string | undefined,
): Promise<void> {
  const root = join(hostingDir, TUNNEL_PEER_DIR);
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(root));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  await Promise.all(
    entries.filter((entry) => entry.name !== keep).map((entry) =>
      Deno.remove(join(root, entry.name), { recursive: true }).catch(() => {})
    ),
  );
  if (keep === undefined) await Deno.remove(root).catch(() => {});
}

export function applyTunnelRoutes(
  layout: LayoutPaths,
  payload: TunnelRoutesPayload,
  deps: ApplyTunnelRoutesDeps,
): Promise<TunnelRoutesResult> {
  return withHostingSitesLock(() =>
    applyTunnelRoutesLocked(layout, payload, deps)
  );
}

/** The result for a table that is already in place. */
async function unchangedResult(
  hostingDir: string,
  sitesDir: string,
  payload: TunnelRoutesPayload,
  prior: TunnelState | undefined,
  live: string | undefined,
): Promise<TunnelRoutesResult | undefined> {
  // A different generation is a full apply, so the stored table keeps it too.
  if (
    prior?.hash !== payload.hash || prior.generation !== payload.generation
  ) return undefined;
  const same = await renderStoredTunnelFile(hostingDir, sitesDir, prior);
  const filesOk = prior.peerId === undefined ||
    await peerFilesPresent(
      hostingDir,
      prior.peerId,
      peerKeyNeeded(prior),
      true,
    );
  if (!filesOk || (live ?? "") !== same.contents) return undefined;
  // A site deployed since (or written by an older daemon) may hold other peers.
  if ((await plannedRelocks(sitesDir, prior)).length > 0) return undefined;
  await tryRecordTunnelGeneration(hostingDir, payload.generation);
  return {
    hash: payload.hash,
    applied: false,
    routeCount: same.forwarded.length,
    dropped: same.dropped,
    warnings: [],
  };
}

/**
 * Judge the new tunnel file together with the relocked site files. When the
 * set is refused and the tunnel file alone would load, the refusal is about the
 * site files, and the error names them, not the tunnel file.
 */
async function judgeTunnelSet(
  layout: LayoutPaths,
  paths: { hostingDir: string; sitesDir: string },
  contents: string,
  relocks: readonly OwnSiteFile[],
  grantRead: (hostingDir: string) => Promise<void>,
): Promise<void> {
  const judge = (sites: readonly OwnSiteFile[]) =>
    validateHostingCaddyCandidate(
      layout,
      paths.hostingDir,
      paths.sitesDir,
      TUNNEL_SITE_FILE,
      contents,
      grantRead,
      { sites },
    );
  try {
    await judge(relocks);
  } catch (err) {
    if (relocks.length === 0) throw err;
    // Only on a refusal: is the tunnel file fine without the site changes?
    const tunnelAlone = await judge([]).then(() => true, () => false);
    if (!tunnelAlone) throw err;
    throw new Error(
      `hosting Caddy refused the new tunnel peers for ${
        relocks.map((site) => site.file).join(", ")
      }: ${errorText(err)}`,
    );
  }
}

/**
 * Judge, swap in and reload the new tunnel file together with the site files
 * whose tunnel lock changed, with one reload; nothing happens when neither
 * changed.
 */
async function swapTunnelFile(
  layout: LayoutPaths,
  paths: { hostingDir: string; sitesDir: string; livePath: string },
  contents: string,
  live: string | undefined,
  relocks: readonly OwnSiteFile[],
  grantRead: (hostingDir: string) => Promise<void>,
): Promise<void> {
  // The file was never there and stays so, or it already holds this text.
  const tunnelSame = contents === (live ?? "") ||
    (contents === "" && live === undefined);
  if (tunnelSame && relocks.length === 0) return;
  await judgeTunnelSet(layout, paths, contents, relocks, grantRead);
  if (contents !== "") await enableHostingCaddy();
  await activateHostingSites([
    ...(tunnelSame ? [] : [{ live: paths.livePath, contents }]),
    ...relocks.map((site) => ({
      live: join(paths.sitesDir, site.file),
      contents: site.contents,
    })),
  ]);
  // Caddy no longer loads anything from it (the empty file loaded).
  if (!tunnelSame && contents === "") {
    await Deno.remove(paths.livePath).catch(() => {});
  }
}

function tunnelStateFor(
  payload: TunnelRoutesPayload,
  peerId: string | undefined,
  plan: PeerClientAuthPlan,
): TunnelState {
  return {
    hash: payload.hash,
    routes: payload.routes,
    peerAddresses: payload.peerAddresses,
    ...(payload.listenAddresses
      ? { listenAddresses: payload.listenAddresses }
      : {}),
    ...(peerId === undefined ? {} : { peerId }),
    ...(peerId !== undefined && plan.clientAuth
      ? { clientAuth: plan.clientAuth }
      : {}),
    ...(peerId !== undefined && plan.clientAuth && plan.warnings.length > 0
      ? { clientAuthDowngraded: true }
      : {}),
    ...(peerId !== undefined && plan.presentCertificate
      ? { presentCertificate: true }
      : {}),
    ...(payload.inbound ? { inbound: payload.inbound } : {}),
    generation: payload.generation,
  };
}

async function applyTunnelRoutesLocked(
  layout: LayoutPaths,
  payload: TunnelRoutesPayload,
  deps: ApplyTunnelRoutesDeps,
): Promise<TunnelRoutesResult> {
  const hostingDir = join(layout.configDir, "hosting");
  const sitesDir = join(hostingDir, "sites");
  const livePath = join(sitesDir, TUNNEL_SITE_FILE);
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });
  // Names that run here still need their lock kept current, so a table that
  // only lists them is not empty.
  const empty = payload.routes.length === 0 &&
    payload.peerAddresses.length === 0 && (payload.inbound?.length ?? 0) === 0;
  const live = await readTextIfPresent(livePath);
  const prior = await readTunnelState(hostingDir);

  // A table older than one already applied (or than a deploy's newer peers)
  // must not bring back carriers the newer one removed.
  if (await isStaleTunnelGeneration(hostingDir, payload.generation, prior)) {
    logInfo(
      "tunnels",
      `tunnel table generation ${payload.generation} is older than the one in place; left as it is`,
    );
    return {
      hash: payload.hash,
      applied: false,
      routeCount: prior?.routes.filter((route) => !route.local).length ?? 0,
      dropped: [],
      warnings: [
        "ignored: a newer forwarding table is already in place",
      ],
    };
  }

  // An unchanged table with the file in place changes nothing.
  const unchanged = await unchangedResult(
    hostingDir,
    sitesDir,
    payload,
    prior,
    live,
  );
  if (unchanged) return unchanged;

  const material = empty ? undefined : payload.peerMaterial;
  const peerId = material
    ? await peerMaterialId(material.certificatePem, material.caCertPem)
    : undefined;
  const plan = planPeerClientAuth(
    payload.peerClientAuth,
    material?.certificatePem,
  );
  const state = tunnelStateFor(payload, peerId, plan);
  const createdMaterial = material !== undefined &&
    await ensurePeerMaterial(
      hostingDir,
      peerId!,
      material,
      deps.decryptSecrets,
      peerKeyNeeded(state),
    );

  try {
    const rendered = await renderStoredTunnelFile(hostingDir, sitesDir, state);
    const relocks = await plannedRelocks(sitesDir, state);
    await swapTunnelFile(
      layout,
      { hostingDir, sitesDir, livePath },
      rendered.contents,
      live,
      relocks,
      deps.grantRead ?? grantHostingCaddyRead,
    );
    await (empty
      ? removeTunnelState(hostingDir)
      : writeTunnelState(hostingDir, state));
    await tryRecordTunnelGeneration(hostingDir, payload.generation);
    await prunePeerMaterial(hostingDir, peerId);
    if (peerId !== undefined && !peerKeyNeeded(state)) {
      await dropUnusedKey(hostingDir, peerId);
    }
    // Logged, not returned: a warning makes the control plane send the table again.
    for (const warning of [...plan.warnings, ...rendered.warnings]) {
      logWarn("tunnels", warning);
    }
    logInfo(
      "tunnels",
      `tunnel forwarding now holds ${rendered.forwarded.length} name(s), ${rendered.dropped.length} served here; ${relocks.length} site file(s) took new tunnel peers`,
    );
    return {
      hash: payload.hash,
      applied: true,
      routeCount: rendered.forwarded.length,
      dropped: rendered.dropped,
      warnings: [],
    };
  } catch (err) {
    // A refused table must not leave new key files behind.
    if (createdMaterial && prior?.peerId !== peerId) {
      await Deno.remove(tunnelPeerPaths(hostingDir, peerId!).dir, {
        recursive: true,
      }).catch(() => {});
    }
    throw err;
  }
}
