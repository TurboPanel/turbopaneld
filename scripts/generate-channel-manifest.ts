import { encodeHex } from "@std/encoding/hex";
import type { ArtifactEntry, ChannelManifest } from "../src/update/types.ts";

export function requireEnv(
  name: string,
  getEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string {
  const value = getEnv(name);
  if (!value || value.trim() === "") {
    console.error(`Missing required environment variable: ${name}`);
    throw new TypeError(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function artifactFromPublishFile(
  publishDir: string,
  filename: string,
  urlBase: string,
  buildId: string,
): Promise<ArtifactEntry> {
  const path = `${publishDir}/${filename}`;
  let data: Uint8Array;
  try {
    data = await Deno.readFile(path);
  } catch (error) {
    console.error(`Missing publish artifact: ${path}`);
    console.error(error instanceof Error ? error.message : String(error));
    throw error instanceof Error ? error : new TypeError(String(error));
  }
  if (data.byteLength === 0) {
    console.error(`Empty publish artifact: ${path}`);
    throw new TypeError(`Empty publish artifact: ${path}`);
  }
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return {
    // Version artifact paths by buildId — Bunny CDN ignores ?build= cache-bust params.
    url: `${urlBase}/${buildId}/${filename}`,
    sha256: encodeHex(new Uint8Array(digest)),
    size: data.byteLength,
  };
}

export async function generateChannelManifest(options: {
  publishDir: string;
  outputPath?: string;
  buildId: string;
  shortSha: string;
  builtAt: string;
  dlBaseUrl?: string;
  defaultControlPlaneUrl?: string;
  writeTextFile?: (path: string, json: string) => Promise<void>;
  writeStdout?: (json: string) => Promise<void>;
}): Promise<ChannelManifest> {
  const artifactBase = `${
    options.dlBaseUrl ?? "https://dl.trbp.nl"
  }/channels/trunk/daemon`;

  const binaryAmd64 = await artifactFromPublishFile(
    options.publishDir,
    "turbopaneld-amd64.tar.zst",
    artifactBase,
    options.buildId,
  );
  const binaryArm64 = await artifactFromPublishFile(
    options.publishDir,
    "turbopaneld-arm64.tar.zst",
    artifactBase,
    options.buildId,
  );
  const jsFallback = await artifactFromPublishFile(
    options.publishDir,
    "turbopaneld.js.tar.zst",
    artifactBase,
    options.buildId,
  );
  const orchestration = await artifactFromPublishFile(
    options.publishDir,
    "orchestration.tar.zst",
    artifactBase,
    options.buildId,
  );

  const manifest: ChannelManifest = {
    schema: 1,
    channel: "trunk",
    commit: options.shortSha,
    buildId: options.buildId,
    builtAt: options.builtAt,
    defaultControlPlaneUrl: options.defaultControlPlaneUrl ??
      "https://turbopanel.app",
    binaryArtifacts: {
      "linux-amd64": binaryAmd64,
      "linux-arm64": binaryArm64,
    },
    jsFallbackArtifact: jsFallback,
    orchestrationArtifact: orchestration,
  };

  const json = JSON.stringify(manifest, null, 2) + "\n";

  if (options.outputPath) {
    await (options.writeTextFile ?? Deno.writeTextFile)(
      options.outputPath,
      json,
    );
  } else {
    await (options.writeStdout ??
      ((body: string) =>
        Deno.stdout.write(new TextEncoder().encode(body)).then(() =>
          undefined
        )))(
        json,
      );
  }
  return manifest;
}

if (import.meta.main) {
  try {
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

    await generateChannelManifest({
      publishDir,
      outputPath,
      buildId: BUILD_ID,
      shortSha: SHORT_SHA,
      builtAt: BUILT_AT,
      dlBaseUrl: DL_BASE_URL,
      defaultControlPlaneUrl: DEFAULT_CONTROL_PLANE_URL,
    });
  } catch {
    Deno.exit(1);
  }
}
