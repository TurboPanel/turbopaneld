import type { UpdateChannelConfig } from "./config.ts";
import {
  MalformedManifestError,
  MissingChannelError,
} from "./errors.ts";
import type { LinuxArch, UpdateInfo } from "./types.ts";
import { DL_BASE_URL, rootCatalogUrl } from "./urls.ts";
import { parseChannelManifest, parseRootCatalog } from "./validate.ts";

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

  const arch = resolveLinuxArch();
  const binaryArtifact = manifest.binaryArtifacts[arch];

  return {
    channel: manifest.channel,
    buildId: manifest.buildId,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    binaryArtifact,
    jsFallbackArtifact: manifest.jsFallbackArtifact,
    orchestrationArtifact: manifest.orchestrationArtifact,
    downloadUrl: binaryArtifact.url,
  };
}
