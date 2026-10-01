/**
 * The read-only listener (stage 3): what Traefik's Docker provider may ask.
 *
 * Traefik needs to list containers, inspect one, follow events and negotiate
 * the API version. Nothing else. This listener is a separate socket in a
 * directory of its own, so a Traefik container can mount it without ever
 * seeing the gate's main socket. It refuses, with a 403, every request outside
 * this exact list. That refusal is what this socket IS, not strict-profile
 * enforcement: the main socket stays observe-only.
 *
 * Deliberately narrower than the generic read list in policy.ts, which also
 * passes `export` (a whole container filesystem), `logs`, `archive`, images,
 * `info` and the rest.
 *
 * Dependency-free on purpose (see http.ts).
 */

import {
  type Framing,
  headerTokens,
  requestFraming,
  type RequestHead,
} from "./http.ts";
import { routePath } from "./policy.ts";

/** A container id or name, as Docker allows them (no dots or dashes first). */
const CONTAINER_REF = String.raw`[A-Za-z\d][A-Za-z\d_.-]*`;

/** Every route the read-only socket answers (after the API version prefix). */
export const READ_ONLY_ROUTES: readonly RegExp[] = [
  /^\/(?:_ping|version|events)$/,
  /^\/containers\/json$/,
  new RegExp(`^/containers/${CONTAINER_REF}/json$`),
];

const READ_METHODS = new Set(["GET", "HEAD"]);

function rawPathOf(target: string): string {
  const question = target.indexOf("?");
  return question === -1 ? target : target.slice(0, question);
}

/** A path the engine would decode, clean or route differently than it reads. */
function pathIsPlain(rawPath: string): boolean {
  return rawPath.startsWith("/") && !rawPath.includes("%") &&
    !rawPath.includes("..") && !rawPath.includes("//") &&
    !rawPath.includes("\\") && !rawPath.includes("#");
}

function asksUpgrade(head: RequestHead): boolean {
  return headerTokens(head.headers, "upgrade").length > 0 ||
    headerTokens(head.headers, "connection").includes("upgrade");
}

function hasBody(framing: Framing): boolean {
  if (framing.kind === "none") return false;
  return framing.kind !== "length" || framing.length > 0;
}

/**
 * Why the read-only socket refuses this request, or `undefined` when it may
 * pass. Reasons are fixed strings (never the path or a header value). A body
 * with ambiguous framing throws the same `HttpError` the main socket does.
 */
export function readOnlyRefusal(head: RequestHead): string | undefined {
  if (!READ_METHODS.has(head.method)) {
    return "read-only socket: method not allowed";
  }
  if (asksUpgrade(head)) return "read-only socket: no upgrade";
  if (hasBody(requestFraming(head))) return "read-only socket: no request body";
  const rawPath = rawPathOf(head.target);
  if (!pathIsPlain(rawPath)) return "read-only socket: path not allowed";
  const route = routePath(rawPath);
  if (!READ_ONLY_ROUTES.some((pattern) => pattern.test(route))) {
    return "read-only socket: route not allowed";
  }
  return undefined;
}
