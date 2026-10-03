/**
 * Publish-time symlink checks for a release.
 *
 * The seal re-owns the whole tree `root:<p>-grp` (`chown -R -h`), links
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
  return ["find", releaseDir, "-type", "l", "-printf", "%P\\0%l\\0"];
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
    if (err instanceof Deno.errors.PermissionDenied) return path;
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

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

/** One component of a lexical walk: the new position and what is left. */
type WalkState = { at: string[]; rest: string[]; hops: number };

/**
 * Advance a walk by one component. Returns why the chain is refused, or the
 * next state. A component naming another link in the release is replaced by
 * that link's text, so `..` after it climbs out of its target, as the kernel
 * would; the top-level `shared` is never entered.
 */
function walkStep(
  state: WalkState,
  texts: ReadonlyMap<string, string>,
): WalkState | string {
  const [part, ...rest] = state.rest;
  if (part === "..") {
    if (state.at.length === 0) return "leaves the release";
    return { at: state.at.slice(0, -1), rest, hops: state.hops };
  }
  const at = [...state.at, part];
  if (at.length === 1 && part === RELEASE_SHARED_NAME) {
    return "reaches into shared/";
  }
  const text = texts.get(at.join("/"));
  if (text === undefined) return { at, rest, hops: state.hops };
  if (text.startsWith("/")) return "leaves the release";
  if (state.hops >= MAX_LINK_HOPS) return "loops";
  return {
    at: state.at,
    rest: [...segments(text), ...rest],
    hops: state.hops + 1,
  };
}

/**
 * Why `link` fails the lexical check, or `null` when its whole chain stays in
 * the release and out of `shared`. Only the link texts recorded in `texts` are
 * followed — never the filesystem, so nothing the tenant keeps in `shared/`
 * (or anywhere else) can change the answer.
 */
function lexicalLinkProblem(
  link: ReleaseLink,
  texts: ReadonlyMap<string, string>,
): string | null {
  if (link.text.startsWith("/")) return "leaves the release";
  let state: WalkState | string = {
    at: segments(dirname(link.path)),
    rest: segments(link.text),
    hops: 0,
  };
  while (typeof state !== "string" && state.rest.length > 0) {
    state = walkStep(state, texts);
  }
  return typeof state === "string" ? state : null;
}

/**
 * Links (other than the layout's own top-level `shared`) whose chain, followed
 * lexically inside the release, leaves it or lands in `shared`. Each is
 * reported as `<path> -> <text> (<why>)`.
 */
export function linksLeavingReleaseLexically(
  links: readonly ReleaseLink[],
): string[] {
  const texts = new Map(links.map((link) => [link.path, link.text]));
  return links
    .filter((link) => link.path !== RELEASE_SHARED_NAME)
    .flatMap((link) => {
      const problem = lexicalLinkProblem(link, texts);
      return problem === null
        ? []
        : [`${link.path} -> ${link.text} (${problem})`];
    });
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

/** Every symlink under `dir`, read as the daemon (no privilege). */
async function readReleaseLinks(
  root: string,
  relative: string,
): Promise<ReleaseLink[]> {
  const dir = relative === "" ? root : join(root, relative);
  const entries = await Array.fromAsync(Deno.readDir(dir));
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymlink) {
      return [{ path, text: await Deno.readLink(join(root, path)) }];
    }
    return entry.isDirectory ? await readReleaseLinks(root, path) : [];
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
 * Refuse an already-sealed release (a rollback target, a live release sealed
 * before {@link assertStagedLinksStayInRelease} existed) whose links leave it
 * or reach into `shared`. Lexical on purpose: its `shared` link exists, so
 * resolving through it would ask the tenant where the link goes.
 */
export async function assertSealedLinksStayInRelease(
  releaseDir: string,
  runFn: RunFn,
  asRoot = false,
): Promise<void> {
  const leaving = linksLeavingReleaseLexically(
    await listReleaseLinks(releaseDir, runFn, asRoot),
  );
  if (leaving.length === 0) return;
  throw new Error(
    `release ${releaseDir} has symlinks that leave the release or reach into ` +
      `shared/ (serve shared files through the app, not a link): ${
        describeTargets(leaving)
      }`,
  );
}
