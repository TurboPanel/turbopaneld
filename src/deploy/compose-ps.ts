/**
 * Shared `docker compose ps --format json` parsing for tenant deploy handlers.
 */

import type { EnvironmentDeployContainer } from "../instance/commands/contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse compose `ps --format json` stdout (JSON array or NDJSON). */
export function parseComposePsEntries(
  stdout: string,
): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord);
    }
    if (isRecord(parsed)) {
      return [parsed];
    }
  } catch {
    // Fall through to NDJSON.
  }

  const entries: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (row.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(row);
      if (isRecord(parsed)) entries.push(parsed);
    } catch {
      return [];
    }
  }
  return entries;
}

/**
 * Validate one compose-ps row into an {@link EnvironmentDeployContainer}, or
 * `null` when any of ID / Name / Service / State is missing or empty.
 */
export function readComposePsContainer(
  entry: Record<string, unknown>,
  role: "service" | "ingress" | "system",
): EnvironmentDeployContainer | null {
  const containerId = entry.ID;
  const containerName = entry.Name;
  const composeServiceName = entry.Service;
  const status = entry.State;
  if (
    typeof containerId !== "string" ||
    containerId.length === 0 ||
    typeof containerName !== "string" ||
    containerName.length === 0 ||
    typeof composeServiceName !== "string" ||
    composeServiceName.length === 0 ||
    typeof status !== "string" ||
    status.length === 0
  ) {
    return null;
  }
  return {
    composeServiceName,
    containerId,
    containerName,
    status,
    role,
  };
}

/**
 * Read Docker labels from a compose-ps JSON entry.
 *
 * Compose's native `ContainerSummary` serializes `Labels` as a string map;
 * the docker-CLI-aligned `--format json` path may emit a comma-separated
 * `key=value` string instead. Returns an empty map when Labels is absent
 * or unparseable.
 */
export function readComposePsLabels(
  entry: Record<string, unknown>,
): Record<string, string> {
  const raw = entry.Labels;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  if (typeof raw !== "string" || raw.length === 0) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    out[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return out;
}
