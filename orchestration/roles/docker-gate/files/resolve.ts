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

/** Resolve every symlink on `path`; a missing component is kept as written. */
export async function resolveBindPath(
  path: string,
  probe: PathProbe = denoProbe,
): Promise<string> {
  let pending = segments(path);
  let resolved = "/";
  let hops = 0;
  while (pending.length > 0) {
    const [name, ...rest] = pending;
    pending = rest;
    if (name === "..") {
      resolved = parentOf(resolved);
      continue;
    }
    const next = childOf(resolved, name);
    const kind = await probe.kind(next);
    if (kind === undefined) {
      // Not there yet: whatever follows lands below it unchanged.
      return [next, ...pending].reduce((acc, part) =>
        part === ".." ? parentOf(acc) : childOf(acc, part)
      );
    }
    if (kind === "other") {
      resolved = next;
      continue;
    }
    hops++;
    if (hops > MAX_SYMLINK_HOPS) throw new Error("too many symbolic links");
    const target = await probe.readLink(next);
    if (target.startsWith("/")) resolved = "/";
    pending = [...segments(target), ...pending];
  }
  return resolved;
}
