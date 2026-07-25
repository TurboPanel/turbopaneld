/** Helpers for inspecting runtime compose YAML without full label injection. */

import { parse } from "yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when compose YAML defines at least one service entry. */
export function composeHasContainerServices(composeYaml: string): boolean {
  const document = parse(composeYaml);
  if (!isRecord(document) || !isRecord(document.services)) return false;
  return Object.keys(document.services).length > 0;
}
