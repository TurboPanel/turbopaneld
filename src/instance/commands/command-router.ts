import { errorText, sanitizeForLog } from "../../logger.ts";
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
  parseManagedHaFailoverPayload,
  parseManagedHaReconcilePayload,
  parseManagedIngressReconcilePayload,
  parseManagedLifecyclePayload,
  parseManagedPromotePayload,
  parseManagedRestorePayload,
  parseNtpSetPayload,
  parsePingPayload,
  parsePrincipalsReconcilePayload,
  parseRebootPayload,
  parseSystemReconcilePayload,
  parseTimezoneSetPayload,
  parseTlsTrustReconcilePayload,
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
import { handleManagedHaFailover } from "./managed-ha-failover.ts";
import { handleManagedHaReconcile } from "./managed-ha-reconcile.ts";
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
import { handlePrincipalsReconcile } from "./principals-reconcile.ts";
import { handleTlsTrust } from "./tls-trust.ts";
import { handleFabricReconcile } from "./fabric.ts";
import {
  type CommandOutputSink,
  createNoopCommandOutputSink,
} from "../../logs/contracts.ts";
import { createCommandOutputSink } from "../../logs/sink.ts";
import type { SendCommandLogChunkFn } from "../../logs/uploader.ts";
import { resolveLayout } from "../../paths/layout.ts";

export interface CommandRouterDeps {
  /** Decrypt tpdaemon envelopes via POST /api/daemon/v1/secrets/decrypt. */
  decryptSecrets?: (ciphertexts: string[]) => Promise<(string | null)[]>;
  /**
   * Upload one redacted transcript chunk
   * (`POST /api/daemon/v1/commands/:commandId/log`). When absent, commands run
   * with the no-op sink and no transcript is captured.
   */
  sendCommandLogChunk?: SendCommandLogChunkFn;
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

/** Test-only handler overrides — host-free router dispatch without Docker/Ansible. */
export type CommandRouterHandlerOverrides = {
  handleEnvironmentDeploy?: typeof handleEnvironmentDeploy;
  handleManagedApply?: typeof handleManagedApply;
  handleManagedLifecycle?: typeof handleManagedLifecycle;
  handleManagedDestroy?: typeof handleManagedDestroy;
  handleManagedPromote?: typeof handleManagedPromote;
  handleManagedBackup?: typeof handleManagedBackup;
  handleManagedRestore?: typeof handleManagedRestore;
  handleManagedIngressReconcile?: typeof handleManagedIngressReconcile;
  handleManagedHaReconcile?: typeof handleManagedHaReconcile;
  handleManagedHaFailover?: typeof handleManagedHaFailover;
  handleSystemReconcile?: typeof handleSystemReconcile;
};

let commandRouterHandlerOverrides: CommandRouterHandlerOverrides | null = null;

export function setCommandRouterHandlersForTests(
  overrides: CommandRouterHandlerOverrides | null,
): void {
  commandRouterHandlerOverrides = overrides;
}

function pickCommandRouterHandler<
  K extends keyof CommandRouterHandlerOverrides,
>(
  key: K,
  fallback: NonNullable<CommandRouterHandlerOverrides[K]>,
): NonNullable<CommandRouterHandlerOverrides[K]> {
  const override = commandRouterHandlerOverrides?.[key];
  return (override ?? fallback) as NonNullable<
    CommandRouterHandlerOverrides[K]
  >;
}

/**
 * Build the per-command transcript sink. One sink per command execution, keyed
 * on the dispatch envelope's own command id; `finalize()` runs in the `finally`
 * beside the WS `command-outcome` send so an upload failure can never affect
 * the outcome.
 */
function createDispatchLogSink(
  message: CommandDispatchMessage,
  deps?: CommandRouterDeps,
): CommandOutputSink {
  const send = deps?.sendCommandLogChunk;
  if (!send) return createNoopCommandOutputSink();
  return createCommandOutputSink({
    commandId: message.id,
    phase: message.commandType,
    send,
    layout: resolveLayout(Deno.env.toObject()),
  });
}

function sanitizeError(value: unknown, maxLen = 500): string {
  const text = sanitizeForLog(value);
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

/**
 * Last line of defence for `command-outcome.error`.
 *
 * A handler error message is very often raw process stderr, and the outcome is
 * persisted in command history where the transcript's redaction does not
 * reach. Redact against the sink's deny-set *before* sanitizing, so multiline
 * plaintext still matches the raw text it was captured from.
 */
function sanitizeOutcomeError(
  value: unknown,
  logSink: CommandOutputSink,
): string {
  return sanitizeError(logSink.redactSummary(errorText(value)));
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

  const logSink = createDispatchLogSink(message, deps);

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
      case "server.tls.trust.reconcile": {
        const payload = parseTlsTrustReconcilePayload(message.payload);
        result = await handleTlsTrust(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "server.principals.reconcile": {
        const payload = parsePrincipalsReconcilePayload(message.payload);
        result = await handlePrincipalsReconcile(payload, daemonReceivedAt);
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
        result = await pickCommandRouterHandler(
          "handleEnvironmentDeploy",
          handleEnvironmentDeploy,
        )(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
          logSink,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "environment.lifecycle": {
        const payload = parseEnvironmentLifecyclePayload(message.payload);
        result = await handleEnvironmentLifecycle(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
          logSink,
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
        result = await handleEnvironmentStop(payload, daemonReceivedAt, {
          logSink,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.apply": {
        const payload = parseManagedApplyPayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedApply",
          handleManagedApply,
        )(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
          logSink,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.lifecycle": {
        const payload = parseManagedLifecyclePayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedLifecycle",
          handleManagedLifecycle,
        )(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.destroy": {
        const payload = parseManagedDestroyPayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedDestroy",
          handleManagedDestroy,
        )(payload, daemonReceivedAt, {
          decryptSecrets: deps?.decryptSecrets,
        });
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.promote": {
        const payload = parseManagedPromotePayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedPromote",
          handleManagedPromote,
        )(payload, daemonReceivedAt, {
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
        result = await pickCommandRouterHandler(
          "handleManagedBackup",
          handleManagedBackup,
        )(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.restore": {
        const payload = parseManagedRestorePayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedRestore",
          handleManagedRestore,
        )(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.ingress.reconcile": {
        const payload = parseManagedIngressReconcilePayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedIngressReconcile",
          handleManagedIngressReconcile,
        )(
          payload,
          daemonReceivedAt,
          { decryptSecrets: deps?.decryptSecrets },
        );
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.ha.reconcile": {
        const payload = parseManagedHaReconcilePayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedHaReconcile",
          handleManagedHaReconcile,
        )(
          payload,
          daemonReceivedAt,
          { decryptSecrets: deps?.decryptSecrets },
        );
        ok = true;
        daemonRespondedAt = new Date().toISOString();
        break;
      }
      case "managed.ha.failover": {
        const payload = parseManagedHaFailoverPayload(message.payload);
        result = await pickCommandRouterHandler(
          "handleManagedHaFailover",
          handleManagedHaFailover,
        )(
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
        result = await pickCommandRouterHandler(
          "handleSystemReconcile",
          handleSystemReconcile,
        )(payload, daemonReceivedAt);
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
      error: error ? sanitizeOutcomeError(error, logSink) : undefined,
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
      error: sanitizeOutcomeError(err, logSink),
      at: daemonRespondedAt,
      daemonReceivedAt,
      daemonRespondedAt,
    });
  } finally {
    // Transcript upload is never load-bearing — finalize() never throws.
    await logSink.finalize();
  }
}
