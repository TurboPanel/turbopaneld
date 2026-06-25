import {
  MalformedManifestError,
  UnsupportedSchemaVersionError,
} from "./errors.ts";
import type { ChannelManifest, RootCatalog } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRootCatalog(raw: unknown): RootCatalog {
  if (!isObject(raw)) {
    throw new MalformedManifestError("channels.json root must be an object");
  }

  if (raw.schemaVersion !== 1) {
    throw new UnsupportedSchemaVersionError(
      `Unsupported channels.json schemaVersion: ${raw.schemaVersion}`,
    );
  }

  if (typeof raw.generatedAt !== "string") {
    throw new MalformedManifestError(
      "channels.json missing or invalid field: generatedAt",
    );
  }

  if (typeof raw.baseUrl !== "string") {
    throw new MalformedManifestError(
      "channels.json missing or invalid field: baseUrl",
    );
  }

  if (!isObject(raw.apps)) {
    throw new MalformedManifestError(
      "channels.json missing or invalid field: apps",
    );
  }

  return raw as unknown as RootCatalog;
}

export function parseChannelManifest(raw: unknown): ChannelManifest {
  if (!isObject(raw)) {
    throw new MalformedManifestError("channel.json root must be an object");
  }

  if (raw.schemaVersion !== 1) {
    throw new UnsupportedSchemaVersionError(
      `Unsupported channel.json schemaVersion: ${raw.schemaVersion}`,
    );
  }

  if (typeof raw.app !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: app",
    );
  }

  if (typeof raw.channel !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: channel",
    );
  }

  if (typeof raw.version !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: version",
    );
  }

  if (typeof raw.buildId !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: buildId",
    );
  }

  if (typeof raw.commit !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: commit",
    );
  }

  if (typeof raw.branch !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: branch",
    );
  }

  if (typeof raw.builtAt !== "string") {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: builtAt",
    );
  }

  if (!isObject(raw.artifacts)) {
    throw new MalformedManifestError(
      "channel.json missing or invalid field: artifacts",
    );
  }

  return raw as unknown as ChannelManifest;
}
