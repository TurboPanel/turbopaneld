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

/**
 * The image string a managed engine's compose file should carry, so adding a
 * pin never restarts a running database. Compose recreates a service when its
 * image string changes, so:
 *
 * - no stored compose (first create): tag plus the table's digest;
 * - stored image is the same tag with no digest: keep it as stored;
 * - stored image carries a digest for the same tag: use the table's digest, so
 *   a deliberate edit of the table is applied;
 * - the requested tag differs from the stored one (an upgrade): new tag plus
 *   its digest.
 */
export function resolveManagedEngineImage(
  requested: string,
  storedImage?: string,
): string {
  const pinned = pinManagedEngineImage(requested);
  if (storedImage === undefined || requested.includes("@")) return pinned;
  const at = storedImage.indexOf("@");
  const storedBase = at < 0 ? storedImage : storedImage.slice(0, at);
  if (storedBase !== requested) return pinned;
  return at < 0 ? storedImage : pinned;
}

/**
 * Rendered platform compose text with every `image: name:tag@sha256:...` line
 * reverted to the bare `name:tag` the stored compose already used, when the
 * only difference would be the digest suffix appearing. A running stack is
 * therefore not recreated by a pin alone; it moves to the digest the next time
 * its tag changes or the stored file already carries a digest.
 */
export function keepStoredImages(
  rendered: string,
  stored: string | null,
): string {
  if (stored === null) return rendered;
  return rendered.replace(
    /^(\s*image:\s*)(\S+?)@sha256:[0-9a-f]{64}\s*$/gm,
    (line, lead: string, base: string) => {
      const bare = new RegExp(
        `^\\s*image:\\s*["']?${escapeRegExp(base)}["']?\\s*$`,
        "m",
      );
      return bare.test(stored) ? `${lead}${base}` : line;
    },
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
