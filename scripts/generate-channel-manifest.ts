import { encodeHex } from "@std/encoding/hex";
import type { ArtifactEntry, ChannelManifest } from "../src/update/types.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.trim() === "") {
    console.error(`Missing required environment variable: ${name}`);
    Deno.exit(1);
  }
  return value;
}

async function artifactFromPublishFile(
  publishDir: string,
  filename: string,
  url: string,
): Promise<ArtifactEntry> {
  const path = `${publishDir}/${filename}`;
  let data: Uint8Array;
  try {
    data = await Deno.readFile(path);
  } catch (error) {
    console.error(`Missing publish artifact: ${path}`);
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
  if (data.byteLength === 0) {
    console.error(`Empty publish artifact: ${path}`);
    Deno.exit(1);
  }
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return {
    url: `${url}?build=${encodeURIComponent(BUILD_ID)}`,
    sha256: encodeHex(new Uint8Array(digest)),
    size: data.byteLength,
  };
}

const BUILD_ID = requireEnv("BUILD_ID");
const SHORT_SHA = requireEnv("SHORT_SHA");
const BUILT_AT = requireEnv("BUILT_AT");

const DL_BASE_URL = Deno.env.get("DL_BASE_URL")?.trim() ||
  "https://dl.trbp.nl";
const DEFAULT_CONTROL_PLANE_URL =
  Deno.env.get("TURBOPANEL_DEFAULT_CONTROL_PLANE_URL")?.trim() ||
  "https://turbopanel.app";

const publishDir = Deno.args[0];
const outputPath = Deno.args[1];

if (!publishDir) {
  console.error(
    "Usage: generate-channel-manifest.ts <publish-daemon-dir> [manifest-output-path]",
  );
  Deno.exit(1);
}

const artifactBase = `${DL_BASE_URL}/channels/trunk/daemon`;

const binaryAmd64 = await artifactFromPublishFile(
  publishDir,
  "turbopaneld-amd64.tar.zst",
  `${artifactBase}/turbopaneld-amd64.tar.zst`,
);
const binaryArm64 = await artifactFromPublishFile(
  publishDir,
  "turbopaneld-arm64.tar.zst",
  `${artifactBase}/turbopaneld-arm64.tar.zst`,
);
const jsFallback = await artifactFromPublishFile(
  publishDir,
  "turbopaneld.js.tar.zst",
  `${artifactBase}/turbopaneld.js.tar.zst`,
);
const orchestration = await artifactFromPublishFile(
  publishDir,
  "orchestration.tar.zst",
  `${artifactBase}/orchestration.tar.zst`,
);

const manifest: ChannelManifest = {
  schema: 1,
  channel: "trunk",
  commit: SHORT_SHA,
  buildId: BUILD_ID,
  builtAt: BUILT_AT,
  defaultControlPlaneUrl: DEFAULT_CONTROL_PLANE_URL,
  binaryArtifacts: {
    "linux-amd64": binaryAmd64,
    "linux-arm64": binaryArm64,
  },
  jsFallbackArtifact: jsFallback,
  orchestrationArtifact: orchestration,
};

const json = JSON.stringify(manifest, null, 2) + "\n";

if (outputPath) {
  await Deno.writeTextFile(outputPath, json);
} else {
  await Deno.stdout.write(new TextEncoder().encode(json));
}
