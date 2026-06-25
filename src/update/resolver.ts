import type { UpdateChannelConfig } from "./config.ts";
import {
  MalformedManifestError,
  MissingArtifactError,
  MissingChannelError,
} from "./errors.ts";
import { resolveCurrentPlatform } from "./platform.ts";
import type { UpdateInfo } from "./types.ts";
import { DL_BASE_URL, rootCatalogUrl } from "./urls.ts";
import { parseChannelManifest, parseRootCatalog } from "./validate.ts";

export async function resolveUpdate(
  config: UpdateChannelConfig,
): Promise<UpdateInfo> {
  const catalogResponse = await fetch(rootCatalogUrl(DL_BASE_URL));
  if (!catalogResponse.ok) {
    throw new MalformedManifestError(
      `Failed to fetch channels.json: HTTP ${catalogResponse.status}`,
    );
  }

  const catalog = parseRootCatalog(await catalogResponse.json());

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

  const manifestResponse = await fetch(channelEntry.manifestUrl);
  if (!manifestResponse.ok) {
    throw new MalformedManifestError(
      `Failed to fetch channel manifest: HTTP ${manifestResponse.status}`,
    );
  }

  const manifest = parseChannelManifest(await manifestResponse.json());

  const platform = resolveCurrentPlatform();

  const artifact = manifest.artifacts[platform];
  if (artifact === undefined) {
    throw new MissingArtifactError(
      `No artifact for platform ${platform} in ${config.channel} build ${manifest.buildId}`,
    );
  }

  return {
    channel: manifest.channel,
    buildId: manifest.buildId,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    platform,
    artifact,
    downloadUrl: artifact.url,
  };
}
