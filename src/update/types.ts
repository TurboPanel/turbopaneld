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

export type LinuxArch = "linux-amd64" | "linux-arm64";

export interface BinaryArtifacts {
  "linux-amd64": ArtifactEntry;
  "linux-arm64": ArtifactEntry;
}

export interface ChannelManifest {
  schema: number;
  channel: UpdateChannel;
  commit: string;
  buildId: string;
  builtAt: string;
  defaultControlPlaneUrl?: string;
  binaryArtifacts: BinaryArtifacts;
  jsFallbackArtifact: ArtifactEntry;
  releaseNotesUrl?: string;
  signature?: Record<string, unknown>;
}

export interface UpdateInfo {
  channel: UpdateChannel;
  commit: string;
  buildId: string;
  builtAt: string;
  binaryArtifact: ArtifactEntry;
  jsFallbackArtifact: ArtifactEntry;
  /** Native binary tarball URL for the current host architecture. */
  downloadUrl: string;
}
