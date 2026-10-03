/**
 * Stage 4: BuildKit's `/session` and `/grpc` only for the daemon's own builds.
 *
 * Both routes upgrade to HTTP/2 the gate cannot inspect (everything a build
 * asks of BuildKit travels inside them), so they are allowed only to a client
 * the kernel has vouched for. Deno cannot read a Unix peer's credentials (no
 * SO_PEERCRED), and the Docker CLI does not send its `HttpHeaders` on the
 * hijacked `/grpc` request buildx opens, so neither a uid check nor a header
 * token can carry the proof. The gate opens a third listener instead, the
 * build socket: `root:<build group> 0660`, in a `root:<build group> 0750`
 * directory. The build group (`tpgatebuild`) holds the daemon account and no
 * one else, and since root owns the socket and its directory, the daemon
 * cannot widen either. `connect()` succeeds only for members (and root), which
 * the kernel checks; the daemon's builds point their Docker context at it.
 *
 * On the build socket every other request is judged exactly as on the main
 * socket. Anywhere else (the main socket, which the whole daemon group and a
 * container handed it can reach; the read-only socket) `/session` and `/grpc`
 * are a `build-session` finding: logged in observe mode, refused (403, before
 * the engine is reached) in enforce mode. No header lifts it.
 *
 * Dependency-free on purpose (see http.ts).
 */

import type { Violation } from "./policy.ts";

/** Routes that open BuildKit's uninspectable HTTP/2 streams. */
export const BUILD_SESSION_ROUTES: ReadonlySet<string> = new Set([
  "session",
  "grpc",
]);

/**
 * The finding for a `/session` or `/grpc` request that did not arrive on the
 * build socket; none for every other route.
 */
export function buildSessionFindings(
  route: string,
  onBuildSocket: boolean,
): Violation[] {
  if (!BUILD_SESSION_ROUTES.has(route) || onBuildSocket) return [];
  return [{ rule: "build-session", detail: "not-build-socket" }];
}

/** The directory part of a socket path (`/` for a top-level one). */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "/";
}

/**
 * Open the build listener with `open`, then restrict it to the build group:
 * `0660`, group `gid`, owner left as the gate's (root). While the socket is
 * created and not yet restricted its directory is closed (`0700`), so no other
 * account can connect in between; it is reopened to `0750` (the unit makes it
 * `root:<build group>`) once the socket is restricted.
 */
export async function listenBuildSocket(
  path: string,
  gid: number,
  open: (path: string) => Promise<Deno.Listener>,
): Promise<Deno.Listener> {
  const dir = parentOf(path);
  await Deno.chmod(dir, 0o700);
  const listener = await open(path);
  try {
    await Deno.chown(path, null, gid);
    await Deno.chmod(path, 0o660);
  } catch (err) {
    listener.close();
    await Deno.remove(path).catch(() => {});
    throw err;
  }
  await Deno.chmod(dir, 0o750);
  return listener;
}
