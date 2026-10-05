/**
 * Registry for the per-service run state that rides the presence channel
 * (`hello` + change-detected `heartbeat`), the same way `docker` and
 * `runtimes` do. The sentinel registers a source at startup; the presence
 * snapshot reads it on every idle tick. `undefined` means "this daemon is not
 * watching Docker", so the frame omits `services` and the control plane keeps
 * what it has.
 */
import type { ServiceRunState } from "../contracts/service-run-state.ts";

export type { ServiceRunState } from "../contracts/service-run-state.ts";

type ServiceRunStateSource = () => ServiceRunState[] | undefined;

let source: ServiceRunStateSource | undefined;

/** Register (or clear, with `undefined`) the run-state source. */
export function setServiceRunStateSource(
  next: ServiceRunStateSource | undefined,
): void {
  source = next;
}

export function readServiceRunStates(): ServiceRunState[] | undefined {
  return source?.();
}
