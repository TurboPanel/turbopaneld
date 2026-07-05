import {
  MalformedManifestError,
  UnsupportedSchemaVersionError,
} from "./errors.ts";
import type {
  ArtifactEntry,
  BinaryArtifacts,
  ChannelManifest,
  LinuxArch,
  RootCatalog,
} from "./types.ts";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireHttpsUrl(url: string, fieldName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MalformedManifestError(`${fieldName} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new MalformedManifestError(`${fieldName} must use HTTPS`);
  }
}

export function validateArtifactEntry(
  entry: unknown,
  fieldName: string,
): ArtifactEntry {
  if (!isObject(entry)) {
    throw new MalformedManifestError(`${fieldName} must be an object`);
  }

  if (typeof entry.url !== "string" || entry.url.trim() === "") {
    throw new MalformedManifestError(
      `${fieldName} missing or invalid field: url`,
    );
  }
  requireHttpsUrl(entry.url, `${fieldName}.url`);

  if (typeof entry.sha256 !== "string" || !SHA256_HEX_RE.test(entry.sha256)) {
    throw new MalformedManifestError(
      `${fieldName} missing or invalid field: sha256`,
    );
  }

  if (typeof entry.size !== "number" || !Number.isFinite(entry.size) ||
    entry.size <= 0) {
    throw new MalformedManifestError(
      `${fieldName} missing or invalid field: size`,
    );
  }

  return entry as unknown as ArtifactEntry;
}

const LINUX_ARCHES: LinuxArch[] = ["linux-amd64", "linux-arm64"];

export function validateBinaryArtifacts(entry: unknown): BinaryArtifacts {
  if (!isObject(entry)) {
    throw new MalformedManifestError(
      "channel.json binaryArtifacts must be an object",
    );
  }

  const artifacts = {} as BinaryArtifacts;
  for (const arch of LINUX_ARCHES) {
    artifacts[arch] = validateArtifactEntry(
      entry[arch],
      `channel.json binaryArtifacts.${arch}`,
    );
  }
  return artifacts;
}

export function parseRootCatalog(raw: unknown): RootCatalog {
  if (!isObject(raw)) {
    throw new MalformedManifestError("channels.json root must be an object");
  }

  if (typeof raw.schema !== "number") {
    throw new MalformedManifestError(
      "channels.json missing or invalid field: schema",
    );
  }

  if (raw.schema !== 1) {
    throw new UnsupportedSchemaVersionError(
      `Unsupported channels.json schema: ${raw.schema}`,
    );
  }

  if (typeof raw.defaultChannel !== "string") {
    throw new MalformedManifestError(
      "channels.json missing or invalid field: defaultChannel",
    );
  }

  if (!isObject(raw.channels)) {
    throw new MalformedManifestError(
      "channels.json missing or invalid field: channels",
    );
  }

  const catalog = raw as unknown as RootCatalog;
  for (const [channelName, channelEntry] of Object.entries(catalog.channels)) {
    if (
      channelEntry === undefined ||
      typeof channelEntry.manifestUrl !== "string" ||
      channelEntry.manifestUrl.trim() === ""
    ) {
      throw new MalformedManifestError(
        `channels.json channel ${channelName} missing or invalid manifestUrl`,
      );
    }
    requireHttpsUrl(
      channelEntry.manifestUrl,
      `channels.json channel ${channelName}.manifestUrl`,
    );
  }

  return catalog;
}

export function parseChannelManifest(raw: unknown): ChannelManifest {
  if (!isObject(raw)) {
    throw new MalformedManifestError("channel.json root must be an object");
  }

  if (typeof raw.schema !== "number") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: schema",
    );
  }

  if (raw.schema !== 1) {
    throw new UnsupportedSchemaVersionError(
      `Unsupported channel.json schema: ${raw.schema}`,
    );
  }

  if (typeof raw.channel !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: channel",
    );
  }

  if (typeof raw.commit !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: commit",
    );
  }

  if (typeof raw.buildId !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: buildId",
    );
  }

  if (typeof raw.builtAt !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: builtAt",
    );
  }

  const binaryArtifacts = validateBinaryArtifacts(raw.binaryArtifacts);
  const jsFallbackArtifact = validateArtifactEntry(
    raw.jsFallbackArtifact,
    "channel.json jsFallbackArtifact",
  );
  const orchestrationArtifact = validateArtifactEntry(
    raw.orchestrationArtifact,
    "channel.json orchestrationArtifact",
  );

  return {
    ...(raw as unknown as ChannelManifest),
    binaryArtifacts,
    jsFallbackArtifact,
    orchestrationArtifact,
  };
}
