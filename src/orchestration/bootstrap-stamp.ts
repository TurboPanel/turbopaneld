import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import {
  GALAXY_COLLECTIONS_DIR,
  GALAXY_DOCKER_REQUIREMENTS_FILE,
  GALAXY_REQUIREMENTS_FILE,
  GALAXY_ROLES_DIR,
  PYTHON_VERSION,
  REQUIREMENTS_FILE,
  RUNTIMES_DIR,
  UV_VERSION,
} from "./paths.ts";

export const BOOTSTRAP_STAMP_FILE = join(
  RUNTIMES_DIR,
  "ansible",
  "bootstrap.stamp",
);

/** Stamp for the deferred Docker Galaxy role pin (`requirements-docker.yml`). */
export const GALAXY_DOCKER_STAMP_FILE = join(
  RUNTIMES_DIR,
  "ansible",
  "galaxy-docker.stamp",
);

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function sha256Hex(material: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return encodeHex(new Uint8Array(digest));
}

/**
 * Fingerprint of pinned bootstrap inputs: managed tool versions, pip requirements,
 * and Galaxy *collection* requirements. Docker Galaxy roles are stamped separately
 * ({@link computeGalaxyDockerStamp}) because they install on demand.
 */
export async function computeBootstrapStamp(): Promise<string> {
  const [reqTxt, reqYml] = await Promise.all([
    Deno.readTextFile(REQUIREMENTS_FILE),
    Deno.readTextFile(GALAXY_REQUIREMENTS_FILE),
  ]);
  return sha256Hex(`${UV_VERSION}\n${PYTHON_VERSION}\n${reqTxt}\n${reqYml}`);
}

export async function readBootstrapStamp(): Promise<string | null> {
  if (!(await fileExists(BOOTSTRAP_STAMP_FILE))) return null;
  const text = await Deno.readTextFile(BOOTSTRAP_STAMP_FILE);
  const stamp = text.trim();
  return stamp.length > 0 ? stamp : null;
}

export async function writeBootstrapStamp(stamp: string): Promise<void> {
  await Deno.mkdir(join(RUNTIMES_DIR, "ansible"), { recursive: true });
  await Deno.writeTextFile(BOOTSTRAP_STAMP_FILE, `${stamp}\n`);
}

/** True when pinned Galaxy collections needed at bootstrap are present on disk. */
export async function galaxyCollectionsPresent(): Promise<boolean> {
  const posixCollection = join(
    GALAXY_COLLECTIONS_DIR,
    "ansible_collections",
    "ansible",
    "posix",
  );
  return await fileExists(posixCollection);
}

/** Fingerprint of the deferred Docker Galaxy role requirements pin. */
export async function computeGalaxyDockerStamp(): Promise<string> {
  const reqYml = await Deno.readTextFile(GALAXY_DOCKER_REQUIREMENTS_FILE);
  return sha256Hex(reqYml);
}

export async function readGalaxyDockerStamp(): Promise<string | null> {
  if (!(await fileExists(GALAXY_DOCKER_STAMP_FILE))) return null;
  const text = await Deno.readTextFile(GALAXY_DOCKER_STAMP_FILE);
  const stamp = text.trim();
  return stamp.length > 0 ? stamp : null;
}

export async function writeGalaxyDockerStamp(stamp: string): Promise<void> {
  await Deno.mkdir(join(RUNTIMES_DIR, "ansible"), { recursive: true });
  await Deno.writeTextFile(GALAXY_DOCKER_STAMP_FILE, `${stamp}\n`);
}

/** True when the pinned geerlingguy.docker Galaxy role is present on disk. */
export async function galaxyDockerRolePresent(): Promise<boolean> {
  return await fileExists(join(GALAXY_ROLES_DIR, "geerlingguy.docker"));
}
