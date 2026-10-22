/**
 * Container image pins — the daemon's view of `orchestration/image-pins.json`,
 * the one table of every image the platform pulls. Updating an image is a
 * one-file edit there (tag and digest together). Pulls accept the
 * `name:tag@sha256:…` form; Docker resolves by digest and ignores the tag.
 */
import pinsJson from "../../orchestration/image-pins.json" with {
  type: "json",
};

export type PinnedImageName = keyof typeof pinsJson.images;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** `ref@digest` for a platform image. */
export function pinnedImage(name: PinnedImageName): string {
  const { ref, digest } = pinsJson.images[name];
  return `${ref}@${digest}`;
}

/** The tag-form reference (for comments, logs and repository checks). */
export function pinnedImageTag(name: PinnedImageName): string {
  return pinsJson.images[name].ref;
}

/** The bare digest of a platform image. */
export function pinnedImageDigest(name: PinnedImageName): string {
  return pinsJson.images[name].digest;
}

/**
 * A managed engine image as the control plane names it (tag form) with its
 * digest added. A reference that is already digest-pinned, or not in the table,
 * is returned unchanged (the allow-list decides what may run).
 */
export function pinManagedEngineImage(image: string): string {
  if (image.includes("@")) return image;
  const digest = (pinsJson.managedEngines as Record<string, string>)[image];
  return digest === undefined ? image : `${image}@${digest}`;
}

/** Every digest in the table, for tests. */
export function allPinnedDigests(): string[] {
  return [
    ...Object.values(pinsJson.images).map((i) => i.digest),
    ...Object.values(pinsJson.managedEngines),
  ];
}

export function isImageDigest(value: string): boolean {
  return DIGEST_RE.test(value);
}
