import { sanitizeForLog } from "../../logger.ts";
import type {
  CommandAckMessage,
  CommandDispatchMessage,
  CommandOutcomeMessage,
  PingResult,
  RebootPayload,
} from "./contracts.ts";
import {
  parseEnvironmentDeployPayload,
  parseEnvironmentStopPayload,
  parseHostnamePayload,
  parseNtpSetPayload,
  parsePingPayload,
  parseRebootPayload,
  parseTimezoneSetPayload,
} from "./contracts.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";
import { handleHostname } from "./hostname.ts";
import { handleNtp } from "./ntp.ts";
import { handlePing } from "./ping.ts";
import { handleReboot } from "./reboot.ts";
import { handleTimezone } from "./timezone.ts";

export interface CommandRouterDeps {
  /** Decrypt tpdaemon envelopes via POST /api/daemon/v1/secrets/decrypt. */
  decryptSecrets?: (ciphertexts: string[]) => Promise<(string | null)[]>;
}

function sanitizeError(value: unknown, maxLen = 500): string {
  const text = sanitizeForLog(value);
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function sendOutcome(
  ws: WebSocket,
  outcome: CommandOutcomeMessage,
): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outcome));
  }
}

export async function handleCommandDispatch(
  message: CommandDispatchMessage,
  ws: WebSocket,
  deps?: CommandRouterDeps,
): Promise<void> {
  const daemonReceivedAt = new Date().toISOString();

  const ack: CommandAckMessage = {
    type: "command-ack",
    id: message.id,
    at: new Date().toISOString(),
    daemonReceivedAt,
  };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(ack));
  }

  try {
    let ok: boolean;
    let result: unknown;
    let error: string | undefined;
    let daemonRespondedAt = new Date().toISOString();

    switch (message.commandType) {
      case "daemon.ping":
        parsePingPayload(message.payload);
        result = handlePing(daemonReceivedAt);
        ok = true;
        daemonRespondedAt = (result as PingResult).daemonRespondedAt!;
        break;
      case "server.hostname.set": {
        const payload = parseHostnamePayload(message.payload);
        result = await handleHostname(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "server.timezone.set": {
        const payload = parseTimezoneSetPayload(message.payload);
        result = await handleTimezone(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "server.ntp.set": {
        const payload = parseNtpSetPayload(message.payload);
        result = await handleNtp(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "server.reboot": {
        parseRebootPayload(message.payload);
        result = await handleReboot(
          message.payload as RebootPayload,
          daemonReceivedAt,
        );
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "environment.deploy": {
        const payload = parseEnvironmentDeployPayload(message.payload);
        result = await handleEnvironmentDeploy(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "environment.stop": {
        const payload = parseEnvironmentStopPayload(message.payload);
        result = await handleEnvironmentStop(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      default:
        ok = false;
        error = `Unknown command type: ${message.commandType}`;
        break;
    }

    sendOutcome(ws, {
      type: "command-outcome",
      id: message.id,
      ok,
      result: ok ? result : undefined,
      error: error ? sanitizeError(error) : undefined,
      at: daemonRespondedAt,
      daemonReceivedAt,
      daemonRespondedAt,
    });
  } catch (err) {
    const daemonRespondedAt = new Date().toISOString();
    sendOutcome(ws, {
      type: "command-outcome",
      id: message.id,
      ok: false,
      error: sanitizeError(err),
      at: daemonRespondedAt,
      daemonReceivedAt,
      daemonRespondedAt,
    });
  }
}
