import { dirname, fromFileUrl, join } from "@std/path";
import { detectInstallMode } from "./paths/layout.ts";

export interface BuildInfo {
  commit: string;
  buildId: string;
  builtAt: string;
  channel: string;
}

export const BUILD_INFO: BuildInfo = {
  commit: "fb62ec5+1786916563",
  buildId: "dev-fb62ec5+1786916563",
  builtAt: "2026-08-16T21:42:43.985Z",
  channel: "trunk",
};

function resolveDaemonCheckoutRoot(): string {
  return join(dirname(fromFileUrl(import.meta.url)), "..");
}

/** Read the current short git commit from a checkout (sync, no subprocess). */
export function readGitShortCommit(checkoutRoot: string): string | null {
  try {
    const gitDir = join(checkoutRoot, ".git");
    const headText = Deno.readTextFileSync(join(gitDir, "HEAD")).trim();
    let fullHash: string;
    if (headText.startsWith("ref: ")) {
      const refRel = headText.slice("ref: ".length).trim();
      fullHash = Deno.readTextFileSync(join(gitDir, refRel)).trim();
    } else {
      fullHash = headText;
    }
    if (!/^[0-9a-f]{7,40}$/i.test(fullHash)) return null;
    return fullHash.slice(0, 7).toLowerCase();
  } catch {
    return null;
  }
}

function resolveDevelopmentBuildInfo(): BuildInfo {
  const gitCommit = readGitShortCommit(resolveDaemonCheckoutRoot());
  if (gitCommit) {
    return {
      commit: gitCommit,
      buildId: `dev-${gitCommit}`,
      builtAt: BUILD_INFO.builtAt,
      channel: BUILD_INFO.channel,
    };
  }
  return {
    commit: "dev",
    buildId: "dev",
    builtAt: BUILD_INFO.builtAt,
    channel: BUILD_INFO.channel,
  };
}

export function getBuildInfo(): BuildInfo {
  if (
    detectInstallMode(Deno.env.toObject(), {
      fromMeta: resolveDaemonCheckoutRoot(),
    }) === "development"
  ) {
    return resolveDevelopmentBuildInfo();
  }
  return BUILD_INFO;
}
