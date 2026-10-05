/**
 * The host text facts that need no subprocess: the 1/5/15-minute load average,
 * the CPU model, the boot id and the daemon's own version. Pure; the collector
 * hands in what it already read. Each fact is left out when it is unknown.
 */
import type { MetricsTextFields } from "../../contracts/metrics-contract.ts";

const MAX_FACT_LENGTH = 128;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Single-line, control-character-free, length-capped; `undefined` when nothing is left. */
export function cleanFact(
  value: string | null | undefined,
  max = MAX_FACT_LENGTH,
): string | undefined {
  // deno-lint-ignore no-control-regex
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** `0.48 0.37 0.35` from `/proc/loadavg`; `undefined` unless all three are plain non-negative numbers. */
export function parseLoadavg(text: string | undefined): string | undefined {
  const fields = (text ?? "").trim().split(/\s+/).slice(0, 3);
  if (fields.length < 3) return undefined;
  return fields.every((field) => /^\d+(\.\d+)?$/.test(field))
    ? fields.join(" ")
    : undefined;
}

/** The kernel's random per-boot UUID, lower-cased; `undefined` when it is not one. */
export function parseBootId(text: string | undefined): string | undefined {
  const id = (text ?? "").trim();
  return UUID_RE.test(id) ? id.toLowerCase() : undefined;
}

export type HostFactsInput = {
  loadavgText: string | undefined;
  cpuModel: string | null | undefined;
  bootIdText: string | undefined;
  agentVersion: string | undefined;
};

/** `undefined` when no fact is known. */
export function buildHostFacts(
  input: HostFactsInput,
): MetricsTextFields | undefined {
  const out: MetricsTextFields = {};
  const loadavg = parseLoadavg(input.loadavgText);
  if (loadavg) out.loadavg = loadavg;
  const cpuModel = cleanFact(input.cpuModel);
  if (cpuModel) out.cpuModel = cpuModel;
  const bootId = parseBootId(input.bootIdText);
  if (bootId) out.bootId = bootId;
  const agentVersion = cleanFact(input.agentVersion, 64);
  if (agentVersion) out.agentVersion = agentVersion;
  return Object.keys(out).length > 0 ? out : undefined;
}
