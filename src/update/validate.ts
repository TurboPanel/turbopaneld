import {
  MalformedManifestError,
  UnsupportedSchemaVersionError,
} from "./errors.ts";
import { MANIFEST_SIGNATURE_ALG, type ManifestSignature } from "./signing.ts";
import type {
  ArtifactEntry,
  BinaryArtifacts,
  ChannelManifest,
  LinuxArch,
  RootCatalog,
} from "./types.ts";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireHttpsUrl(url: string, fieldName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MalformedManifestError(
      `${fieldName} must be a valid absolute URL`,
    );
  }
  if (parsed.protocol === "https:") return;
  throw new MalformedManifestError(`${fieldName} must use HTTPS`);
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

  if (
    typeof entry.size !== "number" || !Number.isFinite(entry.size) ||
    entry.size <= 0
  ) {
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

/**
 * Structural check of the `signature` field: an Ed25519 signature object with
 * a key id and a base64 value. Cryptographic verification against the pinned
 * release key is `verifyManifestSignature` in signing.ts, which the resolver
 * runs on the served bytes before this parser ever sees them; this only keeps
 * a manifest that claims a signature honest about its shape.
 */
export function validateManifestSignature(raw: unknown): ManifestSignature {
  if (!isObject(raw)) {
    throw new MalformedManifestError(
      "channel.json signature must be an object",
    );
  }
  if (raw.alg !== MANIFEST_SIGNATURE_ALG) {
    throw new MalformedManifestError(
      `channel.json signature.alg must be ${MANIFEST_SIGNATURE_ALG}`,
    );
  }
  if (typeof raw.keyId !== "string" || raw.keyId.trim() === "") {
    throw new MalformedManifestError(
      "channel.json signature missing or invalid field: keyId",
    );
  }
  if (typeof raw.value !== "string" || !BASE64_RE.test(raw.value.trim())) {
    throw new MalformedManifestError(
      "channel.json signature missing or invalid field: value",
    );
  }
  return { alg: MANIFEST_SIGNATURE_ALG, keyId: raw.keyId, value: raw.value };
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
  const signature = raw.signature === undefined
    ? undefined
    : validateManifestSignature(raw.signature);

  return {
    ...(raw as unknown as ChannelManifest),
    binaryArtifacts,
    jsFallbackArtifact,
    orchestrationArtifact,
    ...(signature ? { signature } : {}),
  };
}
