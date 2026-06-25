import { UnsupportedPlatformError } from "./errors.ts";
import type { ArtifactPlatform } from "./types.ts";

export function resolveCurrentPlatform(
  os = Deno.build.os,
  arch = Deno.build.arch,
): ArtifactPlatform {
  if (os !== "linux") {
    throw new UnsupportedPlatformError(
      `Unsupported platform: os=${os}, arch=${arch}`,
    );
  }

  switch (arch) {
    case "x86_64":
      return "linux-amd64";
    case "aarch64":
      return "linux-arm64";
    default:
      throw new UnsupportedPlatformError(
        `Unsupported platform: os=${os}, arch=${arch}`,
      );
  }
}
