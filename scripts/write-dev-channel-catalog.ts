/**
 * Write a local overlay catalog (`dist/channels.json` + `dist/manifest.json`)
 * with **relative** artifact URLs so the same files work behind LAN HTTPS,
 * plaintext `:8880`, and a Cloudflare tunnel. Remote `run.sh` / `resolveUpdate`
 * join those URLs against `TURBOPANEL_DL_BASE`.
 *
 * Usage: deno run --allow-read --allow-write scripts/write-dev-channel-catalog.ts
 */
import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";
import type {
  ArtifactEntry,
  ChannelManifest,
  RootCatalog,
} from "../src/update/types.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const DIST = join(ROOT, "dist");

export const ARTIFACTS = {
  "linux-amd64": "turbopaneld-amd64.tar.zst",
  "linux-arm64": "turbopaneld-arm64.tar.zst",
  jsFallback: "turbopaneld.js.tar.zst",
  orchestration: "orchestration.tar.zst",
} as const;

export type OverlayBuildIdentity = {
  commit: string;
  buildId: string;
  builtAt: string;
};

export async function artifactFromDist(
  filename: string,
  distDir = DIST,
): Promise<ArtifactEntry> {
  const path = join(distDir, filename);
  let data: Uint8Array;
  try {
    data = await Deno.readFile(path);
  } catch (error) {
    throw new Error(
      `Missing overlay artifact: ${path} (run deno task compile:all first)`,
      { cause: error },
    );
  }
  if (data.byteLength === 0) {
    throw new Error(`Empty overlay artifact: ${path}`);
  }
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return {
    url: `./${filename}`,
    sha256: encodeHex(new Uint8Array(digest)),
    size: data.byteLength,
  };
}

export async function writeDevChannelCatalog(
  identity: OverlayBuildIdentity,
  distDir = DIST,
): Promise<void> {
  const binaryAmd64 = await artifactFromDist(ARTIFACTS["linux-amd64"], distDir);
  const binaryArm64 = await artifactFromDist(ARTIFACTS["linux-arm64"], distDir);
  const jsFallback = await artifactFromDist(ARTIFACTS.jsFallback, distDir);
  const orchestration = await artifactFromDist(
    ARTIFACTS.orchestration,
    distDir,
  );

  const manifest: ChannelManifest = {
    schema: 1,
    channel: "trunk",
    commit: identity.commit,
    buildId: identity.buildId,
    builtAt: identity.builtAt,
    binaryArtifacts: {
      "linux-amd64": binaryAmd64,
      "linux-arm64": binaryArm64,
    },
    jsFallbackArtifact: jsFallback,
    orchestrationArtifact: orchestration,
  };

  const catalog: RootCatalog = {
    schema: 1,
    defaultChannel: "trunk",
    channels: {
      trunk: { manifestUrl: "./manifest.json" },
    },
  };

  await Deno.writeTextFile(
    join(distDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    join(distDir, "channels.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );

  console.log(`write-dev-channel-catalog: wrote ${distDir}/channels.json`);
  console.log(`write-dev-channel-catalog: wrote ${distDir}/manifest.json`);
  console.log(
    `write-dev-channel-catalog: commit ${identity.commit} buildId ${identity.buildId}`,
  );
}

async function gitShortSha(): Promise<string> {
  const git = new Deno.Command("git", {
    args: ["rev-parse", "--short=7", "HEAD"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await git.output();
  if (!result.success) {
    console.error("write-dev-channel-catalog: git rev-parse failed");
    console.error(new TextDecoder().decode(result.stderr).trim());
    Deno.exit(1);
  }
  return new TextDecoder().decode(result.stdout).trim().toLowerCase();
}

if (import.meta.main) {
  const sha = await gitShortSha();
  const builtAt = new Date();
  const commit = `${sha}+${Math.floor(builtAt.getTime() / 1000)}`;
  await writeDevChannelCatalog({
    commit,
    buildId: `dev-${commit}`,
    builtAt: builtAt.toISOString(),
  });
}
