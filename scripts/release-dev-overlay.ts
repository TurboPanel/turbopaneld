/**
 * Stamp `src/build-info.ts`, compile overlay artifacts, write the local
 * channel catalog, then restore `build-info.ts` so the checkout stays clean.
 *
 * Remote servers compare `getBuildInfo().commit` (production BUILD_INFO baked
 * into the binary) against the overlay catalog — both must use the same
 * 7-character git short SHA.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { writeDevChannelCatalog } from "./write-dev-channel-catalog.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const BUILD_INFO_PATH = join(ROOT, "src/build-info.ts");

async function gitShortSha(): Promise<string> {
  const git = new Deno.Command("git", {
    args: ["rev-parse", "--short=7", "HEAD"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await git.output();
  if (!result.success) {
    console.error("release-dev-overlay: git rev-parse failed");
    console.error(new TextDecoder().decode(result.stderr).trim());
    Deno.exit(1);
  }
  return new TextDecoder().decode(result.stdout).trim().toLowerCase();
}

function stampBuildInfo(
  source: string,
  identity: { commit: string; buildId: string; builtAt: string },
): string {
  return source
    .replace(/commit: "[^"]*"/, `commit: "${identity.commit}"`)
    .replace(/buildId: "[^"]*"/, `buildId: "${identity.buildId}"`)
    .replace(/builtAt: "[^"]*"/, `builtAt: "${identity.builtAt}"`);
}

async function runCompileAll(): Promise<void> {
  const compile = new Deno.Command(Deno.execPath(), {
    args: ["task", "compile:all"],
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await compile.output();
  if (!status.success) {
    throw new Error(`deno task compile:all exited ${status.code}`);
  }
}

const commit = await gitShortSha();
const identity = {
  commit,
  buildId: `dev-${commit}`,
  builtAt: new Date().toISOString(),
};

const original = await Deno.readTextFile(BUILD_INFO_PATH);
let failed = false;
try {
  await Deno.writeTextFile(BUILD_INFO_PATH, stampBuildInfo(original, identity));
  console.log(
    `release-dev-overlay: stamped build-info commit=${identity.commit} buildId=${identity.buildId}`,
  );
  await runCompileAll();
  await writeDevChannelCatalog(identity);
} catch (error) {
  failed = true;
  console.error(
    error instanceof Error ? error.message : String(error),
  );
} finally {
  await Deno.writeTextFile(BUILD_INFO_PATH, original);
  console.log("release-dev-overlay: restored src/build-info.ts");
}
if (failed) Deno.exit(1);
