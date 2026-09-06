import { dirname, fromFileUrl, join } from "@std/path";
import { detectInstallMode } from "./paths/layout.ts";

export interface BuildInfo {
  commit: string;
  buildId: string;
  builtAt: string;
  channel: string;
  sourceUrl: string;
}

const SOURCE_REPO = "https://github.com/TurboPanel/turbopaneld";

export function sourceUrlForCommit(commit: string): string {
  const plus = commit.indexOf("+");
  const sha = (plus === -1 ? commit : commit.slice(0, plus)).trim();
  if (!sha || sha === "dev") return SOURCE_REPO;
  return `${SOURCE_REPO}/tree/${sha}`;
}

export const BUILD_INFO: BuildInfo = {
  commit: "fb62ec5+1786916563",
  buildId: "dev-fb62ec5+1786916563",
  builtAt: "2026-08-16T21:42:43.985Z",
  channel: "trunk",
  sourceUrl: sourceUrlForCommit("fb62ec5+1786916563"),
};

function resolveDaemonCheckoutRoot(): string {
  return join(dirname(fromFileUrl(import.meta.url)), "..");
}

/** Read the current full git commit from a checkout (sync, no subprocess). */
export function readGitCommit(checkoutRoot: string): string | null {
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
    if (!/^[0-9a-f]{40}$/i.test(fullHash)) return null;
    return fullHash.toLowerCase();
  } catch {
    return null;
  }
}

/** Short display SHA for buildId / logs. Release identity uses {@link readGitCommit}. */
export function readGitShortCommit(checkoutRoot: string): string | null {
  const full = readGitCommit(checkoutRoot);
  return full ? full.slice(0, 7) : null;
}

function resolveDevelopmentBuildInfo(): BuildInfo {
  const gitCommit = readGitCommit(resolveDaemonCheckoutRoot());
  const shortCommit = readGitShortCommit(resolveDaemonCheckoutRoot());
  if (gitCommit) {
    return {
      commit: gitCommit,
      buildId: `dev-${shortCommit ?? gitCommit.slice(0, 7)}`,
      builtAt: BUILD_INFO.builtAt,
      channel: BUILD_INFO.channel,
      sourceUrl: sourceUrlForCommit(gitCommit),
    };
  }
  return {
    commit: "dev",
    buildId: "dev",
    builtAt: BUILD_INFO.builtAt,
    channel: BUILD_INFO.channel,
    sourceUrl: SOURCE_REPO,
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
