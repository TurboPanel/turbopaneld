import type {
  CommandAckMessage,
  CommandDispatchMessage,
  CommandOutcomeMessage,
  PingResult,
  RebootPayload,
} from "./contracts.ts";
import {
  parseEnvironmentDeployPayload,
  parseHostnamePayload,
  parsePingPayload,
  parseRebootPayload,
} from "./contracts.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import { handleHostname } from "./hostname.ts";
import { handlePing } from "./ping.ts";
import { handleReboot } from "./reboot.ts";

export interface CommandRouterDeps {
  // extensible for future handlers (e.g. hostname needs ansible)
}

function stripLogInjection(text: string): string {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("\t", "_");
}

function sanitizeError(value: unknown, maxLen = 500): string {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === "string") {
    text = value;
  } else {
    text = String(value);
  }
  text = stripLogInjection(text);
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
  _deps?: CommandRouterDeps,
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
        result = await handleEnvironmentDeploy(payload, daemonReceivedAt);
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
