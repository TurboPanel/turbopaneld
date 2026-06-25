export class UnsupportedAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAppError";
  }
}

export class MissingChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingChannelError";
  }
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class MalformedManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedManifestError";
  }
}

export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

export class MissingArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingArtifactError";
  }
}

export class ChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumMismatchError";
  }
}
