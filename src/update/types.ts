export type UpdateApp = "daemon";

export type UpdateChannel = "trunk" | "edge" | "canary" | "rc" | "release";

export type ArtifactPlatform = "linux-amd64" | "linux-arm64";

export interface ChannelCatalogEntry {
  manifest: string;
  description: string;
}

export interface AppCatalogEntry {
  channels: Partial<Record<UpdateChannel, ChannelCatalogEntry>>;
}

export interface RootCatalog {
  schemaVersion: 1;
  generatedAt: string;
  baseUrl: string;
  apps: Partial<Record<UpdateApp, AppCatalogEntry>>;
}

export interface ArtifactEntry {
  path: string;
  sha256: string;
  blake3?: string;
  size: number;
}

export interface ChannelManifest {
  schemaVersion: 1;
  app: UpdateApp;
  channel: UpdateChannel;
  version: string;
  buildId: string;
  commit: string;
  branch: string;
  builtAt: string;
  artifacts: Partial<Record<ArtifactPlatform, ArtifactEntry>>;
  releaseNotesUrl?: string;
  signature?: Record<string, unknown>;
}

export interface UpdateInfo {
  app: UpdateApp;
  channel: UpdateChannel;
  version: string;
  buildId: string;
  commit: string;
  builtAt: string;
  platform: ArtifactPlatform;
  artifact: ArtifactEntry;
  downloadUrl: string;
}
