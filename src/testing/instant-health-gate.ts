/**
 * A health gate that passes at once, for deploy tests whose fake docker has no
 * `compose ps` answer: the real gate would poll and sleep until its timeout.
 */
import type { HealthGateResult } from "../deploy/health-gate.ts";

export function instantlyHealthy(): Promise<HealthGateResult> {
  return Promise.resolve({
    ok: true,
    services: ["web"],
    elapsedMs: 0,
    unchecked: [],
    reported: ["web"],
  });
}
