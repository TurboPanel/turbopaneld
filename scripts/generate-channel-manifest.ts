import { encodeHex } from "@std/encoding/hex";
import type {
  ArtifactEntry,
  ChannelManifest,
  UpdateChannel,
} from "../src/update/types.ts";

/**
 * Mirrors scripts/lib/release-artifacts.sh's tp_daemon_release_filename /
 * tp_orchestration_release_filename / tp_js_release_filename — the manifest
 * generator has to read the exact filenames those bash helpers produce.
 * Unversioned (no `version`) matches today's trunk-channel output exactly.
 */
export function daemonReleaseFilename(
  arch: "amd64" | "arm64",
  version?: string,
): string {
  return version
    ? `turbopaneld-${version}-${arch}.tar.zst`
    : `turbopaneld-${arch}.tar.zst`;
}

export function orchestrationReleaseFilename(version?: string): string {
  return version ? `orchestration-${version}.tar.zst` : `orchestration.tar.zst`;
}

export function jsReleaseFilename(version?: string): string {
  return version
    ? `turbopaneld.js-${version}.tar.zst`
    : `turbopaneld.js.tar.zst`;
}

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

/**
 * Where a release build's assets are downloaded from: the tag-pinned GitHub
 * Release download path. Absolute and pinned to the tag (not
 * `releases/latest/download/…`) so a promotion landing between a daemon's
 * manifest fetch and its asset fetch can never make a versioned filename 404.
 */
export function githubReleaseDownloadBase(
  repository: string,
  version: string,
): string {
  return `https://github.com/${repository}/releases/download/v${version}`;
}

export async function artifactFromPublishFile(
  publishDir: string,
  filename: string,
  urlBase: string,
  buildId?: string,
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
    // CDN drops version artifact paths by buildId — Bunny CDN ignores
    // ?build= cache-bust params. A GitHub Release is already immutable per
    // tag, so its base carries the filename directly.
    url: buildId
      ? `${urlBase}/${buildId}/${filename}`
      : `${urlBase}/${filename}`,
    sha256: encodeHex(new Uint8Array(digest)),
    size: data.byteLength,
  };
}

export async function generateChannelManifest(options: {
  publishDir: string;
  outputPath?: string;
  buildId: string;
  commit: string;
  builtAt: string;
  dlBaseUrl?: string;
  defaultControlPlaneUrl?: string;
  /** Which channel this manifest publishes to. Default `"trunk"` — unchanged trunk behavior. */
  channel?: UpdateChannel;
  /**
   * Release version (e.g. `0.1.0-rc1`), present only for a tagged release
   * build. Unset (the trunk default) produces today's unversioned filenames;
   * set, it switches to versioned filenames matching
   * scripts/lib/release-artifacts.sh's naming helpers.
   */
  version?: string;
  /**
   * Where the assets are downloaded from, verbatim — `<base>/<filename>`
   * with no buildId segment. Set by the GitHub Release job to the
   * tag-pinned `releases/download/v<version>` path (see
   * `githubReleaseDownloadBase`); unset, the CDN drop's
   * `<dlBaseUrl>/channels/<channel>/daemon/<buildId>/…` scheme applies.
   */
  artifactBaseUrl?: string;
  writeTextFile?: (path: string, json: string) => Promise<void>;
  writeStdout?: (json: string) => Promise<void>;
}): Promise<ChannelManifest> {
  const channel: UpdateChannel = options.channel ?? "trunk";
  const artifactBase = options.artifactBaseUrl ??
    `${options.dlBaseUrl ?? "https://dl.trbp.nl"}/channels/${channel}/daemon`;
  // Only the CDN scheme segments by buildId.
  const buildIdSegment = options.artifactBaseUrl ? undefined : options.buildId;

  const binaryAmd64 = await artifactFromPublishFile(
    options.publishDir,
    daemonReleaseFilename("amd64", options.version),
    artifactBase,
    buildIdSegment,
  );
  const binaryArm64 = await artifactFromPublishFile(
    options.publishDir,
    daemonReleaseFilename("arm64", options.version),
    artifactBase,
    buildIdSegment,
  );
  const jsFallback = await artifactFromPublishFile(
    options.publishDir,
    jsReleaseFilename(options.version),
    artifactBase,
    buildIdSegment,
  );
  const orchestration = await artifactFromPublishFile(
    options.publishDir,
    orchestrationReleaseFilename(options.version),
    artifactBase,
    buildIdSegment,
  );

  const manifest: ChannelManifest = {
    schema: 1,
    channel,
    commit: options.commit,
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

export type GenerateChannelManifestCliIo = {
  env?: Record<string, string | undefined>;
  args?: string[];
  error?: (message: string) => void;
  exit?: (code: number) => void;
  generate?: typeof generateChannelManifest;
};

export async function runGenerateChannelManifestCli(
  io: GenerateChannelManifestCliIo = {},
): Promise<void> {
  const getEnv = (name: string) => io.env?.[name] ?? Deno.env.get(name);
  const args = io.args ?? Deno.args;
  const error = io.error ?? ((message: string) => {
    console.error(message);
  });
  const exit = io.exit ?? ((code: number) => {
    Deno.exit(code);
  });
  const generate = io.generate ?? generateChannelManifest;

  try {
    const BUILD_ID = requireEnv("BUILD_ID", getEnv);
    const GIT_COMMIT = requireEnv("GIT_COMMIT", getEnv);
    const BUILT_AT = requireEnv("BUILT_AT", getEnv);

    const DL_BASE_URL = getEnv("DL_BASE_URL")?.trim() ||
      "https://dl.trbp.nl";
    const DEFAULT_CONTROL_PLANE_URL =
      getEnv("TURBOPANEL_DEFAULT_CONTROL_PLANE_URL")?.trim() ||
      "https://turbopanel.app";
    // Both optional, both default to today's trunk/unversioned behavior.
    const CHANNEL = (getEnv("CHANNEL")?.trim() ||
      "trunk") as UpdateChannel;
    const VERSION = getEnv("RELEASE_VERSION")?.trim() || undefined;
    // Set by release.yml to the tag-pinned GitHub download path; the trunk
    // drop leaves it unset and keeps the CDN scheme.
    const ARTIFACT_BASE_URL = getEnv("ARTIFACT_BASE_URL")?.trim() ||
      undefined;

    const publishDir = args[0];
    const outputPath = args[1];

    if (!publishDir) {
      error(
        "Usage: generate-channel-manifest.ts <publish-daemon-dir> [manifest-output-path]",
      );
      exit(1);
      return;
    }

    await generate({
      publishDir,
      outputPath,
      buildId: BUILD_ID,
      commit: GIT_COMMIT,
      builtAt: BUILT_AT,
      dlBaseUrl: DL_BASE_URL,
      defaultControlPlaneUrl: DEFAULT_CONTROL_PLANE_URL,
      channel: CHANNEL,
      version: VERSION,
      artifactBaseUrl: ARTIFACT_BASE_URL,
    });
  } catch {
    exit(1);
  }
}

if (import.meta.main) {
  await runGenerateChannelManifestCli();
}
