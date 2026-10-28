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
import { logInfo } from "../util/logger.ts";
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
  peerMaterialId,
  readTunnelState,
  removeTunnelState,
  renderStoredTunnelFile,
  type TunnelState,
  writeTunnelState,
} from "./tunnel-state.ts";

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

async function peerFilesPresent(
  hostingDir: string,
  id: string,
): Promise<boolean> {
  const paths = tunnelPeerPaths(hostingDir, id);
  const found = await Promise.all([
    exists(paths.certificate),
    exists(paths.key),
    exists(paths.trust),
  ]);
  return found.every(Boolean);
}

/**
 * Write the certificate, the unsealed key and the trust bundle into
 * `hosting/peer/<id>/` through a sibling folder renamed into place. Returns
 * true when the folder was made by this call. Mode 0640: the hosting Caddy
 * account reads it through the folder's access list, like the site files.
 */
async function ensurePeerMaterial(
  hostingDir: string,
  id: string,
  material: TunnelPeerMaterial,
  decryptSecrets: DecryptSecretsFn,
): Promise<boolean> {
  if (await peerFilesPresent(hostingDir, id)) return false;
  const [key] = await decryptSecrets([material.privateKeyEnvelope]);
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("could not unseal the peer certificate key");
  }
  const paths = tunnelPeerPaths(hostingDir, id);
  const staging = `${paths.dir}.tpnew`;
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await Deno.mkdir(staging, { recursive: true, mode: 0o750 });
  const write = (name: string, text: string) =>
    Deno.writeTextFile(join(staging, name), text, { mode: 0o640 });
  await write("leaf.pem", material.certificatePem);
  await write("leaf.key", key);
  await write("ca.pem", material.caCertPem);
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
  for (const entry of entries) {
    if (entry.name === keep) continue;
    await Deno.remove(join(root, entry.name), { recursive: true }).catch(
      () => {},
    );
  }
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

async function applyTunnelRoutesLocked(
  layout: LayoutPaths,
  payload: TunnelRoutesPayload,
  deps: ApplyTunnelRoutesDeps,
): Promise<TunnelRoutesResult> {
  const hostingDir = join(layout.configDir, "hosting");
  const sitesDir = join(hostingDir, "sites");
  const livePath = join(sitesDir, TUNNEL_SITE_FILE);
  await Deno.mkdir(sitesDir, { recursive: true, mode: 0o750 });
  const grantRead = deps.grantRead ?? grantHostingCaddyRead;
  const empty = payload.routes.length === 0 &&
    payload.peerAddresses.length === 0;
  const live = await readTextIfPresent(livePath);
  const prior = await readTunnelState(hostingDir);

  // An unchanged table with the file in place changes nothing.
  if (prior?.hash === payload.hash) {
    const same = await renderStoredTunnelFile(hostingDir, sitesDir, prior);
    const filesOk = prior.peerId === undefined ||
      await peerFilesPresent(hostingDir, prior.peerId);
    if (filesOk && (live ?? "") === same.contents) {
      return {
        hash: payload.hash,
        applied: false,
        routeCount: same.forwarded.length,
        dropped: same.dropped,
        warnings: [],
      };
    }
  }

  const peerId = !empty && payload.peerMaterial
    ? await peerMaterialId(
      payload.peerMaterial.certificatePem,
      payload.peerMaterial.caCertPem,
    )
    : undefined;
  const createdMaterial = peerId !== undefined &&
    await ensurePeerMaterial(
      hostingDir,
      peerId,
      payload.peerMaterial!,
      deps.decryptSecrets,
    );
  const state: TunnelState = {
    hash: payload.hash,
    routes: payload.routes,
    peerAddresses: payload.peerAddresses,
    ...(payload.listenAddresses
      ? { listenAddresses: payload.listenAddresses }
      : {}),
    ...(peerId === undefined ? {} : { peerId }),
  };

  try {
    const rendered = await renderStoredTunnelFile(hostingDir, sitesDir, state);
    if (rendered.contents !== (live ?? "")) {
      // Nothing to judge or reload when the file was never there and stays so.
      if (rendered.contents !== "" || live !== undefined) {
        await validateHostingCaddyCandidate(
          layout,
          hostingDir,
          sitesDir,
          TUNNEL_SITE_FILE,
          rendered.contents,
          grantRead,
        );
        if (rendered.contents !== "") await enableHostingCaddy();
        await activateHostingSites([{
          live: livePath,
          contents: rendered.contents,
        }]);
        // Caddy no longer loads anything from it (the empty file loaded).
        if (rendered.contents === "") {
          await Deno.remove(livePath).catch(() => {});
        }
      }
    }
    if (empty) await removeTunnelState(hostingDir);
    else await writeTunnelState(hostingDir, state);
    await prunePeerMaterial(hostingDir, peerId);
    logInfo(
      "tunnels",
      `tunnel forwarding now holds ${rendered.forwarded.length} name(s), ${rendered.dropped.length} served here`,
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
    if (createdMaterial && peerId !== undefined && prior?.peerId !== peerId) {
      await Deno.remove(tunnelPeerPaths(hostingDir, peerId).dir, {
        recursive: true,
      }).catch(() => {});
    }
    throw err;
  }
}
