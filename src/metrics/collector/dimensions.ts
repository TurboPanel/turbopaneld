import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import type { StaticDimensions } from "./types.ts";

/**
 * Resolve static host dimensions for each metrics sample.
 *
 * `runtimeMode` is intentionally unset on the daemon — deployment mode is an
 * adapter/instance concern filled in upstream when needed. `collectionMode`
 * and `hardwareProfileGeneration` are per-collect facts the collector itself
 * fills in. Daemon version / OS / architecture / kernel release are no
 * longer carried per-sample — they already ride the server row via host
 * facts (`hello`/heartbeat), so this stays a one-field passthrough.
 */
export function resolveDimensions(): StaticDimensions {
  return { schemaVersion: METRICS_SCHEMA_VERSION };
}
