import type { UpdateChannelConfig } from "./config.ts";
import {
  MalformedManifestError,
  MissingArtifactError,
  MissingChannelError,
  UnsupportedAppError,
} from "./errors.ts";
import { resolveCurrentPlatform } from "./platform.ts";
import type { UpdateInfo } from "./types.ts";
import {
  artifactUrl,
  channelManifestUrl,
  DL_BASE_URL,
  rootCatalogUrl,
} from "./urls.ts";
import { parseChannelManifest, parseRootCatalog } from "./validate.ts";

export async function resolveUpdate(
  config: UpdateChannelConfig,
  options?: { baseUrl?: string },
): Promise<UpdateInfo> {
  const baseUrl = options?.baseUrl ?? DL_BASE_URL;

  const catalogResponse = await fetch(rootCatalogUrl(baseUrl));
  if (!catalogResponse.ok) {
    throw new MalformedManifestError(
      `Failed to fetch channels.json: HTTP ${catalogResponse.status}`,
    );
  }

  const catalog = parseRootCatalog(await catalogResponse.json());

  const appEntry = catalog.apps[config.app];
  if (appEntry === undefined) {
    throw new UnsupportedAppError(
      `App not found in catalog: ${config.app}`,
    );
  }

  const catalogEntry = appEntry.channels[config.channel];
  if (catalogEntry === undefined) {
    throw new MissingChannelError(
      `Channel not found in catalog for app ${config.app}: ${config.channel}`,
    );
  }

  const manifestResponse = await fetch(
    channelManifestUrl(catalogEntry.manifest, baseUrl),
  );
  if (!manifestResponse.ok) {
    throw new MalformedManifestError(
      `Failed to fetch channel.json: HTTP ${manifestResponse.status}`,
    );
  }

  const manifest = parseChannelManifest(await manifestResponse.json());

  const platform = resolveCurrentPlatform();

  const artifact = manifest.artifacts[platform];
  if (artifact === undefined) {
    throw new MissingArtifactError(
      `No artifact for platform ${platform} in ${config.app}/${config.channel} build ${manifest.buildId}`,
    );
  }

  const downloadUrl = artifactUrl(artifact.path, baseUrl);

  return {
    app: manifest.app,
    channel: manifest.channel,
    version: manifest.version,
    buildId: manifest.buildId,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    platform,
    artifact,
    downloadUrl,
  };
}
