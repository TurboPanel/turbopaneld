/**
 * Daemon-authored compose overlay fragments merged into compiled `compose.yaml`.
 *
 * Overlay is storage mounts, Traefik labels, and traditional-web reachability
 * only — never secret values. Fragments are mostly key-disjoint; merge only
 * has to reconcile two fragments touching the same service (e.g. labels +
 * storage).
 */

import { parse, stringify } from "yaml";
import { join } from "@std/path";
import {
  DAEMON_COMPOSE_FILENAME,
  writeComposeFileSecure,
} from "./compose-files.ts";

export type ComposeOverlayFragment = {
  services?: Record<string, Record<string, unknown>>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => valuesEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).sort((x, y) => x.localeCompare(y));
    const keysB = Object.keys(b).sort((x, y) => x.localeCompare(y));
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key, index) =>
      key === keysB[index] && valuesEqual(a[key], b[key])
    );
  }
  return false;
}

function mergeArrays(left: unknown[], right: unknown[]): unknown[] {
  const out = [...left];
  for (const item of right) {
    if (!out.some((existing) => valuesEqual(existing, item))) {
      out.push(item);
    }
  }
  return out;
}

function mergeValues(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) {
    return mergeArrays(left, right);
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    return mergeRecords(left, right);
  }
  // Later fragment wins on scalars / type mismatches.
  return right;
}

function mergeRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (key in out) {
      out[key] = mergeValues(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Recursive merge of plain objects; concat-with-dedup for arrays
 * (`volumes`, `extra_hosts`, list-shaped service `networks`). Later fragment
 * wins on scalars.
 */
export function mergeComposeOverlayFragments(
  fragments: readonly ComposeOverlayFragment[],
): ComposeOverlayFragment {
  let merged: ComposeOverlayFragment = {};
  for (const fragment of fragments) {
    const next: ComposeOverlayFragment = { ...merged };
    if (fragment.services) {
      next.services = mergeRecords(
        merged.services ?? {},
        fragment.services,
      ) as Record<string, Record<string, unknown>>;
    }
    if (fragment.networks) {
      next.networks = mergeRecords(
        merged.networks ?? {},
        fragment.networks,
      );
    }
    if (fragment.volumes) {
      next.volumes = mergeRecords(
        merged.volumes ?? {},
        fragment.volumes,
      );
    }
    merged = next;
  }
  return merged;
}

export function isEmptyFragment(fragment: ComposeOverlayFragment): boolean {
  const serviceKeys = fragment.services
    ? Object.keys(fragment.services).length
    : 0;
  const networkKeys = fragment.networks
    ? Object.keys(fragment.networks).length
    : 0;
  const volumeKeys = fragment.volumes
    ? Object.keys(fragment.volumes).length
    : 0;
  return serviceKeys === 0 && networkKeys === 0 && volumeKeys === 0;
}

/** Render a fragment as Compose YAML (no document metadata). */
export function renderComposeOverlay(
  fragment: ComposeOverlayFragment,
): string {
  const document: Record<string, unknown> = {};
  if (fragment.services && Object.keys(fragment.services).length > 0) {
    document.services = fragment.services;
  }
  if (fragment.networks && Object.keys(fragment.networks).length > 0) {
    document.networks = fragment.networks;
  }
  if (fragment.volumes && Object.keys(fragment.volumes).length > 0) {
    document.volumes = fragment.volumes;
  }
  return stringify(document);
}

/**
 * Merge overlay fragments into a compiled runtime compose YAML document.
 * Top-level keys other than services/networks/volumes are preserved.
 */
export function mergeOverlayIntoComposeYaml(
  baseYaml: string,
  fragment: ComposeOverlayFragment,
): string {
  if (isEmptyFragment(fragment)) return baseYaml;
  const parsed: unknown = parse(baseYaml);
  const base = isPlainObject(parsed) ? parsed : {};
  const merged = mergeComposeOverlayFragments([
    {
      ...(isPlainObject(base.services)
        ? {
          services: base.services as Record<string, Record<string, unknown>>,
        }
        : {}),
      ...(isPlainObject(base.networks) ? { networks: base.networks } : {}),
      ...(isPlainObject(base.volumes) ? { volumes: base.volumes } : {}),
    },
    fragment,
  ]);
  const out: Record<string, unknown> = { ...base };
  if (merged.services) out.services = merged.services;
  if (merged.networks) out.networks = merged.networks;
  if (merged.volumes) out.volumes = merged.volumes;
  return stringify(out);
}

/**
 * Write the daemon overlay at mode `0640`, or remove a stale file when the
 * fragment is empty. Returns the absolute path or `null`.
 */
export async function writeDaemonComposeLayer(
  dir: string,
  fragment: ComposeOverlayFragment,
): Promise<string | null> {
  const path = join(dir, DAEMON_COMPOSE_FILENAME);
  if (isEmptyFragment(fragment)) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    return null;
  }
  await writeComposeFileSecure(path, renderComposeOverlay(fragment));
  return path;
}
