/**
 * Composition-root wiring for command handlers.
 *
 * `src/instance/client.ts` is transport-only: it never imports this module or
 * the handlers. `entry/run.ts` and host-free client tests call
 * {@link wireCommandPorts} so dispatch / fabric-path probe / drivetemp enable
 * reach the client through registered callbacks.
 */
import { handleCommandDispatch } from "./command-router.ts";
import {
  acknowledgeCommandOutcome,
  answerRepeatedDispatch,
  commandRecoveryReport,
  flushCommandOutcomes,
  noteSessionOpen,
} from "./command-outbox.ts";
import { handleDrivetempEnable } from "./drivetemp.ts";
import {
  handleFabricPathProbe,
  subscribeFabricPeerReadings,
} from "./fabric.ts";
import { registerCommandPorts } from "../instance/client.ts";

export function wireCommandPorts(): () => void {
  return registerCommandPorts({
    handleCommandDispatch,
    handleFabricPathProbe,
    handleDrivetempEnable,
    handleSessionAttach: flushCommandOutcomes,
    handleSessionOpen: noteSessionOpen,
    handleCommandOutcomeAck: acknowledgeCommandOutcome,
    handleRepeatedDispatch: answerRepeatedDispatch,
    commandReport: commandRecoveryReport,
    subscribeFabricPeers: subscribeFabricPeerReadings,
  });
}
