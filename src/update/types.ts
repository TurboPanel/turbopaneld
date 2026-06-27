export type UpdateApp = "daemon";

export type UpdateChannel = "trunk" | "edge" | "canary" | "rc" | "release";

export interface RootCatalog {
  schema: number;
  defaultChannel: string;
  channels: Record<string, { manifestUrl: string }>;
}

export interface ArtifactEntry {
  url: string;
  sha256: string;
  blake3?: string;
  size: number;
}

export interface ChannelManifest {
  schema: number;
  channel: UpdateChannel;
  commit: string;
  buildId: string;
  builtAt: string;
  defaultControlPlaneUrl?: string;
  sourceArtifact: ArtifactEntry;
  releaseNotesUrl?: string;
  signature?: Record<string, unknown>;
}

export interface UpdateInfo {
  channel: UpdateChannel;
  commit: string;
  buildId: string;
  builtAt: string;
  sourceArtifact: ArtifactEntry;
  downloadUrl: string;
}
