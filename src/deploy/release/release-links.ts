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
 */
import { dirname } from "@std/path";
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
  const foreign = foreignLinkTargets(targets, paths.principalHome);
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
  const leaving = linkTargetsLeavingRelease(targets, releaseDir);
  if (leaving.length === 0) return;
  throw new Error(
    `release ${releaseDir} has symlinks that leave the release or reach into ` +
      `shared/ (serve shared files through the app, not a link): ${
        describeTargets(leaving)
      }`,
  );
}
