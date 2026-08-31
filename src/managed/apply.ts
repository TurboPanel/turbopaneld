/**
 * Managed engine apply: materialize → compose up → credentials.
 */

import type {
  EnvironmentDeployContainer,
  ManagedApplyCredential,
  ManagedApplyPayload,
  ManagedApplyResult,
} from "../instance/commands/contracts.ts";
import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import { ensureManagedIngressNetwork } from "./networks.ts";
import {
  createStreamedRunner,
  type DockerCliResult,
  dockerOutputLooksLikeSocketPermission,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
  type RunDockerStreamedFn,
} from "../deploy/docker-cli.ts";
import { captureDecryptedSecrets } from "../logs/capture.ts";
import {
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
  createNoopCommandOutputSink,
} from "../logs/contracts.ts";
import { redactPlaintexts } from "../logs/redactor.ts";
import { logInfo, sanitizeForLog } from "../logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  runDockerSetup as defaultRunDockerSetup,
  runProxySqlSetup,
} from "../orchestration/ansible.ts";
import {
  assertPublicPrivateListenerTls,
  MANAGED_ROOT_PASSWORD_VAR,
  normalizeManagedCompose,
} from "./compose.ts";
import {
  collectManagedContainers,
  resolveEngineContainerId,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { reconcileManagedPublicFirewallBestEffort } from "./firewall.ts";
import type { ManagedEngineContext } from "./engines/types.ts";
import {
  materializeManagedState,
  normalizeManagedFileOwnership,
} from "./materialize.ts";
import {
  assertSafeManagedIdentifiers,
  managedComposePath,
  managedComposeProject,
  managedEnvFilePath,
} from "./paths.ts";
import {
  loadProxySqlMonitorCredentials,
  proxySqlHostPrepPresent,
} from "./proxysql-admin.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;
type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type ManagedApplyHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
  /** Execution-log transcript sink (`src/logs/`); defaults to a no-op sink. */
  logSink?: CommandOutputSink;
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /** Test seam — defaults to {@link defaultEnsureDocker}. */
  ensureDocker?: () => Promise<void>;
  /** Test seam — defaults to {@link defaultRunDockerSetup}. */
  runDockerSetup?: () => Promise<void>;
  /** Test seam — defaults to {@link runProxySqlSetup}. */
  runHostPrep?: () => Promise<void>;
};

/**
 * Error/log redaction over the same deny-set the transcript redactor uses
 * (`src/logs/redactor.ts`) — one deny-set construction, two output paths.
 */
function redactSecrets(text: string, plaintexts: readonly string[]): string {
  return sanitizeForLog(redactPlaintexts(text, plaintexts));
}

async function decryptCredentialPasswords(
  credentials: ManagedApplyCredential[],
  decryptSecrets: DecryptSecretsFn,
  redact: (text: string) => string,
): Promise<{ credentials: ManagedApplyCredential[]; plaintexts: string[] }> {
  const envelopes = credentials.map((c) => c.password);
  const plaintexts = await decryptSecrets(envelopes);
  if (plaintexts.length !== envelopes.length) {
    throw new Error("decryptSecrets returned unexpected length");
  }
  const decrypted: ManagedApplyCredential[] = [];
  const secrets: string[] = [];
  for (let i = 0; i < credentials.length; i++) {
    const plain = plaintexts[i];
    if (typeof plain !== "string" || plain.length === 0) {
      throw new Error(
        redact(
          `failed to decrypt credential password for ${
            credentials[i]!.username
          }`,
        ),
      );
    }
    secrets.push(plain);
    decrypted.push({ ...credentials[i]!, password: plain });
  }
  return { credentials: decrypted, plaintexts: secrets };
}

/**
 * `docker exec` failures that mean "the engine is not there right now" —
 * not "the command ran and failed". The MySQL/MariaDB (and to a lesser
 * degree Postgres) official entrypoints run a temporary server for init
 * scripts and then restart the real one; an exec issued in that window
 * either dies with an OCI setns error against the vanished PID, or runs the
 * client fine and fails to connect to the not-yet-listening socket
 * (mysql-family `ERROR 2002`, libpq "connection to server on socket …
 * failed"). Exported for unit tests.
 */
export function isRetryableEngineExecFailure(text: string): boolean {
  return /OCI runtime exec failed|is not running|No such container|is restarting|ERROR 2002\b|connection to server on socket .* failed/i
    .test(text);
}

const ENGINE_EXEC_RETRIES = 10;
const ENGINE_EXEC_RETRY_MS = 3_000;

function buildEngineExec(
  containerId: string,
  redact: (text: string) => string,
  run: RunDockerFn,
  retryDelayMs: number = ENGINE_EXEC_RETRY_MS,
): ManagedEngineContext["exec"] {
  return async (argv, input) => {
    const execOnce = () =>
      run(
        ["exec", "-i", containerId, ...argv],
        input === undefined ? undefined : { input },
      );
    let result = await execOnce();
    for (
      let attempt = 0;
      !result.success &&
      isRetryableEngineExecFailure(`${result.stderr}\n${result.stdout}`) &&
      attempt < ENGINE_EXEC_RETRIES;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      result = await execOnce();
    }
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: redact(result.stderr),
    };
  };
}

/**
 * Cross-host addresses whose ProxySQL dials this engine's private listener:
 * peer members plus bound consumer servers. MySQL/MariaDB scope account
 * hosts with these; Postgres admission lives in pg_hba (control-plane
 * config). Container-name peers ride the managed docker network pattern —
 * only address literals need per-host accounts.
 */
export function resolveClientSourceHosts(
  payload: ManagedApplyPayload,
): string[] {
  const hosts = new Set<string>();
  for (
    const address of [
      ...(payload.replication?.peerAddresses ?? []),
      ...(payload.ingressSourceAddresses ?? []),
    ]
  ) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || address.includes(":")) {
      hosts.add(address);
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

/** Managed engines are loopback-only; external access is via ProxySQL ingress. */
export function resolveManagedApplyHost(
  _exposure: ManagedApplyPayload["exposure"],
): string {
  return "127.0.0.1";
}

async function requireDecryptedCredentials(
  payload: ManagedApplyPayload,
  deps: ManagedApplyHandlerDeps | undefined,
): Promise<
  {
    decrypted: { credentials: ManagedApplyCredential[]; plaintexts: string[] };
    redact: (text: string) => string;
    rootCredential: ManagedApplyCredential;
    /** Per-fronting-server ProxySQL monitor roles (decrypted), when shipped. */
    monitorUsers?: Array<{ user: string; password: string }>;
  }
> {
  if (!deps?.decryptSecrets) {
    throw new Error("managed.apply requires decryptSecrets");
  }

  // Redact is identity until plaintexts are known; rebuilt after decrypt.
  const initialRedact = (text: string) => sanitizeForLog(text);
  const decrypted = await decryptCredentialPasswords(
    payload.credentials,
    deps.decryptSecrets,
    initialRedact,
  );
  const redact = (text: string) => redactSecrets(text, decrypted.plaintexts);

  const rootCredential = decrypted.credentials.find((c) => c.role === "root");
  if (!rootCredential) {
    throw new Error("managed.apply requires a root credential");
  }

  let monitorUsers: Array<{ user: string; password: string }> | undefined;
  if (payload.monitorUsers && payload.monitorUsers.length > 0) {
    const plain = await deps.decryptSecrets(
      payload.monitorUsers.map((m) => m.password),
    );
    if (plain.length !== payload.monitorUsers.length) {
      throw new Error(
        "decryptSecrets returned unexpected length for monitorUsers",
      );
    }
    monitorUsers = [];
    for (let i = 0; i < payload.monitorUsers.length; i++) {
      const password = plain[i];
      const username = payload.monitorUsers[i]!.username;
      if (typeof password !== "string" || password.length === 0) {
        throw new Error(
          `failed to decrypt monitor credential for ${username}`,
        );
      }
      // `redact` closes over this array — monitor passwords join the deny-set.
      decrypted.plaintexts.push(password);
      monitorUsers.push({ user: username, password });
    }
  }

  return { decrypted, redact, rootCredential, monitorUsers };
}

async function cleanupManagedEnvFile(
  envPath: string,
  redact: (text: string) => string,
): Promise<void> {
  try {
    await Deno.remove(envPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logInfo(
        "managed",
        `failed to delete managed env file: ${
          redact(err instanceof Error ? err.message : String(err))
        }`,
      );
    }
  }
}

/** Unlink then create — survives a leftover root-owned file from older normalize. */
async function rewriteDaemonOwnedFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.writeTextFile(path, contents);
  await Deno.chmod(path, mode);
}

async function composeUpWithDockerRetry(
  run: RunDockerFn,
  args: string[],
  runDockerSetup: () => Promise<void>,
): Promise<DockerCliResult> {
  const first = await run(args);
  if (
    first.success ||
    !dockerOutputLooksLikeSocketPermission(first.stdout, first.stderr)
  ) {
    return first;
  }
  await runDockerSetup();
  return await run(args);
}

type ComposeUpManagedEngineArgs = {
  layout: LayoutPaths;
  payload: ManagedApplyPayload;
  composeYaml: string;
  rootCredential: ManagedApplyCredential;
  redact: (text: string) => string;
  runDockerSetup: () => Promise<void>;
  logSink: CommandOutputSink;
  runStreamed: RunDockerStreamedFn;
};

async function composeUpManagedEngine({
  layout,
  payload,
  composeYaml,
  rootCredential,
  redact,
  runDockerSetup,
  logSink,
  runStreamed,
}: ComposeUpManagedEngineArgs): Promise<string> {
  const composePath = managedComposePath(layout, payload.managedId);
  const envPath = managedEnvFilePath(layout, payload.managedId);
  const project = managedComposeProject(payload.managedId);

  await rewriteDaemonOwnedFile(composePath, composeYaml, 0o640);

  try {
    await rewriteDaemonOwnedFile(
      envPath,
      `${MANAGED_ROOT_PASSWORD_VAR}=${rootCredential.password}\n`,
      0o600,
    );

    logSink.setPhase(COMMAND_LOG_PHASES.MANAGED_APPLY);
    const up = await composeUpWithDockerRetry(
      (args) =>
        runStreamed(args, {
          onLine: (event) => logSink.onLine(event.stream, event.line),
        }),
      [
        "compose",
        "--env-file",
        envPath,
        "-p",
        project,
        "-f",
        composePath,
        "up",
        "-d",
        "--remove-orphans",
      ],
      runDockerSetup,
    );
    if (!up.success) {
      throw new Error(
        `managed.apply compose up failed: ${
          redact(up.stderr || up.stdout || "compose up failed")
        }`,
      );
    }
  } finally {
    await cleanupManagedEnvFile(envPath, redact);
  }

  return project;
}

async function dropManagedUsers(
  ctx: ManagedEngineContext,
  engine: ReturnType<typeof getManagedEngineRuntime>,
  payload: ManagedApplyPayload,
  appliedUsers: string[],
): Promise<void> {
  if (
    !payload.dropUsers || payload.dropUsers.length === 0 || !engine.dropUsers
  ) {
    return;
  }
  // Protect both admin identities: the static platform admin
  // (engine.rootUsername) and the payload's exposed root credential
  // (always a different, org-suffixed login — see AGENTS.md 9a).
  const protectedUsernames = new Set([
    engine.rootUsername,
    ...(payload.credentials ?? [])
      .filter((credential) => credential.role === "root")
      .map((credential) => credential.username),
  ]);
  const toDrop = payload.dropUsers.filter(
    (username) => !protectedUsernames.has(username),
  );
  if (toDrop.length === 0) return;
  const dropped = await engine.dropUsers(ctx, toDrop);
  appliedUsers.push(...dropped);
}

/**
 * Primary path: credentials + databases + version.
 * Standby is read-only for **user-data** mutation — never run credential /
 * database SQL here. Engines whose standby is configured by SQL (MySQL /
 * MariaDB) still run {@link ManagedEngineReplicationRuntime.configureStandby}
 * first (replication channel setup is not user-data mutation).
 */
export async function applyManagedEngineState(
  ctx: ManagedEngineContext,
  engine: ReturnType<typeof getManagedEngineRuntime>,
  payload: ManagedApplyPayload,
  credentials: ManagedApplyCredential[],
  deps?: {
    runHostPrep?: () => Promise<void>;
    /** Decrypted per-fronting-server monitor roles from payload.monitorUsers. */
    monitorUsers?: Array<{ user: string; password: string }>;
  },
): Promise<
  {
    appliedUsers: string[];
    appliedDatabases: string[];
    engineVersion: string | undefined;
  }
> {
  await engine.waitReady(ctx);

  // materializeManagedState may have rewritten bind-mounted config without a
  // container recreate (`compose up -d` ignores mounted-content changes) —
  // reload so pg_hba.conf / reloadable settings take effect this apply.
  if (engine.reloadConfig) {
    await engine.reloadConfig(ctx);
  }

  if (payload.replication?.role === "standby") {
    await configureStandbyIfSupported(ctx, engine, payload, credentials);
    const engineVersion = await engine.readVersion(ctx);
    return { appliedUsers: [], appliedDatabases: [], engineVersion };
  }

  const appliedUsers = await engine.applyCredentials(ctx, credentials);
  await dropManagedUsers(ctx, engine, payload, appliedUsers);
  await ensureProxySqlMonitorRoles(ctx, engine, deps);
  const appliedDatabases = payload.databases
    ? await engine.applyDatabases(ctx, payload.databases)
    : [];
  const engineVersion = await engine.readVersion(ctx);
  return { appliedUsers, appliedDatabases, engineVersion };
}

async function configureStandbyIfSupported(
  ctx: ManagedEngineContext,
  engine: ReturnType<typeof getManagedEngineRuntime>,
  payload: ManagedApplyPayload,
  credentials: ManagedApplyCredential[],
): Promise<void> {
  const replication = payload.replication;
  if (
    !replication ||
    !engine.replication?.configureStandby ||
    !replication.primary
  ) {
    return;
  }
  const replCred = credentials.find((c) => c.role === "replication");
  if (!replCred) return;
  await engine.replication.configureStandby(ctx, {
    username: replication.username,
    password: replCred.password,
    primary: replication.primary,
    slotName: replication.slotName ?? `tp_member_${payload.memberOrdinal}`,
  });
}

/**
 * Control-plane-minted per-server monitor roles: one per fronting server
 * (members + bound consumers), so every server's ProxySQL can monitor this
 * engine with its own identity. Standbys inherit the roles via WAL replay.
 * Legacy fallback: host-seeded monitor.cnf (older control planes).
 */
async function ensureProxySqlMonitorRoles(
  ctx: ManagedEngineContext,
  engine: ReturnType<typeof getManagedEngineRuntime>,
  deps?: {
    runHostPrep?: () => Promise<void>;
    monitorUsers?: Array<{ user: string; password: string }>;
  },
): Promise<void> {
  if (!engine.ensureProxySqlMonitor) return;

  const monitorUsers = deps?.monitorUsers;
  if (monitorUsers && monitorUsers.length > 0) {
    for (const monitor of monitorUsers) {
      await engine.ensureProxySqlMonitor(ctx, monitor);
    }
    logInfo(
      "managed",
      `managed.apply ensured ${monitorUsers.length} ProxySQL monitor role(s)`,
    );
    return;
  }

  const layout = resolveLayout(Deno.env.toObject());
  const prepPresent = await proxySqlHostPrepPresent(layout);
  if (!prepPresent && deps?.runHostPrep) {
    await deps.runHostPrep();
  }
  const monitor = await loadProxySqlMonitorCredentials(layout);
  if (monitor) {
    await engine.ensureProxySqlMonitor(ctx, monitor);
    logInfo("managed", "managed.apply ensured ProxySQL monitor role");
  } else {
    logInfo(
      "managed",
      "managed.apply skipped ProxySQL monitor role (monitor.cnf missing)",
    );
  }
}

/** Pure member DTO for needs_resync early-return path. Exported for tests. */
export function buildNeedsResyncMember(
  memberId: string,
): NonNullable<ManagedApplyResult["member"]> {
  return {
    memberId,
    role: "replica",
    status: "needs_resync",
    replication: {
      state: "needs_resync",
      observedAt: new Date().toISOString(),
    },
  };
}

function buildManagedApplyResult(
  payload: ManagedApplyPayload,
  state: {
    appliedUsers: string[];
    appliedDatabases: string[];
    engineVersion: string | undefined;
  },
  containers: EnvironmentDeployContainer[] | undefined,
  member?: ManagedApplyResult["member"],
): ManagedApplyResult {
  const result: ManagedApplyResult = {
    host: resolveManagedApplyHost(payload.exposure),
    port: payload.containerPort,
    appliedUsers: state.appliedUsers,
    ...(state.appliedDatabases.length > 0
      ? { appliedDatabases: state.appliedDatabases }
      : {}),
    ...(state.engineVersion !== undefined
      ? { engineVersion: state.engineVersion }
      : {}),
    summary: `managed ${payload.engine} applied`,
  };
  if (containers !== undefined) {
    result.containers = containers;
  }
  if (member !== undefined) {
    result.member = member;
  }
  return result;
}

/**
 * Volume already has data that is not a standby. Stop any running project so
 * we never promote it as a writable primary, and return needs_resync without
 * compose up or engine SQL mutation.
 */
async function returnStandbyNeedsResync(
  payload: ManagedApplyPayload,
  redact: (text: string) => string,
  run: RunDockerFn,
): Promise<ManagedApplyResult> {
  const project = managedComposeProject(payload.managedId);
  const stop = await run(["compose", "-p", project, "stop"]);
  if (!stop.success) {
    logInfo(
      "managed",
      `needs_resync compose stop soft-failed project=${project}: ${
        redact(stop.stderr || stop.stdout || "compose stop failed")
      }`,
    );
  }

  const observedAt = new Date().toISOString();
  const member = payload.memberId
    ? buildNeedsResyncMember(payload.memberId)
    : undefined;

  // buildNeedsResyncMember stamps its own observedAt; refresh is immaterial.
  if (member?.replication) {
    member.replication.observedAt = observedAt;
  }

  return buildManagedApplyResult(
    payload,
    { appliedUsers: [], appliedDatabases: [], engineVersion: undefined },
    undefined,
    member,
  );
}

async function collectMemberHealth(
  ctx: ManagedEngineContext,
  engine: ReturnType<typeof getManagedEngineRuntime>,
  payload: ManagedApplyPayload,
  decryptedCredentials: ManagedApplyCredential[],
): Promise<ManagedApplyResult["member"] | undefined> {
  if (!payload.memberId) return undefined;

  if (payload.replication && engine.replication) {
    if (payload.replication.role === "primary") {
      const replCred = decryptedCredentials.find(
        (c) => c.role === "replication",
      );
      if (replCred) {
        await engine.replication.ensurePrimary(ctx, {
          username: payload.replication.username,
          password: replCred.password,
          desiredSlots: payload.replication.desiredSlots ?? [],
          peerAddresses: payload.replication.peerAddresses,
        });
      }
    }
    const health = await engine.replication.readHealth(
      ctx,
      payload.replication.role === "primary" ? "primary" : "standby",
    );
    return {
      memberId: payload.memberId,
      role: payload.memberRole,
      status: "ready",
      replication: health,
    };
  }

  return {
    memberId: payload.memberId,
    role: payload.memberRole,
    status: "ready",
  };
}

export async function handleManagedApply(
  payload: ManagedApplyPayload,
  _daemonReceivedAt: string,
  deps?: ManagedApplyHandlerDeps,
): Promise<ManagedApplyResult> {
  assertSafeManagedIdentifiers(payload);
  // Fail before any state is materialized: a public listener without org-CA
  // material must never reach materialize/compose up.
  assertPublicPrivateListenerTls(payload);
  const layout = resolveLayout(Deno.env.toObject());
  const engine = getManagedEngineRuntime(payload.engine);
  const run = deps?.runDocker ?? defaultRunDocker;
  const runStreamed = createStreamedRunner(deps?.runDocker);
  const logSink = deps?.logSink ?? createNoopCommandOutputSink();
  logSink.setPhase(COMMAND_LOG_PHASES.MANAGED_APPLY);
  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;
  const runDockerSetup = deps?.runDockerSetup ?? defaultRunDockerSetup;
  const runHostPrep = deps?.runHostPrep ?? runProxySqlSetup;

  await ensureDocker();
  // Before any `compose up` (engine or bootstrap `docker run --network …`):
  // the organization's managed network must exist first or compose fails on
  // the external network reference.
  await ensureManagedIngressNetwork(payload.managedNetwork, run);

  const managedRoot = await materializeManagedState(
    layout,
    payload,
    // Everything this apply decrypts joins the transcript deny-set.
    captureDecryptedSecrets(deps?.decryptSecrets, logSink),
  );
  await normalizeManagedFileOwnership(
    payload.image,
    managedRoot,
    engine.containerUser,
    engine.containerGroup,
    run,
  );

  const { decrypted, redact, rootCredential, monitorUsers } =
    await requireDecryptedCredentials(payload, deps);
  // Same deny-set for the bounded WS error text and the streamed transcript.
  logSink.addSecrets(decrypted.plaintexts);

  // Standby bootstrap must run before compose up (empty volume → avoid dual primary).
  if (
    payload.replication?.role === "standby" &&
    engine.replication &&
    payload.replication.primary
  ) {
    const replCred = decrypted.credentials.find((c) =>
      c.role === "replication"
    );
    if (!replCred) {
      throw new Error(
        "managed.apply standby requires a replication credential",
      );
    }
    if (payload.forceResync === true) {
      // Never wipe a datadir under a live engine: the old process keeps
      // handles to deleted inodes, loses runtime dirs (#binlog_cache_files),
      // and — since the compose text is unchanged — `up -d` would not even
      // recreate it, so the entrypoint never re-initializes. Remove the
      // container first; compose up below recreates it fresh. Best effort:
      // the container may not exist.
      await run(["rm", "-f", payload.containerName]);
    }
    const boot = await engine.replication.bootstrapStandby(
      {
        managedId: payload.managedId,
        image: payload.image,
        managedNetwork: payload.managedNetwork,
        volumes: payload.volumes,
        stateDir: managedRoot,
        containerUser: engine.containerUser,
        containerGroup: engine.containerGroup,
        runDocker: async (argv, options) => {
          const result = await run(argv, options);
          return {
            success: result.success,
            stdout: result.stdout,
            stderr: redact(result.stderr),
          };
        },
      },
      {
        username: payload.replication.username,
        password: replCred.password,
        primary: payload.replication.primary,
        slotName: payload.replication.slotName ??
          `tp_member_${payload.memberOrdinal}`,
        ...(payload.forceResync === true ? { forceResync: true } : {}),
      },
    );
    if (boot === "needs_resync") {
      return await returnStandbyNeedsResync(payload, redact, run);
    }
  }

  const { composeYaml, composeServiceName } = normalizeManagedCompose(payload);
  const project = await composeUpManagedEngine({
    layout,
    payload,
    composeYaml,
    rootCredential,
    redact,
    runDockerSetup,
    logSink,
    runStreamed,
  });

  // Scope the public listener once the publish exists; never blocks apply.
  await reconcileManagedPublicFirewallBestEffort(payload);

  const engineContainers = await collectManagedContainers(project, redact, run);
  const containerId = resolveEngineContainerId(
    engineContainers,
    composeServiceName,
  );

  const ctx: ManagedEngineContext = {
    containerId,
    composeServiceName,
    rootUsername: engine.rootUsername,
    defaultDatabase: engine.defaultDatabase,
    exec: buildEngineExec(containerId, redact, run),
    ...(payload.engine === "mysql" || payload.engine === "mariadb"
      ? { socketPassword: rootCredential.password }
      : {}),
    clientSourceHosts: resolveClientSourceHosts(payload),
  };

  try {
    const state = await applyManagedEngineState(
      ctx,
      engine,
      payload,
      decrypted.credentials,
      { runHostPrep, monitorUsers },
    );

    const member = await collectMemberHealth(
      ctx,
      engine,
      payload,
      decrypted.credentials,
    );

    return buildManagedApplyResult(payload, state, engineContainers, member);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redact(message));
  }
}
