import { fetchWithPlatformCa } from "../instance/sockets.ts";
import { errorText } from "../util/logger.ts";
import { fetchWithRetry, type RetryFetchOptions } from "../util/retry-fetch.ts";
import { getBuildInfo } from "../build-info.ts";
import { detectInstallMode, type InstallMode } from "../paths/layout.ts";
import { DAEMON_VERSION } from "../version.ts";
import type { UpdateChannelConfig } from "./config.ts";
import { MalformedManifestError, MissingChannelError } from "./errors.ts";
import { assertNotRollback, type InstalledBuild } from "./freshness.ts";
import { unsignedManifestBypass, verifyManifestSignature } from "./signing.ts";
import type { LinuxArch, UpdateInfo } from "./types.ts";
import {
  absolutizeChannelManifestJson,
  absolutizeRootCatalogJson,
  builtinChannelManifestUrl,
  resolveOverlayDlBase,
  resolvePinnedManifestUrl,
  rootCatalogUrl,
} from "./urls.ts";
import { parseChannelManifest, parseRootCatalog } from "./validate.ts";

function formatFetchErrorCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return "";
}

function describeFetchError(
  context: string,
  err: unknown,
): MalformedManifestError {
  if (err instanceof Error) {
    const cause = formatFetchErrorCause(err.cause);
    const detail = err.message === "fetch failed" && cause
      ? `${err.message} (${cause})`
      : err.message;
    return new MalformedManifestError(`${context}: ${detail}`);
  }
  return new MalformedManifestError(`${context}: ${errorText(err)}`);
}

async function trustedFetch(
  url: string,
  env: Record<string, string | undefined>,
  context: string,
  retry?: RetryFetchOptions,
): Promise<Response> {
  try {
    return await fetchWithRetry(() => fetchWithPlatformCa(url, env), retry);
  } catch (err) {
    throw describeFetchError(context, err);
  }
}

function resolveLinuxArch(): LinuxArch {
  switch (Deno.build.arch) {
    case "x86_64":
      return "linux-amd64";
    case "aarch64":
      return "linux-arm64";
    default:
      throw new MalformedManifestError(
        `Unsupported CPU architecture for daemon updates: ${Deno.build.arch}`,
      );
  }
}

/**
 * Where the channel manifest is read from: the overlay catalog's
 * `channels.json` when `TURBOPANEL_DL_BASE` is an https URL (the catalog hop
 * stays so relative overlay URLs keep working). A configured base that is
 * not https throws from {@link resolveOverlayDlBase} and is not replaced
 * with the public rail. An absent base uses a pinned manifest when
 * `TURBOPANEL_MANIFEST_URL` is set (update-rollback), otherwise the
 * built-in rail — one URL per advertised channel, no catalog fetch.
 */
async function resolveManifestLocation(
  config: UpdateChannelConfig,
  env: Record<string, string | undefined>,
  retry?: RetryFetchOptions,
): Promise<{ manifestUrl: string; overlay: boolean; pinned?: boolean }> {
  const overlayBase = resolveOverlayDlBase(env);
  if (overlayBase === null) {
    const pinned = resolvePinnedManifestUrl(env);
    if (pinned !== null) {
      return { manifestUrl: pinned, overlay: false, pinned: true };
    }
    const manifestUrl = builtinChannelManifestUrl(config.channel);
    if (manifestUrl === null) {
      throw new MissingChannelError(
        `Channel has no built-in manifest location: ${config.channel}`,
      );
    }
    return { manifestUrl, overlay: false };
  }

  const catalogUrl = rootCatalogUrl(overlayBase);
  const catalogResponse = await trustedFetch(
    catalogUrl,
    env,
    "Failed to fetch channels.json",
    retry,
  );
  if (!catalogResponse.ok) {
    throw new MalformedManifestError(
      `Failed to fetch channels.json: HTTP ${catalogResponse.status}`,
    );
  }

  const catalog = parseRootCatalog(
    absolutizeRootCatalogJson(await catalogResponse.json(), catalogUrl),
  );

  const channelEntry = catalog.channels[config.channel];
  if (
    channelEntry === undefined ||
    typeof channelEntry.manifestUrl !== "string" ||
    channelEntry.manifestUrl.trim() === ""
  ) {
    throw new MissingChannelError(
      `Channel not found in catalog: ${config.channel}`,
    );
  }
  return { manifestUrl: channelEntry.manifestUrl, overlay: true };
}

export type ResolveUpdateOptions = {
  /**
   * Which trust regime applies. Defaults to `detectInstallMode(env)`: a
   * daemon running from a source checkout is development and may consume the
   * unsigned dev overlay; a managed install must see a release signature.
   */
  installMode?: InstallMode;
  /** Test seam — pin a different verification key. */
  publicKeyHex?: string;
  /**
   * Test seam — the build the freshness check compares against. Defaults to
   * the running daemon (`DAEMON_VERSION` + the stamped build identity).
   */
  installed?: InstalledBuild;
  /** Retry policy for the manifest reads (tests inject a no-wait sleep). */
  retry?: RetryFetchOptions;
};

function runningBuild(): InstalledBuild {
  const info = getBuildInfo();
  return {
    commit: info.commit,
    version: DAEMON_VERSION,
    builtAt: info.builtAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the manifest body and, unless the development bypass applies, verify
 * its release signature **before** any field is trusted. Verification runs on
 * the manifest as served — relative artifact URLs are absolutised only after
 * the signature check, so the signed bytes are exactly what the release job
 * produced.
 */
async function parseSignedManifestBody(
  body: string,
  options: {
    env: Record<string, string | undefined>;
    installMode: InstallMode;
    overlay: boolean;
    pinned?: boolean;
    publicKeyHex?: string;
  },
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new MalformedManifestError("channel manifest is not valid JSON");
  }
  if (!isRecord(raw)) {
    throw new MalformedManifestError("channel.json root must be an object");
  }
  const bypass = unsignedManifestBypass({
    installMode: options.installMode,
    overlay: options.overlay,
    env: options.env,
    pinned: options.pinned,
  });
  if (!bypass) {
    await verifyManifestSignature(raw, options.publicKeyHex);
  }
  return raw;
}

export async function resolveUpdate(
  config: UpdateChannelConfig,
  env: Record<string, string | undefined> = Deno.env.toObject(),
  options: ResolveUpdateOptions = {},
): Promise<UpdateInfo> {
  const { manifestUrl, overlay, pinned } = await resolveManifestLocation(
    config,
    env,
    options.retry,
  );
  const manifestResponse = await trustedFetch(
    manifestUrl,
    env,
    "Failed to fetch channel manifest",
    options.retry,
  );
  if (!manifestResponse.ok) {
    throw new MalformedManifestError(
      `Failed to fetch channel manifest: HTTP ${manifestResponse.status}`,
    );
  }

  const installMode = options.installMode ?? detectInstallMode(env);
  const verified = await parseSignedManifestBody(
    await manifestResponse.text(),
    { env, installMode, overlay, pinned, publicKeyHex: options.publicKeyHex },
  );
  const manifest = parseChannelManifest(
    absolutizeChannelManifestJson(verified, manifestUrl),
  );

  // A signature proves who made the manifest, not that it is current: refuse
  // a replayed older build before anything is downloaded.
  assertNotRollback(
    options.installed ?? runningBuild(),
    manifest,
    env,
  );

  const arch = resolveLinuxArch();
  const binaryArtifact = manifest.binaryArtifacts[arch];

  return {
    channel: manifest.channel,
    buildId: manifest.buildId,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    binaryArtifact,
    jsFallbackArtifact: manifest.jsFallbackArtifact,
    orchestrationArtifact: manifest.orchestrationArtifact,
    downloadUrl: binaryArtifact.url,
    manifestUrl,
  };
}
