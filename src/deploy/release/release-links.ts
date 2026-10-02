/**
 * Publish-time symlink check for a sealed release.
 *
 * The seal re-owns the whole tree `root:<p>-grp` (`chown -R -h`), links
 * included, so a build that ships `x → /srv/users/bob/sites/app/current/…`
 * would pass the engines' owner-match rules (nginx `disable_symlinks
 * if_not_owner`, Apache `SymLinksIfOwnerMatch`, OpenLiteSpeed
 * `allowSymbolLink 2`): bob's published release is root-owned too. Engines are
 * in every principal's group, so such a link would serve bob's files from
 * this site. Every link is therefore resolved physically, as root, once the
 * tree is frozen, and a release is refused when one lands in another
 * principal's home.
 *
 * Links that resolve elsewhere (a venv's `bin/python` → the vendored
 * interpreter, `node_modules/.bin/*`, the `shared` link) stay allowed: outside
 * the homes the engines' own account permissions still apply.
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
 * Refuse a sealed release with a symlink into another principal's home. Fails
 * closed: a listing that cannot be completed (a link loop, a missing tree) is
 * an error too.
 */
export async function assertReleaseLinksStayHome(
  paths: Pick<ReleasePaths, "principalHome">,
  releaseDir: string,
  runFn: RunFn,
): Promise<void> {
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
  const targets = result.stdout.split("\0").filter((path) => path.length > 0);
  const foreign = foreignLinkTargets(targets, paths.principalHome);
  if (foreign.length === 0) return;
  const named = foreign.slice(0, REPORTED_TARGETS).join(", ");
  const more = foreign.length > REPORTED_TARGETS
    ? ` (and ${foreign.length - REPORTED_TARGETS} more)`
    : "";
  throw new Error(
    `release ${releaseDir} has symlinks into another account's files: ${named}${more}`,
  );
}
