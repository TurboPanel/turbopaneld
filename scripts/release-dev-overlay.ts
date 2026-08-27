/**
 * Stamp `src/build-info.ts`, compile overlay artifacts, write the local
 * channel catalog, then restore `build-info.ts` so the checkout stays clean.
 *
 * Remote servers skip `#reconcileToLatestUpdate` when baked
 * `getBuildInfo().commit` equals the overlay catalog commit. A plain 7-char
 * git SHA never changes until HEAD moves, so **U** would no-op after the first
 * overlay of that commit. Stamp `<sha>+<unix-seconds>` (and matching `buildId`)
 * so each `release:dev` is a new identity remotes will actually install.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import {
  type OverlayBuildIdentity,
  writeDevChannelCatalog,
} from "./write-dev-channel-catalog.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const BUILD_INFO_PATH = join(ROOT, "src/build-info.ts");

export type ReleaseDevOverlayHooks = {
  gitShortSha?: () => Promise<string>;
  now?: () => Date;
  readBuildInfo?: () => Promise<string>;
  writeBuildInfo?: (text: string) => Promise<void>;
  compileAll?: () => Promise<void>;
  writeCatalog?: (identity: OverlayBuildIdentity) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  exit?: (code: number) => void;
};

export async function resolveOverlayGitShortSha(
  cwd = ROOT,
  io: {
    output?: () => Promise<
      { success: boolean; stdout: Uint8Array; stderr: Uint8Array }
    >;
    error?: (message: string) => void;
    exit?: (code: number) => void;
  } = {},
): Promise<string> {
  const output = io.output ?? (() =>
    new Deno.Command("git", {
      args: ["rev-parse", "--short=7", "HEAD"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output());
  const result = await output();
  if (!result.success) {
    const error = io.error ?? ((message: string) => {
      console.error(message);
    });
    const exit = io.exit ?? ((code: number) => {
      Deno.exit(code);
    });
    error("release-dev-overlay: git rev-parse failed");
    error(new TextDecoder().decode(result.stderr).trim());
    exit(1);
    throw new TypeError("git rev-parse failed");
  }
  return new TextDecoder().decode(result.stdout).trim().toLowerCase();
}

export function stampBuildInfo(
  source: string,
  identity: { commit: string; buildId: string; builtAt: string },
): string {
  return source
    .replace(/commit: "[^"]*"/, `commit: "${identity.commit}"`)
    .replace(/buildId: "[^"]*"/, `buildId: "${identity.buildId}"`)
    .replace(/builtAt: "[^"]*"/, `builtAt: "${identity.builtAt}"`);
}

export async function runCompileAll(
  run: () => Promise<{ success: boolean; code: number }> = () =>
    new Deno.Command(Deno.execPath(), {
      args: ["task", "compile:all"],
      cwd: ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).output(),
): Promise<void> {
  const status = await run();
  if (!status.success) {
    throw new Error(`deno task compile:all exited ${status.code}`);
  }
}

export async function runReleaseDevOverlay(
  hooks: ReleaseDevOverlayHooks = {},
): Promise<void> {
  const gitShortSha = hooks.gitShortSha ?? (() => resolveOverlayGitShortSha());
  const now = hooks.now ?? (() => new Date());
  const readBuildInfo = hooks.readBuildInfo ??
    (() => Deno.readTextFile(BUILD_INFO_PATH));
  const writeBuildInfo = hooks.writeBuildInfo ??
    ((text: string) => Deno.writeTextFile(BUILD_INFO_PATH, text));
  const compileAll = hooks.compileAll ?? (() => runCompileAll());
  const writeCatalog = hooks.writeCatalog ??
    ((identity: OverlayBuildIdentity) => writeDevChannelCatalog(identity));
  const log = hooks.log ?? ((message: string) => {
    console.log(message);
  });
  const error = hooks.error ?? ((message: string) => {
    console.error(message);
  });
  const exit = hooks.exit ?? ((code: number) => {
    Deno.exit(code);
  });

  const sha = await gitShortSha();
  const builtAt = now();
  const commit = `${sha}+${Math.floor(builtAt.getTime() / 1000)}`;
  const identity: OverlayBuildIdentity = {
    commit,
    buildId: `dev-${commit}`,
    builtAt: builtAt.toISOString(),
  };

  const original = await readBuildInfo();
  let failed = false;
  try {
    await writeBuildInfo(stampBuildInfo(original, identity));
    log(
      `release-dev-overlay: stamped build-info commit=${identity.commit} buildId=${identity.buildId}`,
    );
    await compileAll();
    await writeCatalog(identity);
  } catch (err) {
    failed = true;
    error(err instanceof Error ? err.message : String(err));
  } finally {
    await writeBuildInfo(original);
    log("release-dev-overlay: restored src/build-info.ts");
  }
  if (failed) exit(1);
}

if (import.meta.main) {
  await runReleaseDevOverlay();
}
