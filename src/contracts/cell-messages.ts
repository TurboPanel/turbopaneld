/**
 * Daemon-side WebSocket message union extracted from `src/instance/client.ts`.
 *
 * The control-plane {@link DaemonMessage} in
 * `turbopanel/src/contracts/cell-protocol.ts` remains canonical for the
 * shared protocol. This file is the daemon's exported wire union and may
 * diverge (`hello`/`heartbeat` live on the instance side; snapshot typing
 * and `drivetemp` enable results are daemon-shaped). Keep the `type:`
 * discriminators in step when adding a message.
 */
import type { ServerReportedIp } from "./server-reported-ip.ts";
import type { DrivetempEnableResult } from "./commands-contracts.ts";
import type { HardwareProfile } from "../metrics/collector/types.ts";
import type { MetricsCapabilityPlan } from "../metrics/capability-plan.ts";
import type { TopologySnapshot } from "./topology-types.ts";

/**
 * Attach acknowledgement. Twin of `CellAttachVersionMessage` in
 * `turbopanel/src/contracts/cell-protocol.ts`. `instanceVersion` is optional
 * so a control plane that predates the field still parses.
 */
export type CellAttachVersionMessage = {
  type: "version";
  commit: string;
  branch: string;
  at: string;
  instanceVersion?: string;
  /**
   * Features the control plane advertises. Omitted by a peer that predates
   * the field; `instanceSupports` stays closed.
   */
  features?: string[];
};

/** Daemon → control plane hello. `features` is the advertised wire set. */
export type DaemonHelloMessage = {
  type: "hello";
  at: string;
  features?: string[];
};

/** Control-plane → daemon self-update. Optional pin fields are expand-only. */
export type DaemonUpdateMessage = {
  type: "update";
  id: string;
  channel?: string;
  updateUrl?: string;
  updateSha256?: string;
  upgradeId?: string;
  manifestUrl?: string;
  targetCommit?: string;
  at: string;
};

/** Control-plane → daemon control-plane update. Optional pin fields are expand-only. */
export type InstanceUpdateMessage = {
  type: "instance-update";
  id: string;
  channel?: string;
  manifestUrl?: string;
  /** UI package pin. Passed to run.sh as `--ui-manifest-url`. */
  uiManifestUrl?: string;
  /** Semver the control plane is about to install, when the manifest names one. */
  targetVersion?: string;
  upgradeId?: string;
  targetCommit?: string;
  at: string;
};

export type UpdateProgressUnit = "daemon" | "instance";

export type UpdateProgressStage =
  | "preparing"
  | "downloading"
  | "installing"
  | "restarting"
  | "verifying"
  | "done"
  | "failed"
  | "rolled-back";

/**
 * Daemon → control plane upgrade progress. Fire-and-forget: it does not
 * complete a pending `update` or `instance-update`.
 */
export type UpdateProgressMessage = {
  type: "update-progress";
  id: string;
  upgradeId?: string;
  unit: UpdateProgressUnit;
  stage: UpdateProgressStage;
  at: string;
  detail?: string;
  errorCode?: string;
};

/**
 * One control-plane hostname on `public-urls-update`. `certPem` / `keyPem`
 * travel decrypted once, over the authenticated cell socket, for `uploaded`
 * sources. The daemon writes them under the instance certs dir and does not
 * echo them back.
 */
export type InstanceHostnameCertSource =
  | "lets-encrypt"
  | "platform-ca"
  | "uploaded";

export type InstanceHostnameWireEntry = {
  host: string;
  source: InstanceHostnameCertSource;
  certPem?: string;
  keyPem?: string;
  uploadedCertId?: string;
};

/** Instance-wide ACME knobs for hostnames whose source is `lets-encrypt`. */
export type InstanceAcmeWireSettings = {
  contactEmail: string;
  tosAccepted: boolean;
  directoryUrl: string;
  useStaging: boolean;
};

export type DaemonMessage =
  | { type: "echo"; payload: unknown; at: string }
  | CellAttachVersionMessage
  | { type: "addresses-request"; id: string; at: string }
  | {
    type: "addresses-result";
    id: string;
    ips: ServerReportedIp[];
    at: string;
  }
  | {
    type: "managed-logs-request";
    id: string;
    managedId: string;
    tail: number;
    at: string;
  }
  | {
    type: "container-logs-request";
    id: string;
    containerId: string;
    tail: number;
    at: string;
  }
  | {
    type: "repo-read-request";
    id: string;
    cloneUrl: string;
    ref: string;
    paths: string[];
    listPath?: string;
    maxBytesPerFile: number;
    credential?: string;
    credentialKind?: string;
    credentialUsername?: string;
    at: string;
  }
  | {
    type: "repo-read-result";
    id: string;
    ok: boolean;
    commitSha?: string;
    files?: {
      path: string;
      found: boolean;
      content?: string;
      bytes?: number;
      reason?: string;
    }[];
    entries?: { path: string; kind: string }[];
    error?: string;
    at: string;
  }
  | {
    type: "repo-default-branch-request";
    id: string;
    /** Anonymous only — the control plane never sends a credential here. */
    cloneUrl: string;
    at: string;
  }
  | {
    type: "repo-default-branch-result";
    id: string;
    ok: boolean;
    /** `null` when the remote answered but named no branch (an empty repo). */
    defaultBranch?: string | null;
    error?: string;
    at: string;
  }
  | {
    type: "managed-logs-result";
    id: string;
    logs: string;
    error?: string;
    at: string;
  }
  | {
    type: "metrics-live-start";
    id: string;
    leaseId: string;
    /** Advisory from the control plane; the daemon applies its own live cadence. */
    intervalSeconds: number;
    expiresAt: string;
    at: string;
  }
  | {
    type: "metrics-live-start-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "metrics-live-stop"; id: string; leaseId: string; at: string }
  | {
    type: "metrics-live-stop-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "metrics-capabilities-request"; id: string; at: string }
  | {
    type: "metrics-capabilities-result";
    id: string;
    ok: boolean;
    capabilities?: Record<string, unknown>;
    error?: string;
    at: string;
  }
  | {
    type: "topology-overrides-update";
    id: string;
    /**
     * Full replacement — absent fields clear their setting. Carries both
     * v3 sensor-slot/NIC-name/hosting-path/drivetemp fields and the
     * topology-identity pins (`nicSlotDeviceIds`/`hostingFilesystemId`,
     * resolved against `src/metrics/topology/`
     * device/filesystem ids rather than raw names/paths) in one object —
     * renamed from `metrics-sensor-overrides-update` when topology
     * identity was added; the underlying store and v3 semantics are
     * unchanged.
     */
    overrides: HardwareProfile;
    at: string;
  }
  | {
    type: "topology-overrides-update-result";
    id: string;
    ok: boolean;
    error?: string;
    /**
     * Present when this push flipped `drivetempEnabled` false/unset → true —
     * the module-load outcome plus sensor capabilities re-discovered right
     * after, awaited before this result is sent (never a bare fire-and-forget
     * ack). Absent when the flip edge didn't occur, or if the drivetemp
     * command itself failed unexpectedly (logged; `ok` above still reflects
     * whether the profile write succeeded).
     */
    drivetemp?: DrivetempEnableResult;
    at: string;
  }
  | {
    type: "capability-plan-update";
    id: string;
    plan: MetricsCapabilityPlan;
    generation: number;
    at: string;
  }
  | {
    type: "capability-plan-update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "capability-plan-clear";
    id: string;
    at: string;
  }
  | {
    type: "capability-plan-clear-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    /**
     * Daemon-initiated, fire-and-forget (no correlated request/result) —
     * `../metrics/topology/`'s stable device/filesystem/GPU/signal identity
     * and generation, reported over the socket by `TopologyReporter`
     * (`./topology-reporter.ts`) so the control plane can persist per-server
     * topology-generation history (`turbopanel/src/client/servers/
     * server-topology-records.ts`).
     */
    type: "topology-report";
    generation: number;
    bootGeneration: number;
    snapshot: TopologySnapshot;
    at: string;
  }
  | {
    type: "container-logs-result";
    id: string;
    logs: string;
    error?: string;
    at: string;
  }
  | {
    type: "managed-ha-event";
    managedId: string;
    sourceMemberId?: string;
    at: string;
  }
  | {
    /**
     * Daemon-initiated, fire-and-forget (no correlated request/result, same
     * shape as `managed-ha-event`) — `AcmeIssuanceObserver`'s live TLS-probe
     * verdict for one `tlsMode: 'acme'` hostname, sent only on a state
     * change (first failure after a short debounce, or a recovery).
     */
    type: "acme-issuance-event";
    hostname: string;
    ok: boolean;
    errorMessage?: string;
    at: string;
  }
  | {
    /**
     * Daemon-initiated, fire-and-forget. The instance's own Let's Encrypt
     * hostnames, reported by `InstanceAcmeRenewalScheduler` for each
     * renewal attempt. Distinct from `acme-issuance-event`, which is an
     * organization's tenant certificate. The two streams must not share a
     * discriminator.
     */
    type: "instance-acme-issuance-event";
    hostname: string;
    ok: boolean;
    errorMessage?: string;
    /** Leaf notAfter from the installed certificate file. */
    notAfter?: string;
    at: string;
  }
  | {
    type: "fabric-paths-request";
    id: string;
    fabricId: string;
    probeMs: number;
    candidates: Array<{ publicKey: string; endpoints: string[] }>;
    at: string;
  }
  | {
    type: "fabric-paths-result";
    id: string;
    paths: Array<{
      publicKey: string;
      endpoint?: string;
      lastHandshakeAt?: string;
      health: "healthy" | "stale" | "never";
      latencyMs?: number;
    }>;
    error?: string;
    at: string;
  }
  | {
    type: "dev-sync-begin";
    id: string;
    totalChunks: number;
    totalBytes: number;
    at: string;
  }
  | {
    type: "dev-sync-chunk";
    id: string;
    index: number;
    data: string;
    at: string;
  }
  | { type: "dev-sync-end"; id: string; at: string }
  | {
    type: "dev-sync-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "tunnel-token"; id: string; token: string; at: string }
  | {
    type: "tunnel-token-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "public-urls-update";
    id: string;
    /** Flat compatibility list. Daemons below the per-hostname floor read only this. */
    urls: string[];
    /** Present when the daemon can render per-hostname certificate sources. */
    hostnames?: InstanceHostnameWireEntry[];
    /** Present when any hostname uses `lets-encrypt`. */
    instanceAcme?: InstanceAcmeWireSettings;
    at: string;
  }
  | {
    type: "public-urls-update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | DaemonUpdateMessage
  | {
    type: "update-result";
    id: string;
    ok: boolean;
    error?: string;
    errorCode?: string;
    upgradeId?: string;
    at: string;
  }
  | InstanceUpdateMessage
  | UpdateProgressMessage
  | {
    type: "instance-update-result";
    id: string;
    ok: boolean;
    error?: string;
    errorCode?: string;
    at: string;
  }
  | {
    type: "command-dispatch";
    id: string;
    commandId: string;
    commandType: string;
    payload: unknown;
    at: string;
  }
  | {
    type: "command-ack";
    id: string;
    at: string;
    daemonReceivedAt: string;
  }
  | {
    type: "command-outcome";
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    at: string;
    daemonReceivedAt?: string;
    daemonRespondedAt?: string;
  };
