/** Helpers for inspecting compose YAML and resolving the effective model. */

import { type CollectionTag, parse, type ScalarTag } from "yaml";
import type { DockerCliResult, RunDockerOptions } from "./docker-cli.ts";
import { composeFileArgs } from "./compose-files.ts";

export type ResolvedComposeModel = {
  serviceNames: string[];
  services: Record<string, Record<string, unknown>>;
};

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse scalar `!reset` / `!override` bodies the same way Compose authors write
 * them (`null` / `~` / empty → JS null). Body is otherwise left as the string.
 */
function resolveScalarTagBody(raw: string): unknown {
  if (
    raw === "" || raw === "null" || raw === "NULL" || raw === "Null" ||
    raw === "~"
  ) {
    return null;
  }
  if (raw === "true" || raw === "True" || raw === "TRUE") return true;
  if (raw === "false" || raw === "False" || raw === "FALSE") return false;
  return raw;
}

function scalarTag(name: "reset" | "override"): ScalarTag {
  return {
    tag: `!${name}`,
    resolve(value: string) {
      return resolveScalarTagBody(value);
    },
  };
}

function mapTag(name: "reset" | "override"): CollectionTag {
  return {
    tag: `!${name}`,
    collection: "map",
    resolve(map) {
      return map?.toJSON?.() ?? {};
    },
  };
}

function seqTag(name: "reset" | "override"): CollectionTag {
  return {
    tag: `!${name}`,
    collection: "seq",
    resolve(seq) {
      return seq?.toJSON?.() ?? [];
    },
  };
}

/**
 * One entry per (tag × node kind). Resolves Compose Spec `!reset` /
 * `!override` so the local preflight can read `services` without unresolved
 * tag warnings — docker compose config remains the merge authority.
 */
const COMPOSE_CUSTOM_TAGS: Array<ScalarTag | CollectionTag> = [
  scalarTag("reset"),
  mapTag("reset"),
  seqTag("reset"),
  scalarTag("override"),
  mapTag("override"),
  seqTag("override"),
];

/**
 * True when compose YAML defines at least one service entry.
 *
 * Tag-aware for `!reset` / `!override`. On parse failure the heuristic is
 * non-fatal and returns `true` so a local parser quirk never blocks a deploy
 * that docker compose config may still accept — empty `services: {}` always
 * parses, so site-only is unaffected.
 */
export function composeHasContainerServices(composeYaml: string): boolean {
  try {
    const document = parse(composeYaml, { customTags: COMPOSE_CUSTOM_TAGS });
    if (!isRecord(document) || !isRecord(document.services)) return false;
    return Object.keys(document.services).length > 0;
  } catch {
    // Advisory only — let `docker compose config` decide.
    return true;
  }
}

/**
 * Pre-Docker gate: true when any layer declares at least one service under
 * `services`. Preserves site-only deploys (`services: {}`).
 */
export function composeFilesHaveContainerServices(
  contents: readonly string[],
): boolean {
  for (const content of contents) {
    if (composeHasContainerServices(content)) return true;
  }
  return false;
}

function parseConfigJson(stdout: string): ResolvedComposeModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      "docker compose config --format json returned unparseable stdout",
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      "docker compose config --format json returned a non-object model",
    );
  }
  const servicesRaw = parsed.services;
  if (servicesRaw === undefined || servicesRaw === null) {
    return { serviceNames: [], services: {} };
  }
  if (!isRecord(servicesRaw)) {
    throw new Error(
      "docker compose config model services must be an object",
    );
  }
  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, service] of Object.entries(servicesRaw)) {
    if (isRecord(service)) {
      services[name] = service;
    }
  }
  const serviceNames = Object.keys(services).sort((a, b) => a.localeCompare(b));
  return { serviceNames, services };
}

/**
 * Resolve the effective compose model via
 * `docker compose … config --format json`. Docker is the single source of
 * truth — no local merge fallback.
 */
export async function resolveComposeModel(
  projectName: string,
  paths: readonly string[],
  run: RunDockerFn,
): Promise<ResolvedComposeModel> {
  const result = await run([
    ...composeFileArgs(projectName, paths),
    "config",
    "--format",
    "json",
  ]);
  if (!result.success) {
    throw new Error(result.stderr || "docker compose config failed");
  }
  return parseConfigJson(result.stdout);
}

/** Validate the full chain with `docker compose … config -q`. */
export async function validateComposeConfig(
  projectName: string,
  paths: readonly string[],
  run: RunDockerFn,
): Promise<void> {
  const result = await run([
    ...composeFileArgs(projectName, paths),
    "config",
    "-q",
  ]);
  if (!result.success) {
    throw new Error(result.stderr || "docker compose config -q failed");
  }
}
