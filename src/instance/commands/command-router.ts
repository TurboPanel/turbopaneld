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
  parseEnvironmentLifecyclePayload,
  parseEnvironmentStopPayload,
  parseFabricReconcilePayload,
  parseHostnamePayload,
  parseManagedApplyPayload,
  parseManagedBackupPayload,
  parseManagedDestroyPayload,
  parseManagedIngressReconcilePayload,
  parseManagedLifecyclePayload,
  parseManagedPromotePayload,
  parseManagedRestorePayload,
  parseNtpSetPayload,
  parsePingPayload,
  parseRebootPayload,
  parseSystemReconcilePayload,
  parseTimezoneSetPayload,
} from "./contracts.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import { handleManagedApply } from "../../managed/apply.ts";
import {
  handleManagedBackup,
  handleManagedRestore,
} from "../../managed/backup.ts";
import { handleManagedDestroy } from "../../managed/destroy.ts";
import { handleManagedLifecycle } from "../../managed/lifecycle.ts";
import { handleManagedPromote } from "../../managed/promote.ts";
import { handleManagedIngressReconcile } from "./managed-ingress-reconcile.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";
import { parseRehydrateDeploymentResults } from "../../deploy/rehydrate-deployments.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";
import { handleSystemReconcile } from "./system-reconcile.ts";
import { handleHostname } from "./hostname.ts";
import { handleNtp } from "./ntp.ts";
import { handlePing } from "./ping.ts";
import { handleReboot } from "./reboot.ts";
import { handleTimezone } from "./timezone.ts";
import { handleFabricReconcile } from "./fabric.ts";

export interface CommandRouterDeps {
  /** Decrypt tpdaemon envelopes via POST /api/daemon/v1/secrets/decrypt. */
  decryptSecrets?: (ciphertexts: string[]) => Promise<(string | null)[]>;
  /** Fetch last-applied secret plans + envelopes for boot/lifecycle rehydrate. */
  rehydrateDeploymentSecrets?: (
    deployments: ReadonlyArray<{
      projectId: string;
      environmentId: string;
      generation?: number;
    }>,
  ) => Promise<
    Array<{
      projectId: string;
      environmentId: string;
      generation: number;
      secretPlan: unknown;
      variableMaterial: unknown;
    }>
  >;
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
      case "server.fabric.reconcile": {
        const payload = parseFabricReconcilePayload(message.payload);
        result = await handleFabricReconcile(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
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
      case "environment.lifecycle": {
        const payload = parseEnvironmentLifecyclePayload(message.payload);
        result = await handleEnvironmentLifecycle(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
          rehydrateDeploymentSecrets: deps?.rehydrateDeploymentSecrets
            ? async (deployments) =>
              parseRehydrateDeploymentResults(
                await deps.rehydrateDeploymentSecrets!(deployments),
              )
            : undefined,
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
      case "managed.apply": {
        const payload = parseManagedApplyPayload(message.payload);
        result = await handleManagedApply(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.lifecycle": {
        const payload = parseManagedLifecyclePayload(message.payload);
        result = await handleManagedLifecycle(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.destroy": {
        const payload = parseManagedDestroyPayload(message.payload);
        result = await handleManagedDestroy(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.promote": {
        const payload = parseManagedPromotePayload(message.payload);
        result = await handleManagedPromote(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.backup": {
        // No credential envelopes on this command — backups/restores run
        // through the already-running engine container via `docker exec`.
        const payload = parseManagedBackupPayload(message.payload);
        result = await handleManagedBackup(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.restore": {
        const payload = parseManagedRestorePayload(message.payload);
        result = await handleManagedRestore(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.ingress.reconcile": {
        const payload = parseManagedIngressReconcilePayload(message.payload);
        result = await handleManagedIngressReconcile(
          payload,
          daemonReceivedAt,
          { decryptSecrets: deps?.decryptSecrets },
        );
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "system.reconcile": {
        const payload = parseSystemReconcilePayload(message.payload);
        result = await handleSystemReconcile(payload, daemonReceivedAt);
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
