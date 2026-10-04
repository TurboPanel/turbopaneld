/**
 * Where a host path really lands, the way the engine's bind mount will see it.
 *
 * Done by hand, one component at a time, instead of `realPath`: the engine
 * creates a bind source that does not exist, and follows a symlink whose target
 * does not exist yet, so a dangling link under a tenant directory still points
 * somewhere real once Docker has made it. `realPath` fails on both; this walk
 * keeps going and returns the path the mount would end up on.
 *
 * Dependency-free on purpose (see http.ts).
 */

import { repeatSequential } from "./util.ts";

export interface PathProbe {
  /** `"link"`, `"other"` or `undefined` when the path does not exist. */
  kind(path: string): Promise<"link" | "other" | undefined>;
  readLink(path: string): Promise<string>;
}

export const MAX_SYMLINK_HOPS = 40;

export const denoProbe: PathProbe = {
  async kind(path) {
    try {
      return (await Deno.lstat(path)).isSymlink ? "link" : "other";
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return undefined;
      throw err;
    }
  },
  readLink: (path) => Deno.readLink(path),
};

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function childOf(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

type Walk = {
  pending: string[];
  resolved: string;
  hops: number;
  done?: string;
};

/** `base` plus the rest of the path as written (a missing component ends the walk). */
function appendRest(base: string, rest: readonly string[]): string {
  let out = base;
  for (const part of rest) {
    out = part === ".." ? parentOf(out) : childOf(out, part);
  }
  return out;
}

/** One component of the walk; sets `done` when the path ends in something missing. */
async function walkOne(walk: Walk, probe: PathProbe): Promise<void> {
  const [name, ...rest] = walk.pending;
  walk.pending = rest;
  if (name === "..") {
    walk.resolved = parentOf(walk.resolved);
    return;
  }
  const next = childOf(walk.resolved, name);
  const kind = await probe.kind(next);
  if (kind === undefined) {
    // Not there yet: whatever follows lands below it unchanged.
    walk.done = appendRest(next, rest);
    return;
  }
  if (kind === "other") {
    walk.resolved = next;
    return;
  }
  walk.hops++;
  if (walk.hops > MAX_SYMLINK_HOPS) throw new Error("too many symbolic links");
  const target = await probe.readLink(next);
  if (target.startsWith("/")) walk.resolved = "/";
  walk.pending = [...segments(target), ...rest];
}

/** Resolve every symlink on `path`; a missing component is kept as written. */
export async function resolveBindPath(
  path: string,
  probe: PathProbe = denoProbe,
): Promise<string> {
  const walk: Walk = { pending: segments(path), resolved: "/", hops: 0 };
  await repeatSequential(async () => {
    if (walk.done !== undefined || walk.pending.length === 0) return false;
    await walkOne(walk, probe);
    return true;
  });
  return walk.done ?? walk.resolved;
}
