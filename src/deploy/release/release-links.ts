/**
 * Publish-time symlink checks for a release.
 *
 * The seal re-owns the whole tree `root:<p>` (`chown -R -h`), links
 * included, so a build that ships `x → /srv/users/bob/sites/app/current/…`
 * would pass the engines' owner-match rules (nginx `disable_symlinks
 * if_not_owner`, Apache `SymLinksIfOwnerMatch`, OpenLiteSpeed
 * `allowSymbolLink 2`): bob's published release is root-owned too. Engines are
 * in every principal's group, so such a link would serve bob's files from
 * this site. Every link is therefore resolved physically, as root, once the
 * tree is frozen, and a release is refused when one lands in another
 * principal's home ({@link assertReleaseLinksStayHome}).
 *
 * That check alone is beaten by a **second hop through `shared/`**: a build
 * ships `public/x -> ../shared/evil`, which resolves inside the principal's own
 * home at publish time, and the tenant later repoints the principal-owned
 * `shared/evil` at another principal's sealed, root-owned file. The engines
 * compare only the first link's owner (root, from the seal) with the final
 * target's (root), so the other tenant's file is served. Any check that
 * resolves *through* `shared/` is defeatable — the tenant controls what it
 * says at check time. So before the layout's own `shared` link exists, every
 * link the build shipped must resolve inside the release and not into a
 * `shared` entry ({@link assertStagedLinksStayInRelease}). Once sealed the
 * release is immutable, so links that pass can never be redirected.
 *
 * A release sealed before that check existed can still hold such a link, and a
 * rollback re-serves it without publishing anything. Its `shared` link is in
 * place by then, so `realpath` would resolve straight through the tenant's
 * directory; rollback instead follows every link's **text** lexically inside
 * the release, never through `shared`, and refuses any chain that lands in
 * `shared` or outside the release ({@link assertSealedLinksStayInRelease}).
 */
import { dirname, join } from "@std/path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import type { RunFn } from "../ensure-principal.ts";
import type { ReleasePaths } from "./release-layout.ts";

/** How many offending targets an error names before it summarizes. */
const REPORTED_TARGETS = 5;

/**
 * `find` argv printing where every symlink under `releaseDir` resolves
 * (`realpath -m`, NUL-separated). tp-host accepts exactly this shape.
 */
export function releaseLinkTargetsFindArgs(releaseDir: string): string[] {
  return [
    "find",
    releaseDir,
    "-type",
    "l",
    "-exec",
    "realpath",
    "-m",
    "-z",
    "--",
    "{}",
    "+",
  ];
}

/**
 * `find` argv printing every symlink under `releaseDir` as its path relative
 * to `releaseDir` and its unresolved text, each NUL-terminated
 * (`<path>\0<text>\0`). Nothing is resolved or opened. tp-host accepts
 * exactly this shape.
 */
export function releaseLinkTextsFindArgs(releaseDir: string): string[] {
  return ["find", releaseDir, "-type", "l", "-printf", String.raw`%P\0%l\0`];
}

function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Resolved link targets inside the principal homes root but outside this
 * principal's own home — including the homes root itself, which would list
 * every account.
 */
export function foreignLinkTargets(
  targets: readonly string[],
  principalHome: string,
): string[] {
  const homesRoot = dirname(principalHome);
  return targets.filter((target) =>
    isWithin(target, homesRoot) && !isWithin(target, principalHome)
  );
}

/**
 * The name the layout's own writable-state link takes at the top of a release
 * (`promote.ts` `RELEASE_SHARED_LINK_NAME`, restated to avoid an import cycle).
 */
const RELEASE_SHARED_NAME = "shared";

/**
 * Resolved link targets that leave the release, or land in (or are) its
 * top-level `shared` entry. `releaseDir` must be the physical path, as
 * `realpath` prints it.
 */
export function linkTargetsLeavingRelease(
  targets: readonly string[],
  releaseDir: string,
): string[] {
  const shared = `${releaseDir}/${RELEASE_SHARED_NAME}`;
  return targets.filter((target) =>
    !isWithin(target, releaseDir) || isWithin(target, shared)
  );
}

/**
 * The physical path of `releaseDir`, as `realpath` prints the targets it is
 * compared with. When the daemon cannot traverse the principal's home the
 * given path is kept: that only happens on a managed host, where tp-host
 * refuses to list a directory whose path is not already physical.
 */
async function physicalPath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (err) {
    // An absent tree fails the listing that follows, closed.
    if (
      err instanceof Deno.errors.PermissionDenied ||
      err instanceof Deno.errors.NotFound
    ) return path;
    throw err;
  }
}

/** Where every symlink under `releaseDir` resolves, as root. Fails closed. */
async function releaseLinkTargets(
  releaseDir: string,
  runFn: RunFn,
): Promise<string[]> {
  const result = await runFn(
    "sudo",
    hostSudoArgs(["-n", ...releaseLinkTargetsFindArgs(releaseDir)]),
  );
  if (!result.success) {
    throw new Error(
      `could not check the symlinks in release ${releaseDir}: ${
        result.stderr || "find failed"
      }`,
    );
  }
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

function describeTargets(targets: readonly string[]): string {
  const named = targets.slice(0, REPORTED_TARGETS).join(", ");
  const more = targets.length > REPORTED_TARGETS
    ? ` (and ${targets.length - REPORTED_TARGETS} more)`
    : "";
  return `${named}${more}`;
}

/**
 * Refuse a sealed release with a symlink into another principal's home. Fails
 * closed: a listing that cannot be completed (a link loop, a missing tree) is
 * an error too.
 */
export async function assertReleaseLinksStayHome(
  paths: Pick<ReleasePaths, "principalHome">,
  releaseDir: string,
  runFn: RunFn,
): Promise<void> {
  const targets = await releaseLinkTargets(releaseDir, runFn);
  const foreign = foreignLinkTargets(
    targets,
    await physicalPath(paths.principalHome),
  );
  if (foreign.length === 0) return;
  throw new Error(
    `release ${releaseDir} has symlinks into another account's files: ${
      describeTargets(foreign)
    }`,
  );
}

/**
 * Refuse a staged release with a symlink that leaves it or reaches into
 * `shared`. Must run **before** the layout's `shared` link is created: with no
 * `shared` entry (or only the build's own, about to be replaced), `realpath -m`
 * resolves a `../shared/…` tail lexically under `<releaseDir>/shared`, whatever
 * the tenant has planted in the real `shared/`. The staged tree is root-owned
 * (`install -d` + `tp-host cp`), so nothing the tenant runs can change a link
 * between this check and the seal.
 */
export async function assertStagedLinksStayInRelease(
  releaseDir: string,
  runFn: RunFn,
): Promise<void> {
  const targets = await releaseLinkTargets(releaseDir, runFn);
  const leaving = linkTargetsLeavingRelease(
    targets,
    await physicalPath(releaseDir),
  );
  if (leaving.length === 0) return;
  throw new Error(
    `release ${releaseDir} has symlinks that leave the release or reach into ` +
      `shared/ (serve shared files through the app, not a link): ${
        describeTargets(leaving)
      }`,
  );
}

/** A symlink in a release: its path relative to the release, and its text. */
export type ReleaseLink = { path: string; text: string };

/** Links followed in one chain before it counts as a loop (as the kernel's). */
const MAX_LINK_HOPS = 40;

/**
 * Path components a lexical check of one release may walk in total. Each link
 * is resolved once and its text walked once, so a release needs about as many
 * steps as its link texts have components; past this it is refused rather
 * than walked, so a crafted release cannot hold the event loop.
 */
export const LINK_WALK_STEP_BUDGET = 1_000_000;

/** Why a release is refused when its links need more than the budget. */
const OVER_BUDGET = "too many link components to check";

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

/** A link resolved to where its chain ends, and how many links it followed. */
type Resolved = { at: PathNode; hops: number };

/**
 * A path in the release, as a tree the walk moves through in O(1) a step: no
 * path is joined, split or copied while walking. `text` marks a link;
 * `result` is its resolution once known (`resolving` is set while it is on the
 * stack, so meeting it again is a cycle), so no link is walked twice.
 */
type PathNode = {
  parent: PathNode | null;
  children: Map<string, PathNode>;
  text?: string;
  result?: Resolved | string;
  resolving?: boolean;
};

function childNode(node: PathNode, name: string): PathNode {
  let child = node.children.get(name);
  if (child === undefined) {
    child = { parent: node, children: new Map() };
    node.children.set(name, child);
  }
  return child;
}

/** One link being resolved: its text's components, from `i` on, left. */
type Frame = {
  link: PathNode;
  at: PathNode;
  parts: string[];
  i: number;
  hops: number;
};

/**
 * Resolve `start` lexically: why its chain is refused, or where it ends. A
 * component naming another link is resolved first (or taken from its
 * `result`), so `..` after it climbs out of its target, as the kernel would;
 * the top-level `shared` is never entered. Only the link texts are followed —
 * never the filesystem, so nothing the tenant keeps in `shared/` (or anywhere
 * else) can change the answer. Returns {@link OVER_BUDGET} once
 * `budget.steps` runs out.
 */
function resolveLink(
  start: PathNode,
  root: PathNode,
  budget: { steps: number },
): Resolved | string {
  if (start.text!.startsWith("/")) {
    start.result = "leaves the release";
    return start.result;
  }
  const walk: Walk = { stack: [], returned: null };
  enterLink(walk, start);
  while (walk.stack.length > 0) {
    const frame = walk.stack.at(-1)!;
    if (walk.returned !== null) absorbReturned(walk, frame);
    else if (frame.i === frame.parts.length) {
      finishFrame(walk, frame, { at: frame.at, hops: frame.hops });
    } else if (--budget.steps < 0) return OVER_BUDGET;
    else stepFrame(walk, frame, root);
  }
  return walk.returned!;
}

/** The links being resolved, innermost last, and the result just produced. */
type Walk = { stack: Frame[]; returned: Resolved | string | null };

function enterLink(walk: Walk, link: PathNode): void {
  link.resolving = true;
  walk.stack.push({
    link,
    at: link.parent!,
    parts: segments(link.text!),
    i: 0,
    hops: 0,
  });
}

function finishFrame(
  walk: Walk,
  frame: Frame,
  result: Resolved | string,
): void {
  frame.link.result = result;
  frame.link.resolving = false;
  walk.stack.pop();
  walk.returned = result;
}

/** A link the frame named has been resolved: continue from its end. */
function absorbReturned(walk: Walk, frame: Frame): void {
  const sub = walk.returned!;
  walk.returned = null;
  if (typeof sub === "string") finishFrame(walk, frame, sub);
  else if (frame.hops + 1 + sub.hops > MAX_LINK_HOPS) {
    finishFrame(walk, frame, "loops");
  } else {
    frame.hops += 1 + sub.hops;
    frame.at = sub.at;
  }
}

/** Take the frame's next path component. */
function stepFrame(walk: Walk, frame: Frame, root: PathNode): void {
  const part = frame.parts[frame.i++];
  if (part === "..") {
    if (frame.at.parent === null) {
      finishFrame(walk, frame, "leaves the release");
    } else frame.at = frame.at.parent;
    return;
  }
  if (frame.at === root && part === RELEASE_SHARED_NAME) {
    finishFrame(walk, frame, "reaches into shared/");
    return;
  }
  const next = childNode(frame.at, part);
  if (next.text === undefined) {
    frame.at = next;
  } else if (next.text.startsWith("/")) {
    finishFrame(walk, frame, "leaves the release");
  } else if (frame.hops >= MAX_LINK_HOPS || next.resolving) {
    finishFrame(walk, frame, "loops");
  } else if (next.result !== undefined) {
    walk.returned = next.result;
  } else {
    enterLink(walk, next);
  }
}

/**
 * Links (other than the layout's own top-level `shared`) whose chain, followed
 * lexically inside the release, leaves it or lands in `shared`. Each is
 * reported as `<path> -> <text> (<why>)`. O(total link-text components), and
 * capped at `stepBudget` of them: a release over it is refused (fails closed),
 * the link the budget ran out on reported and the rest left unchecked.
 */
export function linksLeavingReleaseLexically(
  links: readonly ReleaseLink[],
  stepBudget = LINK_WALK_STEP_BUDGET,
): string[] {
  const root: PathNode = { parent: null, children: new Map() };
  const nodes = links.map((link) => {
    let node = root;
    for (const part of segments(link.path)) node = childNode(node, part);
    node.text = link.text;
    return node;
  });
  const budget = { steps: stepBudget };
  const leaving: string[] = [];
  for (const [index, link] of links.entries()) {
    if (link.path === RELEASE_SHARED_NAME) continue;
    const node = nodes[index];
    const result = node.result ?? resolveLink(node, root, budget);
    if (result === OVER_BUDGET) {
      leaving.push(
        `${link.path} -> ${link.text} (${OVER_BUDGET}: over ${stepBudget})`,
      );
      break;
    }
    if (typeof result === "string") {
      leaving.push(`${link.path} -> ${link.text} (${result})`);
    }
  }
  return leaving;
}

/** Parse `<path>\0<text>\0…` as {@link releaseLinkTextsFindArgs} prints it. */
export function parseReleaseLinkTexts(stdout: string): ReleaseLink[] {
  const fields = stdout.split("\0");
  const links: ReleaseLink[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== "") links.push({ path: fields[i], text: fields[i + 1] });
  }
  return links;
}

/** Filesystem calls {@link readReleaseLinks} keeps in flight at once. */
const READ_CONCURRENCY = 16;

/** Run at most `limit` of the calls passed to the returned function at once. */
function concurrencyLimit(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const start = () => {
    active++;
  };
  const done = () => {
    active--;
    waiting.shift()?.();
  };
  return <T>(call: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        start();
        Promise.resolve().then(call).then(resolve, reject).finally(done);
      };
      if (active < limit) run();
      else waiting.push(run);
    });
}

/**
 * Every symlink under `dir`, read as the daemon (no privilege), with at most
 * {@link READ_CONCURRENCY} directories or links open at once.
 */
async function readReleaseLinks(
  root: string,
  relative: string,
  limit = concurrencyLimit(READ_CONCURRENCY),
): Promise<ReleaseLink[]> {
  const dir = relative === "" ? root : join(root, relative);
  const entries = await limit(() => Array.fromAsync(Deno.readDir(dir)));
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymlink) {
      return [{
        path,
        text: await limit(() => Deno.readLink(join(root, path))),
      }];
    }
    return entry.isDirectory ? await readReleaseLinks(root, path, limit) : [];
  }));
  return nested.flat();
}

/**
 * Every symlink in a sealed release with its unresolved text: read directly
 * when the daemon can, else (or when `asRoot`, because the daemon already
 * knows it cannot traverse the release) listed as root. Fails closed.
 */
export async function listReleaseLinks(
  releaseDir: string,
  runFn: RunFn,
  asRoot = false,
): Promise<ReleaseLink[]> {
  if (!asRoot) {
    try {
      return await readReleaseLinks(releaseDir, "");
    } catch (err) {
      if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
    }
  }
  const result = await runFn(
    "sudo",
    hostSudoArgs(["-n", ...releaseLinkTextsFindArgs(releaseDir)]),
  );
  if (!result.success) {
    throw new Error(
      `could not list the symlinks in release ${releaseDir}: ${
        result.stderr || "find failed"
      }`,
    );
  }
  return parseReleaseLinkTexts(result.stdout);
}

/**
 * Resolved targets of a sealed release's links that leave it or land in
 * `shared`, less the one resolution that belongs to the layout's own
 * top-level `shared` link (`../../shared`, outside the release by design).
 * Only one occurrence is excused, so a shipped link to the same place is
 * still reported.
 */
function resolvedTargetsLeavingSealedRelease(
  targets: readonly string[],
  links: readonly ReleaseLink[],
  physicalReleaseDir: string,
): string[] {
  const layoutLink = links.some((link) =>
    link.path === RELEASE_SHARED_NAME && link.text === "../../shared"
  );
  const layoutTarget = join(
    dirname(dirname(physicalReleaseDir)),
    RELEASE_SHARED_NAME,
  );
  const index = layoutLink ? targets.indexOf(layoutTarget) : -1;
  const rest = index === -1 ? targets : targets.toSpliced(index, 1);
  return linkTargetsLeavingRelease(rest, physicalReleaseDir);
}

/**
 * Refuse an already-sealed release (a rollback target, a live release sealed
 * before {@link assertStagedLinksStayInRelease} existed) whose links leave it
 * or reach into `shared`, checked both ways. Lexically first: its `shared`
 * link exists, so resolving through it asks the tenant where the link goes,
 * and only the texts cannot be steered. Then resolved as the tree stands,
 * which by now sends any `../shared/…` tail into the site's real `shared/`,
 * outside the release.
 */
export async function assertSealedLinksStayInRelease(
  releaseDir: string,
  runFn: RunFn,
  asRoot = false,
): Promise<void> {
  const links = await listReleaseLinks(releaseDir, runFn, asRoot);
  const lexical = linksLeavingReleaseLexically(links);
  const resolved = lexical.length > 0
    ? []
    : resolvedTargetsLeavingSealedRelease(
      await releaseLinkTargets(releaseDir, runFn),
      links,
      await physicalPath(releaseDir),
    );
  const leaving = [...lexical, ...resolved];
  if (leaving.length === 0) return;
  throw new Error(
    `release ${releaseDir} has symlinks that leave the release or reach into ` +
      `shared/ (serve shared files through the app, not a link): ${
        describeTargets(leaving)
      }`,
  );
}
