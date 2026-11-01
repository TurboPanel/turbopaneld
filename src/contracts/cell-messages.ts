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
import type {
  DrivetempEnableResult,
  FabricReconcileObservedPeer,
  ManagedMemberObservedResult,
} from "./commands-contracts.ts";
import type { HardwareProfile } from "../metrics/collector/types.ts";
import type { MetricsCapabilityPlan } from "../metrics/capability-plan.ts";
import type { TopologySnapshot } from "./topology-types.ts";
import type { ManagedPermissionsObserved } from "./managed-permissions-observed.ts";
export {
  OBSERVED_LEVELS,
  OBSERVED_MAX_COLUMNS,
  OBSERVED_MAX_DATABASES,
  OBSERVED_MAX_GRANTS_PER_LOGIN,
  OBSERVED_MAX_LOGINS,
  OBSERVED_MAX_NAME_CHARS,
  OBSERVED_MAX_PRIVILEGES,
} from "./managed-permissions-observed.ts";
export type {
  ManagedPermissionsObserved,
  ObservedAccount,
  ObservedAttributes,
  ObservedDefaultGrant,
  ObservedGrant,
  ObservedLevel,
  ObservedLogin,
  ObservedMembership,
} from "./managed-permissions-observed.ts";

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
  /**
   * Advised idle-ping cadence in seconds. The frame is unsigned, so the
   * daemon clamps it to [15, 120]; pinned daemons use the signed hello.
   */
  heartbeatSeconds?: number;
};

/** One replica in a `managed-health-report`: `down`, or its reading. */
export type ManagedHealthReportMember = {
  managedId: string;
  memberId: string;
  /** The engine is not running or not answering. */
  down?: true;
  replication?: NonNullable<ManagedMemberObservedResult["replication"]>;
};

/**
 * Commands this daemon still owes the control plane (feature
 * `command-recovery-v1`), sent on `hello` and `heartbeat` when either list is
 * not empty. `running` holds the ids of commands accepted and not finished
 * (including any waiting behind another build); `unacked` holds the ids whose
 * final `command-outcome` is kept on disk until a
 * {@link CommandOutcomeAckMessage} arrives. At most 64 ids of 64 characters
 * each per list. Twin of `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type CommandRecoveryReport = {
  running: string[];
  unacked: string[];
};

/**
 * Control plane → daemon: the final outcome of command `id` is stored, so the
 * daemon may drop its journaled copy. Until it arrives the daemon sends the
 * outcome again on every attach and every 30 seconds. Twin of
 * `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type CommandOutcomeAckMessage = {
  type: "command-outcome-ack";
  id: string;
  at: string;
};

/** Daemon → control plane hello. `features` is the advertised wire set. */
export type DaemonHelloMessage = {
  type: "hello";
  at: string;
  features?: string[];
  commands?: CommandRecoveryReport;
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

/**
 * Outcome of an `instance-update`. `errorCode` is the rollback or preflight
 * reason; `upgradeId` echoes the run the control plane dispatched it for, so
 * a rollback is recorded against the right upgrade step.
 */
export type InstanceUpdateResultMessage = {
  type: "instance-update-result";
  id: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  upgradeId?: string;
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
  /**
   * How the daemon's own restart went, sent with a `failed` stage whose
   * `errorCode` is `restart_failed`. Optional: an older control plane ignores
   * it and an older daemon never sends it.
   */
  restart?: UpdateRestartReport;
};

/** Diagnostics for a daemon restart that was reported as failed. */
export type UpdateRestartReport = {
  /** `enable` or `restart`: the `systemctl` verb that failed. */
  command?: string;
  exitCode?: number;
  signal?: string;
  stderr?: string;
  /** Times the command ran (2 after the one retry). */
  attempts: number;
  elapsedMs: number;
};

/** Longest `steps[]` a `command-progress` payload carries. */
export const COMMAND_PROGRESS_MAX_STEPS = 24;
export const COMMAND_PROGRESS_MAX_ID_CHARS = 64;
export const COMMAND_PROGRESS_MAX_LABEL_CHARS = 60;
export const COMMAND_PROGRESS_MAX_DETAIL_CHARS = 200;
/** Whole serialised payload, in bytes. */
export const COMMAND_PROGRESS_MAX_BYTES = 8 * 1024;

export type CommandProgressStepState =
  /** Already on the server, nothing to do (shown ticked from the start). */
  | "ready"
  /** Planned, not started. */
  | "pending"
  | "running"
  | "done"
  | "failed"
  /** Never ran because an earlier step failed or the deploy was cancelled. */
  | "skipped";

/**
 * One step of a command's plan. Twin of `CommandProgressStep` in
 * `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type CommandProgressStep = {
  /** Stable id: a kind, optionally `:` and a target (`install-php:8.3`). */
  id: string;
  /** Plain words, user facing, no vendor platform names. */
  label: string;
  state: CommandProgressStepState;
  /** ISO 8601. */
  startedAt?: string;
  /** ISO 8601. */
  finishedAt?: string;
  /** Live ticker text for the running step (the current playbook task). */
  detail?: string;
};

export type CommandProgress = {
  version: 1;
  /** In execution order. */
  steps: CommandProgressStep[];
  /** Id of the running step, or null when none is running. */
  current: string | null;
  /** ISO 8601. */
  updatedAt: string;
  /**
   * When the server began actually running this command, or `null` while it
   * waits for the host (another build holds the single build slot). Absent
   * from a daemon that does not report it. The control plane starts the
   * command's run deadline from here, so waiting never counts against it.
   */
  runningSince?: string | null;
};

/**
 * Daemon → control plane step plan and live progress of one command.
 * Fire-and-forget like `update-progress`: a lost message is harmless because
 * every message carries the whole payload.
 */
export type CommandProgressMessage = {
  type: "command-progress";
  /** Correlation id, like `update-progress.id`. */
  id: string;
  commandId: string;
  at: string;
  progress: CommandProgress;
};

/**
 * One control-plane hostname on `public-urls-update`. For an `uploaded`
 * source the key arrives as `keyEnvelope`, a `tpdaemon` envelope this daemon
 * opens through `POST /api/daemon/v1/secrets/decrypt` (it advertises
 * `sealed-instance-secrets-v1`); an older control plane sends the legacy
 * plaintext `keyPem`, still accepted. The daemon writes the pair under the
 * instance certs dir and does not echo it back.
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
  keyEnvelope?: string;
  uploadedCertId?: string;
};

/**
 * Instance → daemon: start (or, with an empty `token`, stop) the Cloudflare
 * tunnel. A non-empty token arrives as `tokenEnvelope` (`tpdaemon`) from a
 * control plane that sees `sealed-instance-secrets-v1`; `token` is the legacy
 * plaintext field. Twin of `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type TunnelTokenMessage = {
  type: "tunnel-token";
  id: string;
  token?: string;
  tokenEnvelope?: string;
  at: string;
};

/**
 * Daemon → control plane: one finished scheduled backup run, read from this
 * host's result spool. Correlated by `id`: the spooled result is deleted only
 * when a {@link BackupRunReportResultMessage} with the same `id` arrives, so a
 * report lost in a disconnect is simply sent again, and `runId` (unique per
 * policy) makes the second copy a no-op. The artifact fields are present when
 * `status` is `succeeded`. Twin of `turbopanel/src/contracts/cell-protocol.ts`;
 * not sent yet (Road row `r2-backup-status-report` wires it).
 */
export type BackupRunReportMessage = {
  type: "backup-run-report";
  id: string;
  policyId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: "succeeded" | "failed";
  error?: string;
  backupId?: string;
  sizeBytes?: number;
  checksum?: string;
  path?: string;
  /** The database a managed engine's run dumped; absent for storage copies. */
  database?: string;
  /** `bk_` ids this run's retention removed from the policy's directory. */
  pruned?: string[];
  /** When the policy's timer next fires, read from systemd after the run. */
  nextRunAt?: string;
  at: string;
};

/**
 * Control plane → daemon: the report with this `id` is stored (`ok: true`) or
 * refused for good (`ok: false`) — either way the spooled result is dropped.
 * No reply means a transient failure, and the report is sent again. Twin of
 * `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type BackupRunReportResultMessage = {
  type: "backup-run-report-result";
  id: string;
  ok: boolean;
  error?: string;
  at: string;
};

/**
 * Daemon → control plane: how copying one finished backup to its S3-compatible
 * target ended (feature `backup-s3-copy-v1`; sent only to a control plane that
 * lists it). Correlated by `id` like {@link BackupRunReportMessage}: the
 * spooled report is deleted only when a {@link BackupCopyReportResultMessage}
 * with the same `id` arrives, and a second copy of the same report is a no-op.
 * Twin of `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type BackupCopyReportMessage = {
  type: "backup-copy-report";
  id: string;
  destinationId: string;
  managedId: string;
  backupId: string;
  policyId?: string;
  state: "copied" | "failed";
  /** A plain reason when `state` is `failed`. */
  error?: string;
  /** Object key inside the bucket (the target's prefix included). */
  objectKey?: string;
  sizeBytes?: number;
  attempts: number;
  finishedAt: string;
  /** `bk_` ids the bucket retention removed after this copy. */
  pruned?: string[];
  at: string;
};

/** Control plane → daemon: the copy report with this `id` is stored or refused for good. */
export type BackupCopyReportResultMessage = {
  type: "backup-copy-report-result";
  id: string;
  ok: boolean;
  error?: string;
  at: string;
};

/**
 * Control plane → daemon: read what these logins may do right now (feature
 * `managed-permissions-read-v1`). Read only: the daemon runs SELECT / SHOW
 * statements and nothing else. Twin of `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type ManagedPermissionsRequestMessage = {
  type: "managed-permissions-request";
  id: string;
  managedId: string;
  engine: string;
  /** Applied engine usernames (up to {@link OBSERVED_MAX_LOGINS}). */
  logins: string[];
  /** Postgres: databases whose objects to read. Ignored for MySQL and MariaDB. */
  databases: string[];
  at: string;
};

/**
 * Daemon → control plane, on the request's `id`. Always sent: any failure is
 * `ok: false` with a short `error`. The JSON stays under 100 KB.
 */
export type ManagedPermissionsResultMessage = {
  type: "managed-permissions-result";
  id: string;
  ok: boolean;
  permissions?: ManagedPermissionsObserved;
  error?: string;
  at: string;
};

/** One peer address the daemon is asked to try (feature `server-network-check-v1`). */
export type ServerNetworkCheckTarget = {
  peerServerId: string;
  /** The peer's address on the network being checked (an IPv4 or IPv6 literal). */
  address: string;
  /** A TCP port the peer already listens on, reached from this host. */
  port: number;
};

/** What happened for one {@link ServerNetworkCheckTarget}. */
export type ServerNetworkCheckEntry = {
  peerServerId: string;
  address: string;
  reachable: boolean;
  /** Time to open the connection, whole milliseconds. Only when reachable. */
  latencyMs?: number;
  /** The local address the connection left from. Only when reachable. */
  sourceAddress?: string;
  /** The local interface that owns {@link sourceAddress}, when known. */
  interface?: string;
  /** A short reason when not reachable: `refused`, `timeout`, `unreachable`, `invalid_target`. */
  error?: string;
};

/**
 * Control plane → daemon: try to open a TCP connection from this host to each
 * target and say what happened (feature `server-network-check-v1`). Nothing is
 * sent on the connection and nothing is stored. Twin of
 * `turbopanel/src/contracts/cell-protocol.ts`.
 */
export type ServerNetworkCheckRequestMessage = {
  type: "server-network-check-request";
  id: string;
  /** Up to {@link SERVER_NETWORK_CHECK_MAX_TARGETS}. */
  targets: ServerNetworkCheckTarget[];
  at: string;
};

/**
 * Daemon → control plane, on the request's `id`. Always sent: a request that
 * cannot be run at all is `ok: false` with a short `error`; otherwise `results`
 * holds one entry per target, in order.
 */
export type ServerNetworkCheckResultMessage = {
  type: "server-network-check-result";
  id: string;
  ok: boolean;
  results?: ServerNetworkCheckEntry[];
  error?: string;
  at: string;
};

/** Most targets in one `server-network-check-request`. */
export const SERVER_NETWORK_CHECK_MAX_TARGETS = 32;

/** Instance-wide ACME knobs for hostnames whose source is `lets-encrypt`. */
export type InstanceAcmeWireSettings = {
  contactEmail: string;
  tosAccepted: boolean;
  directoryUrl: string;
  useStaging: boolean;
};

/**
 * Control plane to daemon (feature `acme-issue-v1`): place the certificate order
 * for `names` from this server's own addresses over the HTTP proof. The finished
 * pair is reported through `POST /api/daemon/v1/tls/issued` with `requestId`;
 * no message ever carries the pair. Twin of the control plane's
 * `AcmeIssueRequestMessage`.
 */
export type AcmeIssueRequestMessage = {
  type: "acme-issue-request";
  requestId: string;
  tlsId: string;
  names: string[];
  directory: "production" | "staging";
  contactEmail: string;
  /** The request is open until this time (ISO 8601). */
  startByIso: string;
  /** Other servers that pass the proof path on; each is checked before the order. */
  helpers: AcmeProofHelper[];
  at: string;
};

export type AcmeProofHelper = { serverId: string; address: string };

/** Control plane to daemon: pass `/.well-known/acme-challenge/*` for `names` to `targetAddress` until `expiresAtIso`. */
export type AcmeProofForwardMessage = {
  type: "acme-proof-forward";
  requestId: string;
  names: string[];
  targetAddress: string;
  expiresAtIso: string;
  at: string;
};

/** Control plane to daemon: stop passing the proof path on for this request. */
export type AcmeProofForwardEndMessage = {
  type: "acme-proof-forward-end";
  requestId: string;
  at: string;
};

/**
 * Daemon to control plane: how the order is going. Never carries the
 * certificate or its key.
 */
export type AcmeIssueEventMessage = {
  type: "acme-issue-event";
  requestId: string;
  stage: "started" | "issued" | "failed";
  /** A plain reason when `stage` is `failed`. */
  reason?: string;
  /** Leaf expiry (ISO 8601) when `stage` is `issued`. */
  notAfterIso?: string;
  at: string;
};

/** Daemon to control plane: the proof path is passed on (`-ready`) or could not be (`-failed`). */
export type AcmeProofForwardReportMessage = {
  type: "acme-proof-forward-ready" | "acme-proof-forward-failed";
  requestId: string;
  reason?: string;
  at: string;
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
    type: "managed-health-request";
    id: string;
    managedId: string;
    memberId: string;
    /** The member's real role: a `replica` is read as a standby. */
    role: "primary" | "replica";
    engine: string;
    at: string;
  }
  | {
    type: "managed-health-result";
    id: string;
    ok: boolean;
    member?: ManagedMemberObservedResult;
    error?: string;
    at: string;
  }
  | ManagedPermissionsRequestMessage
  | ManagedPermissionsResultMessage
  | ServerNetworkCheckRequestMessage
  | ServerNetworkCheckResultMessage
  | {
    /**
     * Daemon-initiated, fire-and-forget: every managed replica this host runs,
     * read just now. Sent every 30 s, only to a control plane advertising
     * `managed-health-report-v1`. A replica whose engine is down is sent as
     * `down: true` (no `replication`).
     */
    type: "managed-health-report";
    members: ManagedHealthReportMember[];
    at: string;
  }
  | {
    /**
     * Daemon-initiated, fire-and-forget: every `tp0` peer as read by the 60 s
     * refresh (`wg show tp0 dump`). Sent when a peer's health class changed,
     * otherwise at most every 5 minutes, only to a control plane advertising
     * `fabric-peer-report-v1`. `observedAt` is when the dump was read.
     */
    type: "fabric-peers-report";
    peers: FabricReconcileObservedPeer[];
    observedAt: string;
    at: string;
  }
  | {
    /**
     * Daemon-initiated, fire-and-forget: a package source's signing key
     * (`got`, hex) is not in the `expected` list. The install went on (apt
     * still checks every package signature). Sent once per key name and
     * fingerprint, only to a control plane advertising `repo-key-report-v1`.
     */
    type: "repo-key-changed";
    keyName: string;
    expected: string[];
    got: string;
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
     * Control plane asks the daemon to stop one running `environment.deploy`
     * (`commandId`). Sent only to a daemon advertising `deploy-cancel-v1`.
     */
    type: "deploy-cancel";
    id: string;
    commandId: string;
    at: string;
  }
  | {
    /**
     * `cancelling`: the deploy was signalled and will end with a
     * `cancelled: ` command outcome. `too_late`: it already switched over and
     * will finish normally. `not_running`: no such deploy is running here (the
     * cancel is remembered briefly, so a dispatch that arrives later is refused).
     */
    type: "deploy-cancel-result";
    id: string;
    ok: boolean;
    outcome?: "cancelling" | "too_late" | "not_running";
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
    /**
     * Who decided the primary is dead. Absent = the Orchestrator poller
     * (`ha-observe.ts`); `postgres-probe` = `pg-dead-primary-observe.ts`,
     * sent only to a control plane advertising `managed-ha-probe-v1`;
     * `boot-hold` = a primary held after an unclean host restart
     * (`instance/boot-hold-reporter.ts`, feature `managed-ha-boot-hold-v1`),
     * never a failover request.
     */
    detector?: "orchestrator" | "postgres-probe" | "boot-hold";
    /**
     * Orchestrator's key for the dead instance (`ha-observe.ts` only; feature
     * `managed-ha-instance-v1`). Both or neither. The control plane fences
     * only when they match the cluster's current primary.
     */
    instanceHost?: string;
    instancePort?: number;
    /** Bounded detector evidence (failure count, last error, container state). */
    evidence?: Record<string, unknown>;
    at: string;
  }
  | {
    /**
     * Daemon-initiated, fire-and-forget (no correlated request/result, same
     * shape as `managed-ha-event`) — `AcmeIssuanceObserver`'s live TLS-probe
     * verdict for one `tlsMode: 'acme'` hostname, sent only on a state
     * change (first failure after a short debounce, a recovery, the first
     * good sighting, or a renewal that moves `notAfter`).
     */
    type: "acme-issuance-event";
    hostname: string;
    ok: boolean;
    errorMessage?: string;
    /**
     * Leaf expiry (ISO 8601) the probe read, sent with `ok: true` on the
     * first good sighting, on recovery and when a renewal changes it.
     */
    notAfter?: string;
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
  | TunnelTokenMessage
  | AcmeIssueRequestMessage
  | AcmeProofForwardMessage
  | AcmeProofForwardEndMessage
  | AcmeIssueEventMessage
  | AcmeProofForwardReportMessage
  | {
    type: "tunnel-token-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | BackupRunReportMessage
  | BackupRunReportResultMessage
  | BackupCopyReportMessage
  | BackupCopyReportResultMessage
  | CommandOutcomeAckMessage
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
  | CommandProgressMessage
  | InstanceUpdateResultMessage
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

// --- acme-issue-v1 shape checks -------------------------------------------
// Mirrors of the control plane's validators in `src/contracts/cell-protocol.ts`
// (same names, same limits). Unknown optional fields are ignored (expand-only),
// but a field that could carry the certificate or its key is always refused.

export const MAX_ACME_ISSUE_NAMES = 100;
export const MAX_ACME_ISSUE_HELPERS = 64;
const MAX_WS_ID_CHARS = 128;
const MAX_WS_ERROR_CHARS = 4 * 1024;

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** A plain lower-case DNS name: no wildcard, no upper case, no trailing dot. */
const ACME_NAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** An IPv4 or IPv6 address literal as text. */
const ACME_ADDRESS_RE = /^[0-9a-f:.]{2,45}$/;
export const ACME_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Field names that would carry certificate material; refused on every acme-issue message. */
const ACME_FORBIDDEN_KEYS = [
  "certificatePem",
  "privateKeyPem",
  "privateKey",
  "certificate",
  "key",
  "pem",
];

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 &&
    ISO_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_WS_ID_CHARS;
}

function validateOptionalError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return "error must be a string";
  return value.length > MAX_WS_ERROR_CHARS ? "error exceeds max length" : null;
}

function validateAcmeRequestId(value: unknown): string | null {
  return typeof value === "string" && ACME_REQUEST_ID_RE.test(value)
    ? null
    : "invalid requestId";
}

function validateAcmeNames(value: unknown): string | null {
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.length > MAX_ACME_ISSUE_NAMES
  ) {
    return "invalid names";
  }
  const ok = value.every((n) =>
    typeof n === "string" && n.length <= 253 && ACME_NAME_RE.test(n)
  );
  return ok ? null : "invalid names";
}

function validateAcmeAddress(value: unknown): boolean {
  return typeof value === "string" && ACME_ADDRESS_RE.test(value);
}

function validateAcmeHelpers(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > MAX_ACME_ISSUE_HELPERS) {
    return "invalid helpers";
  }
  for (const item of value) {
    const helper = item as { serverId?: unknown; address?: unknown } | null;
    if (
      typeof helper !== "object" || helper === null ||
      !isBoundedId(helper.serverId)
    ) {
      return "invalid helpers";
    }
    if (!validateAcmeAddress(helper.address)) return "invalid helpers";
  }
  return null;
}

function acmeForbiddenKey(record: Record<string, unknown>): string | null {
  return ACME_FORBIDDEN_KEYS.some((k) => k in record)
    ? "must not carry certificate material"
    : null;
}

function firstProblem(...problems: Array<string | null>): string | null {
  return problems.find((p) => p !== null) ?? null;
}

/** Shape check for `acme-issue-request`. */
export function validateAcmeIssueRequestFields(
  record: Record<string, unknown>,
): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    isBoundedId(record.tlsId) ? null : "invalid tlsId",
    validateAcmeNames(record.names),
    record.directory === "production" || record.directory === "staging"
      ? null
      : "invalid directory",
    typeof record.contactEmail === "string" &&
      record.contactEmail.length > 0 &&
      record.contactEmail.length <= 254
      ? null
      : "invalid contactEmail",
    isIsoTimestamp(record.startByIso) ? null : "invalid startByIso",
    validateAcmeHelpers(record.helpers),
    isIsoTimestamp(record.at) ? null : "invalid at timestamp",
    acmeForbiddenKey(record),
  );
}

/** Shape check for `acme-proof-forward`. */
export function validateAcmeProofForwardFields(
  record: Record<string, unknown>,
): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    validateAcmeNames(record.names),
    validateAcmeAddress(record.targetAddress) ? null : "invalid targetAddress",
    isIsoTimestamp(record.expiresAtIso) ? null : "invalid expiresAtIso",
    isIsoTimestamp(record.at) ? null : "invalid at timestamp",
    acmeForbiddenKey(record),
  );
}

/** Shape check for `acme-proof-forward-end`. */
export function validateAcmeProofForwardEndFields(
  record: Record<string, unknown>,
): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    isIsoTimestamp(record.at) ? null : "invalid at timestamp",
  );
}

/** Shape check for `acme-issue-event`. Never accepts a pair. */
export function validateAcmeIssueEventFields(
  record: Record<string, unknown>,
): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    record.stage === "started" || record.stage === "issued" ||
      record.stage === "failed"
      ? null
      : "invalid stage",
    record.notAfterIso === undefined || isIsoTimestamp(record.notAfterIso)
      ? null
      : "invalid notAfterIso",
    validateOptionalError(record.reason),
    isIsoTimestamp(record.at) ? null : "invalid at timestamp",
    acmeForbiddenKey(record),
  );
}

/** Shape check for `acme-proof-forward-ready` and `acme-proof-forward-failed`. */
export function validateAcmeProofForwardReportFields(
  record: Record<string, unknown>,
): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    validateOptionalError(record.reason),
    isIsoTimestamp(record.at) ? null : "invalid at timestamp",
    acmeForbiddenKey(record),
  );
}
