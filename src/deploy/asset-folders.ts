/**
 * Creating the folders of the scope tree and keeping the record of what each
 * asset folder was first called.
 *
 * ```
 * <home root>/<owner>/                       root:<owner>   0750  jail root
 *   <scope>/                                 root:<owner>   0750  environment name or common
 *     services/                              root:<owner>   0750
 *       <slug>/                              root:<owner>   0750
 *         releases/                          root:<owner>   0750
 *         shared/  logs/                     <owner>:<owner> 0750  writable leaves
 *     volumes/                               root:<owner>   0750
 *       <slug>/                              <owner>:<owner> 0750  bind-mount source
 * ```
 *
 * Every parent is root's, so an owner can empty a leaf but never rename or
 * remove a service, volume or scope folder. Parents are created before
 * children because tp-host refuses a structural folder whose parent is not
 * root-owned and sealed. Creation goes through the one `install -d` seam in
 * `ensure-principal.ts`; this module never invents a second privileged mkdir.
 *
 * The record (`<state>/folders/<assetId>.json`) holds the four components an
 * asset was first created with. A later command naming that asset with other
 * components is refused before any path is touched, so a stale or wrong
 * caller can never move an asset to a new folder.
 */

import { dirname, join } from "@std/path";
import {
  type FolderKind,
  type FolderRef,
  type FolderRefParts,
  parseFolderRef,
  parseFolderRefParts,
} from "../contracts/directory-names.ts";
import {
  assertNoSymlinkComponents,
  assetFolder,
  assetKindDir,
  folderRecordPath,
  type LayoutPaths,
  logsDir,
  releasesDir,
  scopeDir,
  sharedDir,
} from "../paths/layout.ts";
import { forEachSequential } from "../util/sequential.ts";
import {
  ensureDirectoryWithOwner,
  principalUnixGroupName,
  type RunFn,
} from "./ensure-principal.ts";

type HomeLayout = Pick<LayoutPaths, "principalHomeRoot">;
type StateLayout = Pick<LayoutPaths, "principalHomeRoot" | "daemonStateDir">;

/** Thrown when a command names an existing asset with other components than it was created with. */
export class FolderChangedError extends Error {
  readonly code = "folder_changed";
  constructor(assetId: string) {
    super(
      `folder_changed: asset ${assetId} was created with other folder components`,
    );
    this.name = "FolderChangedError";
  }
}

/** What the record file holds. */
export type FolderRecord = FolderRef & { assetId: string; created: string };

const STRUCTURAL_MODE = "0750";
const LEAF_MODE = "0750";

/** Sequentially `install -d` each `[path, owner]` pair at the folder mode. */
async function ensureAll(
  entries: ReadonlyArray<readonly [string, string]>,
  runFn: RunFn | undefined,
): Promise<void> {
  await forEachSequential<readonly [string, string]>(
    entries,
    ([path, owner]) =>
      ensureDirectoryWithOwner(path, STRUCTURAL_MODE, owner, runFn),
  );
}

/** `<owner>/<scope>`, `<scope>/services` and `<scope>/volumes`, root-owned. */
export async function ensureScopeFolders(
  layout: HomeLayout,
  owner: string,
  scope: string,
  runFn?: RunFn,
): Promise<void> {
  const root = `root:${principalUnixGroupName(owner)}`;
  const scopePath = scopeDir(layout, owner, scope);
  await assertNoSymlinkComponents(layout.principalHomeRoot, scopePath);
  await ensureAll([
    [scopePath, root],
    [assetKindDir(layout, owner, scope, "service"), root],
    [assetKindDir(layout, owner, scope, "volume"), root],
  ], runFn);
}

/**
 * A service folder with its root-owned `releases/` and the owner's `shared/`
 * and `logs/` leaves. `public/` is the serving code's to create (it carries the
 * engine group); `current` and the sealed releases are tp-host publish's.
 */
export async function ensureServiceFolder(
  layout: HomeLayout,
  parts: FolderRefParts,
  runFn?: RunFn,
): Promise<string> {
  const ref = parseFolderRefParts(parts, "service");
  const group = principalUnixGroupName(ref.owner);
  const root = `root:${group}`;
  const owned = `${ref.owner}:${group}`;
  const folder = assetFolder(layout, ref);
  await ensureScopeFolders(layout, ref.owner, ref.scope, runFn);
  await assertNoSymlinkComponents(layout.principalHomeRoot, folder);
  await ensureAll([
    [folder, root],
    [releasesDir(layout, parts), root],
  ], runFn);
  await forEachSequential<string>(
    [sharedDir(layout, parts), logsDir(layout, parts)],
    (path) => ensureDirectoryWithOwner(path, LEAF_MODE, owned, runFn),
  );
  return folder;
}

/**
 * A volume folder, `<owner>:<owner> 0750`. The owner fills and empties it over
 * SFTP and a container mounts it; ownership inside is never changed to an
 * image's own user (the daemon sets the container's user instead).
 */
export async function ensureVolumeFolder(
  layout: HomeLayout,
  parts: FolderRefParts,
  runFn?: RunFn,
): Promise<string> {
  const ref = parseFolderRefParts(parts, "volume");
  const folder = assetFolder(layout, ref);
  await ensureScopeFolders(layout, ref.owner, ref.scope, runFn);
  await assertNoSymlinkComponents(layout.principalHomeRoot, folder);
  const group = principalUnixGroupName(ref.owner);
  await ensureDirectoryWithOwner(
    folder,
    LEAF_MODE,
    `${ref.owner}:${group}`,
    runFn,
  );
  return folder;
}

function sameComponents(a: FolderRef, b: FolderRef): boolean {
  return a.owner === b.owner && a.scope === b.scope && a.kind === b.kind &&
    a.slug === b.slug;
}

/** The recorded components of an asset, or `null` when it has none yet. */
export async function readFolderRecord(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  assetId: string,
): Promise<FolderRecord | null> {
  const path = folderRecordPath(layout, assetId);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const ref = parseFolderRef({
    owner: parsed.owner,
    scope: parsed.scope,
    kind: parsed.kind,
    slug: parsed.slug,
  });
  return {
    ...ref,
    assetId,
    created: typeof parsed.created === "string" ? parsed.created : "",
  };
}

/** Refuse a reference that differs from the asset's record. A missing record passes. */
export async function assertFolderUnchanged(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  assetId: string,
  ref: FolderRef,
): Promise<void> {
  const record = await readFolderRecord(layout, assetId);
  if (record !== null && !sameComponents(record, parseFolderRef(ref))) {
    throw new FolderChangedError(assetId);
  }
}

/**
 * Check the reference against the asset's record and write the record when
 * there is none. Returns whether it was newly written. Call before creating
 * the folder so a refused change touches nothing.
 */
export async function recordAssetFolder(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  assetId: string,
  ref: FolderRef,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const checked = parseFolderRef(ref);
  await assertFolderUnchanged(layout, assetId, checked);
  if (await readFolderRecord(layout, assetId) !== null) return false;
  const path = folderRecordPath(layout, assetId);
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const body = JSON.stringify(
    { ...checked, created: now().toISOString() },
    null,
    2,
  );
  const temp = join(dirname(path), `.${assetId}.tmp-${crypto.randomUUID()}`);
  try {
    await Deno.writeTextFile(temp, `${body}\n`, { mode: 0o640 });
    await Deno.rename(temp, path);
  } catch (err) {
    await Deno.remove(temp).catch(() => undefined);
    throw err;
  }
  return true;
}

/** Forget an asset's record (its folder was deleted). Missing is fine. */
export async function removeFolderRecord(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  assetId: string,
): Promise<void> {
  await Deno.remove(folderRecordPath(layout, assetId)).catch((err) => {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  });
}

/**
 * The whole step for one asset: check the record, make the folders, write the
 * record. The kind decides which folders. Returns the asset folder path.
 */
export async function ensureAssetFolder(
  layout: StateLayout,
  assetId: string,
  ref: FolderRef,
  runFn?: RunFn,
): Promise<string> {
  const checked = parseFolderRef(ref);
  await assertFolderUnchanged(layout, assetId, checked);
  const parts = {
    owner: checked.owner,
    scope: checked.scope,
    slug: checked.slug,
  };
  const kind: FolderKind = checked.kind;
  const folder = kind === "service"
    ? await ensureServiceFolder(layout, parts, runFn)
    : await ensureVolumeFolder(layout, parts, runFn);
  await recordAssetFolder(layout, assetId, checked);
  return folder;
}
