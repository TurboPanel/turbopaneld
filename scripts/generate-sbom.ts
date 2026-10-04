#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Software bill of materials for the daemon release (audit L3/L4).
 *
 * Built from `deno.lock` alone, never from a fresh resolution: the release
 * binary is compiled with `deno compile --frozen`, which refuses a lockfile
 * that does not already cover every import, so the lock is exactly what ships
 * and this SBOM lists exactly that. Refuses a lockfile format it does not know
 * rather than emitting a partial list.
 *
 * Usage: deno run --allow-read --allow-write scripts/generate-sbom.ts \
 *          [deno.lock] [out.cdx.json]
 *
 * Output is CycloneDX 1.5 JSON, deterministic (no timestamp, no random serial),
 * so two runs over one lockfile are byte-identical.
 */
import { decodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { dirname } from "@std/path";

const SUPPORTED_LOCK_VERSIONS = new Set(["4", "5"]);

interface LockEntry {
  integrity?: string;
}

interface DenoLock {
  version?: string;
  jsr?: Record<string, LockEntry>;
  npm?: Record<string, LockEntry>;
}

export interface SbomComponent {
  type: "library";
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  hashes?: { alg: "SHA-256" | "SHA-512"; content: string }[];
}

export interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  metadata: {
    component: { type: "application"; name: string; version: string };
  };
  components: SbomComponent[];
}

/**
 * Split a lock key `name@version` (the name may start with `@scope/`). npm keys
 * can carry a peer suffix after the version: `pkg@1.2.3_peer@4`.
 */
function splitKey(key: string): { name: string; version: string } {
  const match = /^(@?[^@]+)@(\d[^_]*)/.exec(key);
  if (!match) throw new Error(`unreadable lock key: ${key}`);
  return { name: match[1], version: match[2] };
}

function hashesFor(
  registry: "jsr" | "npm",
  integrity: string | undefined,
): SbomComponent["hashes"] {
  if (!integrity) return undefined;
  if (registry === "jsr") return [{ alg: "SHA-256", content: integrity }];
  const match = /^sha512-(.+)$/.exec(integrity);
  if (!match) return undefined;
  return [{ alg: "SHA-512", content: encodeHex(decodeBase64(match[1])) }];
}

function purlFor(registry: "jsr" | "npm", name: string, version: string) {
  const encoded = name.replace(/^@/, "%40");
  return registry === "npm"
    ? `pkg:npm/${encoded}@${version}`
    : `pkg:generic/${encoded}@${version}?repository_url=https://jsr.io`;
}

function componentsFor(
  registry: "jsr" | "npm",
  entries: Record<string, LockEntry> | undefined,
): SbomComponent[] {
  return Object.entries(entries ?? {}).map(([key, entry]) => {
    const { name, version } = splitKey(key);
    const hashes = hashesFor(registry, entry.integrity);
    return {
      type: "library",
      "bom-ref": `${registry}:${name}@${version}`,
      name,
      version,
      purl: purlFor(registry, name, version),
      ...(hashes ? { hashes } : {}),
    };
  });
}

/** Build the SBOM from parsed `deno.lock` text and the root package identity. */
export function sbomFromLock(
  lockText: string,
  root: { name: string; version: string },
): Sbom {
  const lock = JSON.parse(lockText) as DenoLock;
  if (!lock.version || !SUPPORTED_LOCK_VERSIONS.has(lock.version)) {
    throw new Error(`unsupported deno.lock version: ${lock.version}`);
  }
  const components = [
    ...componentsFor("jsr", lock.jsr),
    ...componentsFor("npm", lock.npm),
  ].toSorted((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { component: { type: "application", ...root } },
    components,
  };
}

if (import.meta.main) {
  const [lockPath = "deno.lock", outPath = "dist/sbom.cdx.json"] = Deno.args;
  const config = JSON.parse(await Deno.readTextFile("deno.json")) as {
    version?: string;
  };
  const sbom = sbomFromLock(await Deno.readTextFile(lockPath), {
    name: "turbopaneld",
    version: config.version ?? "unstamped",
  });
  await Deno.mkdir(dirname(outPath), { recursive: true });
  await Deno.writeTextFile(outPath, JSON.stringify(sbom, null, 2) + "\n");
  console.log(`sbom: ${sbom.components.length} components -> ${outPath}`);
}
