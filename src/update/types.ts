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
  /**
   * Dev overlay only: fingerprint of the source checkout the artifacts were
   * built from (see scripts/source-fingerprint.ts). The dev instance compares
   * it against the live checkout to decide whether a rebuild is required
   * before upgrading daemons. Absent from CI-published channel manifests.
   */
  source?: string;
  defaultControlPlaneUrl?: string;
  binaryArtifacts: BinaryArtifacts;
  jsFallbackArtifact: ArtifactEntry;
  orchestrationArtifact: ArtifactEntry;
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
  orchestrationArtifact: ArtifactEntry;
  /** Native binary tarball URL for the current host architecture. */
  downloadUrl: string;
}
