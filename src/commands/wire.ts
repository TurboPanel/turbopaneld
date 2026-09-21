/**
 * Composition-root wiring for command handlers.
 *
 * `src/instance/client.ts` is transport-only: it never imports this module or
 * the handlers. `entry/run.ts` and host-free client tests call
 * {@link wireCommandPorts} so dispatch / fabric-path probe / drivetemp enable
 * reach the client through registered callbacks.
 */
import { handleCommandDispatch } from "./command-router.ts";
import { handleDrivetempEnable } from "./drivetemp.ts";
import { handleFabricPathProbe } from "./fabric.ts";
import { registerCommandPorts } from "../instance/client.ts";

export function wireCommandPorts(): () => void {
  return registerCommandPorts({
    handleCommandDispatch,
    handleFabricPathProbe,
    handleDrivetempEnable,
  });
}
