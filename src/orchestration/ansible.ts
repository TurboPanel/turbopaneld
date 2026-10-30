import { verifyGalaxyPosixTarball } from "./galaxy-bundle.ts";
import { run, runLogged, runOrThrow, symlinkPointsAt } from "./exec.ts";
import { createSymlink } from "../permissions/scoped-writes.ts";
import {
  type AnsibleEventHandler,
  type AnsibleRawLineStream,
  AnsibleRunSummaryCollector,
  runPlaybookStreaming,
} from "./ansible-events.ts";
import {
  computeBootstrapStamp,
  galaxyCollectionsPresent,
  readBootstrapStamp,
  writeBootstrapStamp,
} from "./bootstrap-stamp.ts";
import {
  computeDevConvergeStamp,
  describeDevConvergeDecision,
  shouldSkipDevConverge,
  writeDevConvergeStamp,
} from "./converge-stamp.ts";
import {
  type DevConvergeOptions,
  devConvergeOptionsExtraArgs,
  resolveDevConvergeOptions,
} from "./dev-converge-options.ts";
import {
  mergeDevCertPublicUrls,
  readDevForwardHostsFile,
} from "./dev-forward-hosts.ts";
import { join } from "@std/path";
import { isValidHostname } from "../contracts/commands-contracts.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { readDockerNetworkingState } from "../deploy/docker-networking-state.ts";
import { logComponent } from "./presentation.ts";
import { withRetry } from "./retry.ts";
import {
  devOrchestrationAnsibleEnv,
  requireDevOrchestrationLayout,
} from "./dev-orchestration.ts";
import {
  ANSIBLE_CURRENT_DIR,
  ANSIBLE_INSTALL_DIR,
  ANSIBLE_LINT_BIN,
  ANSIBLE_PLAYBOOK_BIN,
  ANSIBLE_PLAYBOOK_CWD,
  ansibleEnv,
  ansibleHome,
  ansibleProbeEnv,
  BUILD_TOGGLE_PLAYBOOK,
  BUILDKIT_PLAYBOOK,
  CADDY_PLAYBOOK,
  DAEMON_CONVERGE_PLAYBOOK,
  DAEMON_LOGS_PLAYBOOK,
  DAEMON_SYSTEMD_PLAYBOOK,
  DOCKER_PLAYBOOK,
  GALAXY_COLLECTIONS_DIR,
  GALAXY_POSIX_TARBALL,
  LOCALHOST_PLAYBOOK,
  ORCHESTRATION_DIR,
  ORCHESTRATION_LAYOUT,
  ORCHESTRATOR_PLAYBOOK,
  POSTGRES_PLAYBOOK,
  PROXYSQL_PLAYBOOK,
  PYTHON_VERSION,
  RABBITMQ_PLAYBOOK,
  REDIS_PLAYBOOK,
  REQUIREMENTS_FILE,
  SET_HOSTNAME_PLAYBOOK,
  SOCKET_DIRS_PLAYBOOK,
  TIME_SYNC_APPLY_PLAYBOOK,
  UV_BIN,
  VENV_BIN_DIR,
  VENV_DIR,
} from "./assets.ts";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function ansiblePlaybookWorks(): Promise<boolean> {
  if (!(await fileExists(ANSIBLE_PLAYBOOK_BIN))) return false;
  // The daemon's bare env points HOME at the sealed state root; ansible then
  // fails creating ~/.ansible/tmp on a fresh install. Use the state leaf
  // (made tp-owned by daemon-layout); never mkdir here, this also runs as root.
  const result = await run(ANSIBLE_PLAYBOOK_BIN, ["--version"], {
    stream: false,
    env: ansibleProbeEnv(),
  });
  return result.success;
}

export async function ansibleLintWorks(): Promise<boolean> {
  if (!(await fileExists(ANSIBLE_LINT_BIN))) return false;
  const result = await run(ANSIBLE_LINT_BIN, ["--version"], {
    stream: false,
    env: ansibleProbeEnv(),
  });
  return result.success;
}

/** Point the stable `current` symlink at the active ansible venv directory. */
async function repointAnsibleCurrent(): Promise<void> {
  if (await symlinkPointsAt(ANSIBLE_CURRENT_DIR, ANSIBLE_INSTALL_DIR)) return;
  try {
    await Deno.remove(ANSIBLE_CURRENT_DIR);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn(
        "orchestration",
        "could not replace ansible current symlink:",
        err,
      );
      return;
    }
  }
  try {
    await createSymlink(ANSIBLE_INSTALL_DIR, ANSIBLE_CURRENT_DIR);
  } catch (err) {
    logWarn("orchestration", "could not create ansible current symlink:", err);
  }
}

export async function runLocalPlaybook(
  playbook: string,
  extraArgs: string[] = [],
  onEvent?: AnsibleEventHandler,
  env: Record<string, string> = ansibleEnv(),
  quiet = false,
  onRawLine?: (stream: AnsibleRawLineStream, line: string) => void,
): Promise<void> {
  const args = ["-i", "localhost,", "-c", "local", ...extraArgs, playbook];

  await runPlaybookStreaming(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd: ANSIBLE_PLAYBOOK_CWD,
    env,
    onEvent,
    quiet,
    onRawLine,
  });
}

/** Extra `-e` args for co-located dev ownership context (cert apply, converge, etc.). */
export function devOwnershipPlaybookExtraArgs(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string[] {
  const args: string[] = [];
  const devUser = env.TURBOPANEL_DEV_USER;
  const devUid = env.TURBOPANEL_DEV_UID;
  const devGid = env.TURBOPANEL_DEV_GID;
  const devRoot = env.TURBOPANEL_DEV_ROOT?.trim();
  if (devUser) args.push("-e", `turbopanel_dev_user=${devUser}`);
  if (devUid) args.push("-e", `turbopanel_dev_uid=${devUid}`);
  if (devGid) args.push("-e", `turbopanel_dev_gid=${devGid}`);
  // Ansible instance-certs defaults compute `<dev_root>/turbopanel` when
  // turbopanel_dev_user is set; pass the root so HOME/certs stay aligned.
  if (devRoot) args.push("-e", `turbopanel_dev_root=${devRoot}`);
  return args;
}

/**
 * Dev/runtime extra-vars shared by every co-located playbook. Optional-service
 * toggles come from the structured dev-converge options payload
 * ({@link resolveDevConvergeOptions}) — nothing here reads per-service flags.
 */
export function devInstanceExtraArgs(
  options: DevConvergeOptions = resolveDevConvergeOptions(),
): string[] {
  const uiMode = Deno.env.get("TURBOPANEL_UI_MODE") === "static"
    ? "static"
    : "dev";
  const instanceRunMode =
    Deno.env.get("TURBOPANEL_INSTANCE_RUN_MODE") === "compiled"
      ? "compiled"
      : "source";
  const instanceRuntime =
    Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers"
      ? "workers"
      : "deno";

  const publicUrls = mergeDevCertPublicUrls(
    Deno.env.get("TURBOPANEL_PUBLIC_URLS"),
    readDevForwardHostsFile(),
  );

  return [
    ...devOwnershipPlaybookExtraArgs(),
    "-e",
    `turbopanel_ui_mode=${uiMode}`,
    "-e",
    `turbopanel_instance_run_mode=${instanceRunMode}`,
    "-e",
    `turbopanel_instance_runtime=${instanceRuntime}`,
    ...devConvergeOptionsExtraArgs(options),
    ...(instanceRuntime === "workers"
      ? ["-e", "postgres_expose_port=true"]
      : []),
    ...(publicUrls ? ["-e", `turbopanel_public_urls=${publicUrls}`] : []),
  ];
}

async function installAnsiblePackages(): Promise<void> {
  logInfo("orchestration", `installing packages from ${REQUIREMENTS_FILE}`);
  await withRetry(
    () =>
      runOrThrow(UV_BIN, [
        "pip",
        "install",
        "--python",
        VENV_DIR,
        "--requirements",
        REQUIREMENTS_FILE,
      ]),
    { label: "install ansible packages from PyPI", attempts: 3 },
  );
}

async function verifyAnsibleInstall(): Promise<void> {
  if (!(await ansiblePlaybookWorks())) {
    throw new Error(
      "ansible install verification failed: ansible-playbook not runnable " +
        "(on Apple Silicon VMs, missing OPENSSL_armcap=0 usually means cryptography SIGILL)",
    );
  }
  if (!(await ansibleLintWorks())) {
    throw new Error(
      "ansible install verification failed: ansible-lint not runnable",
    );
  }
}

/**
 * Ensure the ansible virtualenv exists and the pinned packages are installed.
 *
 * Creates the venv with the managed Python, then installs from
 * `orchestration/requirements.txt`. Idempotent when `ansible-playbook` and
 * `ansible-lint` are runnable and bootstrap inputs are unchanged; re-runs pip
 * install when requirements change or ansible-lint is missing/broken.
 */
export async function ensureAnsible(): Promise<void> {
  const stamp = await computeBootstrapStamp();
  const previousStamp = await readBootstrapStamp();
  const requirementsChanged = previousStamp !== stamp;
  const playbookReady = await ansiblePlaybookWorks();
  const lintReady = await ansibleLintWorks();

  if (playbookReady && lintReady && !requirementsChanged) {
    logInfo("orchestration", "ansible already installed, skipping setup");
    await repointAnsibleCurrent();
    return;
  }

  if (!playbookReady) {
    logInfo("orchestration", `creating venv at ${VENV_DIR}`);
    // uv may need to fetch a managed Python interpreter here (UV_PYTHON_DOWNLOADS=automatic),
    // so this is a network operation too — retry the same transient blips as ensureUv().
    await withRetry(
      () => runOrThrow(UV_BIN, ["venv", "--python", PYTHON_VERSION, VENV_DIR]),
      { label: "create ansible venv", attempts: 3 },
    );
  }

  await installAnsiblePackages();
  await verifyAnsibleInstall();
  await repointAnsibleCurrent();
  logInfo("orchestration", "ansible installed");
}

/**
 * Cwd/env contract shared by ansible-galaxy bootstrap and ansible-playbook runs.
 *
 * Uses the checked-in `ansible.cfg` via {@link ansibleEnv} and a cwd outside the
 * daemon checkout so discovery does not depend on process cwd.
 */
export function galaxyBootstrapRunContext(): {
  cwd: string;
  env: Record<string, string>;
} {
  return {
    cwd: ANSIBLE_PLAYBOOK_CWD,
    env: ansibleEnv(),
  };
}

/**
 * Install the bundled Ansible Galaxy collection needed for every playbook run
 * (offline, from the tarball in the release package, after a digest check).
 *
 * Collections land in `runtimes/ansible/galaxy-collections/` (`ansible.posix`
 * for the JSONL callback and sysctl modules). Docker is installed by our own
 * `docker` role, not from Galaxy.
 */
export async function ensureGalaxyCollections(): Promise<void> {
  if (!(await ansiblePlaybookWorks())) {
    throw new Error(
      "ansible-galaxy requires a working ansible-playbook install",
    );
  }

  const stamp = await computeBootstrapStamp();
  const storedStamp = await readBootstrapStamp();
  if (storedStamp === stamp && await galaxyCollectionsPresent()) {
    logInfo("orchestration", "galaxy content up to date, skipping install");
    return;
  }

  const galaxyBin = join(VENV_BIN_DIR, "ansible-galaxy");
  const galaxyRun = galaxyBootstrapRunContext();
  ansibleHome();

  await verifyGalaxyPosixTarball();
  logInfo(
    "orchestration",
    `installing galaxy collections from ${GALAXY_POSIX_TARBALL}`,
  );
  await withRetry(
    () =>
      runLogged(
        galaxyBin,
        [
          "collection",
          "install",
          GALAXY_POSIX_TARBALL,
          "--offline",
          "-p",
          GALAXY_COLLECTIONS_DIR,
        ],
        {
          level: "INFO",
          component: logComponent("ansible-galaxy"),
          ...galaxyRun,
        },
      ),
    { label: "install galaxy collections", attempts: 3 },
  );
  logInfo("orchestration", "galaxy collections ready");
}

/**
 * Run the localhost smoke-test playbook to confirm the runtime is operational.
 */
export async function runLocalhostTest(
  onEvent?: AnsibleEventHandler,
  opts?: {
    quiet?: boolean;
    onRawLine?: (stream: AnsibleRawLineStream, line: string) => void;
  },
): Promise<void> {
  logInfo("orchestration", "running localhost smoke-test playbook");
  await runLocalPlaybook(
    LOCALHOST_PLAYBOOK,
    [],
    onEvent,
    undefined,
    opts?.quiet,
    opts?.onRawLine,
  );
  logInfo("orchestration", "localhost smoke-test passed");
}

/**
 * Single convergence playbook for daemon-only hosts (no co-located dev instance).
 */
export async function runDaemonConverge(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  const args = devInstanceExtraArgs();
  logInfo("orchestration", "running daemon-converge playbook");
  await runLocalPlaybook(DAEMON_CONVERGE_PLAYBOOK, args, onEvent);
  logInfo("orchestration", "daemon-converge complete");
}

/**
 * Create /run/turbopanel for TurboPanel Unix domain sockets and persist it
 * across reboots via systemd-tmpfiles.
 */
export async function runSocketDirsSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running socket-dirs-setup playbook");
  await runLocalPlaybook(SOCKET_DIRS_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "socket-dirs-setup complete");
}

/**
 * `-e` for set-hostname. The name reaches a root-run playbook as a key=value
 * extra-var, so it is held to RFC 1123 here as well as in tp-orchestrate.
 */
export function buildSetHostnameExtraArgs(hostname: string): string[] {
  if (!isValidHostname(hostname)) {
    throw new Error(`refusing host name ${JSON.stringify(hostname)}`);
  }
  return ["-e", `turbopanel_hostname=${hostname}`];
}

export async function runSetHostname(
  hostname: string,
  onEvent?: AnsibleEventHandler,
): Promise<{ summary: string }> {
  const extraArgs = buildSetHostnameExtraArgs(hostname);
  logInfo("orchestration", "running set-hostname playbook");
  const collector = new AnsibleRunSummaryCollector();
  const eventHandler: AnsibleEventHandler = (event) => {
    collector.handleEvent(event);
    onEvent?.(event);
  };
  try {
    await runLocalPlaybook(SET_HOSTNAME_PLAYBOOK, extraArgs, eventHandler);
  } catch {
    const summary = collector.build();
    throw new Error(
      summary.length > 0
        ? `set-hostname playbook failed: ${summary}`
        : "set-hostname playbook failed",
    );
  }
  logInfo("orchestration", "set-hostname complete");
  return { summary: collector.build() };
}

export type TimeSyncApplyOpts = {
  timezone?: string;
  ntpServers?: string[];
  ntpFallbackServers?: string[];
  ntpEnabled?: boolean;
};

type HostTimeSyncSnapshot = {
  ntpEnabled?: boolean;
  ntpServers: string[];
  fallbackNtpServers?: string[];
};

/**
 * Fill omitted NTP fields from the current host so partial command applies do
 * not fall back to Ansible role defaults (Debian pool + enabled=true).
 */
export function mergeTimeSyncApplyWithHostState(
  commandOpts: TimeSyncApplyOpts,
  host: HostTimeSyncSnapshot,
): TimeSyncApplyOpts {
  const merged: TimeSyncApplyOpts = { ...commandOpts };
  if (merged.ntpEnabled === undefined && host.ntpEnabled !== undefined) {
    merged.ntpEnabled = host.ntpEnabled;
  }
  merged.ntpServers ??= host.ntpServers;
  if (
    merged.ntpFallbackServers === undefined &&
    host.fallbackNtpServers !== undefined
  ) {
    merged.ntpFallbackServers = host.fallbackNtpServers;
  }
  return merged;
}

function timeSyncApplyIncludesNtpConfig(opts: TimeSyncApplyOpts): boolean {
  return (
    opts.ntpEnabled !== undefined ||
    opts.ntpServers !== undefined ||
    opts.ntpFallbackServers !== undefined
  );
}

/**
 * Build a single JSON `-e` object so lists/booleans stay native Ansible types
 * (key=value extra-vars are always strings).
 */
export function buildTimeSyncApplyExtraArgs(opts: TimeSyncApplyOpts): string[] {
  const extra: Record<string, unknown> = {};
  if (opts.timezone !== undefined) {
    extra.turbopanel_timezone = opts.timezone;
  }
  if (opts.ntpServers !== undefined) {
    extra.turbopanel_ntp_servers = opts.ntpServers;
  }
  if (opts.ntpFallbackServers !== undefined) {
    extra.turbopanel_ntp_fallback_servers = opts.ntpFallbackServers;
  }
  if (opts.ntpEnabled !== undefined) {
    extra.turbopanel_ntp_enabled = opts.ntpEnabled;
  }
  if (Object.keys(extra).length === 0) return [];
  extra.turbopanel_apply_ntp_config = timeSyncApplyIncludesNtpConfig(opts);
  return ["-e", JSON.stringify(extra)];
}

export async function runTimeSyncApply(
  opts: TimeSyncApplyOpts,
  onEvent?: AnsibleEventHandler,
): Promise<{ summary: string }> {
  logInfo("orchestration", "running time-sync-apply playbook");
  const collector = new AnsibleRunSummaryCollector();
  const eventHandler: AnsibleEventHandler = (event) => {
    collector.handleEvent(event);
    onEvent?.(event);
  };
  const args = buildTimeSyncApplyExtraArgs(opts);
  try {
    await runLocalPlaybook(TIME_SYNC_APPLY_PLAYBOOK, args, eventHandler);
  } catch {
    const summary = collector.build();
    throw new Error(
      summary.length > 0
        ? `time-sync-apply playbook failed: ${summary}`
        : "time-sync-apply playbook failed",
    );
  }
  logInfo("orchestration", "time-sync-apply complete");
  return { summary: collector.build() };
}

/**
 * Create /var/log/turbopanel/daemon.log and daemon.err.log for systemd append.
 */
export async function runDaemonLogsSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running daemon-logs-setup playbook");
  await runLocalPlaybook(DAEMON_LOGS_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "daemon-logs-setup complete");
}

export async function coLocatedInstanceServiceEnabled(): Promise<boolean> {
  try {
    const result = await run(
      "systemctl",
      ["is-enabled", "turbopanel-instance"],
      {
        stream: false,
      },
    );
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Install or reconcile turbopaneld.service (systemd). On co-located dev
 * hosts with turbopanel-instance.service, the unit is ordered after the
 * instance stack.
 */
export async function runDaemonSystemdSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  const afterInstance = await coLocatedInstanceServiceEnabled();
  logInfo(
    "orchestration",
    `running daemon-systemd-setup playbook (after_instance=${afterInstance})`,
  );
  const args = [
    "-i",
    "localhost,",
    "-c",
    "local",
    "-e",
    `turbopanel_after_instance_service=${afterInstance}`,
    DAEMON_SYSTEMD_PLAYBOOK,
  ];
  const cwd = ORCHESTRATION_DIR;

  await runPlaybookStreaming(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd,
    env: ansibleEnv(),
    onEvent,
  });
  logInfo("orchestration", "daemon-systemd-setup complete");
}

/**
 * Convergence playbook for the co-located self-hosted instance + UI + Caddy.
 */
export async function runInstanceDevInstall(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  const instanceEnabled = await coLocatedInstanceServiceEnabled();
  const options = resolveDevConvergeOptions();
  const convergeReason = await describeDevConvergeDecision(
    instanceEnabled,
    options,
  );
  if (await shouldSkipDevConverge(instanceEnabled, options)) {
    logInfo(
      "orchestration",
      `skipping instance-dev-install: ${convergeReason}`,
    );
    return;
  }

  const layout = await requireDevOrchestrationLayout();
  const args = devInstanceExtraArgs(options);
  logInfo(
    "orchestration",
    `running instance-dev-install converge playbook (${layout.playbookPath}): ${convergeReason}`,
  );
  await runLocalPlaybook(
    layout.playbookPath,
    args,
    onEvent,
    devOrchestrationAnsibleEnv(layout),
  );
  await writeDevConvergeStamp(await computeDevConvergeStamp(options));
  logInfo("orchestration", "instance-dev-install complete");
}

/** `-e` key=value extra-vars for instance-build-toggle. */
export function buildBuildToggleExtraArgs(
  opts: {
    uiMode: "dev" | "static";
    instanceRunMode: "source" | "compiled";
    forceBuild?: boolean;
  },
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string[] {
  const instanceRuntime = env.TURBOPANEL_INSTANCE_RUNTIME === "workers"
    ? "workers"
    : "deno";
  return [
    ...devOwnershipPlaybookExtraArgs(env),
    "-e",
    `turbopanel_ui_mode=${opts.uiMode}`,
    "-e",
    `turbopanel_instance_run_mode=${opts.instanceRunMode}`,
    "-e",
    `turbopanel_instance_runtime=${instanceRuntime}`,
    "-e",
    `force_build=${opts.forceBuild ?? false}`,
    "-e",
    `force_compile=${opts.forceBuild ?? false}`,
  ];
}

/**
 * Switch UI and instance run modes (dev/source ↔ static/compiled).
 */
export async function runBuildToggle(
  opts: {
    uiMode: "dev" | "static";
    instanceRunMode: "source" | "compiled";
    forceBuild?: boolean;
  },
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  const args = buildBuildToggleExtraArgs(opts);

  logInfo(
    "orchestration",
    `running instance-build-toggle playbook (ui=${opts.uiMode}, instance=${opts.instanceRunMode})`,
  );
  await runLocalPlaybook(BUILD_TOGGLE_PLAYBOOK, args, onEvent);
  logInfo("orchestration", "instance-build-toggle complete");
}

/**
 * Org-wide dockerd addressing the `docker` role merges into
 * `/etc/docker/daemon.json`. Mirrors the persisted descriptor
 * (`deploy/docker-networking-state.ts`).
 */
export type DockerSetupOpts = {
  addressPools?: ReadonlyArray<{ base: string; size: number }>;
  defaultBridgeCidr?: string | null;
  /**
   * Force the `daemon.json` merge even when both values are empty, so the
   * role strips `default-address-pools` / `bip` a previous apply wrote.
   * Set by `syncHostDockerNetworking` when an empty descriptor replaces a
   * non-empty persisted one; never for a fresh on-demand install.
   */
  clearAddressing?: boolean;
};

/**
 * `-e` JSON extra-vars for the docker role's `daemon.json` merge, built the
 * same way `runTimeSyncApply` passes its list/boolean vars — one JSON object
 * so `turbopanel_docker_address_pools` stays a list. Empty when there is
 * nothing to apply and nothing to clear, which keeps the role's
 * `daemon.json` task a strict no-op; `clearAddressing` alone emits
 * `turbopanel_docker_clear_addressing: true` so the role removes the keys.
 */
export function buildDockerSetupExtraArgs(opts: DockerSetupOpts): string[] {
  const extra: Record<string, unknown> = {};
  if (opts.addressPools && opts.addressPools.length > 0) {
    extra.turbopanel_docker_address_pools = opts.addressPools.map((pool) => ({
      base: pool.base,
      size: pool.size,
    }));
  }
  if (opts.defaultBridgeCidr) {
    extra.turbopanel_docker_default_bridge_cidr = opts.defaultBridgeCidr;
  }
  if (opts.clearAddressing) {
    extra.turbopanel_docker_clear_addressing = true;
  }
  if (Object.keys(extra).length === 0) return [];
  return ["-e", JSON.stringify(extra)];
}

/**
 * Install Docker and ensure turbopanel/dev users are in the docker group.
 * When `opts` is omitted the org Docker addressing is resolved from the
 * descriptor the daemon session persisted, so an on-demand install
 * (`ensureDocker`) lands with the right `default-address-pools` too.
 */
export async function runDockerSetup(
  opts?: DockerSetupOpts,
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  const resolved = opts ??
    (await readDockerNetworkingState(ORCHESTRATION_LAYOUT)) ?? {};
  logInfo("orchestration", "running docker-setup playbook");
  await runLocalPlaybook(
    DOCKER_PLAYBOOK,
    [...devInstanceExtraArgs(), ...buildDockerSetupExtraArgs(resolved)],
    onEvent,
  );
  logInfo("orchestration", "docker-setup complete");
}

/** Vendor the Caddy binary for public ingress (daemon-only hosts). */
export async function runCaddySetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running caddy-setup playbook");
  await runLocalPlaybook(CADDY_PLAYBOOK, devInstanceExtraArgs(), onEvent);
  logInfo("orchestration", "caddy-setup complete");
}

/**
 * Vendor the image builder and its BuildKit frontend for the image build lane.
 *
 * Called on demand from `ensureBuildkitImageBuild` when a deploy asks for
 * `build.kind: image`, never from `daemon-converge` or
 * `instance-dev-install`. The build runs on the Docker Engine's own BuildKit
 * and lands in its image store, so the playbook installs the container runtime
 * first (the `docker` role).
 */
export async function runBuildkitSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running buildkit-setup playbook");
  await runLocalPlaybook(BUILDKIT_PLAYBOOK, devInstanceExtraArgs(), onEvent);
  logInfo("orchestration", "buildkit-setup complete");
}

/** Run PostgreSQL 18 in Docker (daemon-only hosts). */
export async function runPostgresSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running postgres-setup playbook");
  await runLocalPlaybook(POSTGRES_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "postgres-setup complete");
}

/**
 * Host prerequisites for shared ProxySQL managed ingress (dirs, admin.cnf,
 * static base config, systemd unit). The managed Docker network is
 * per-organization and daemon-created, not an Ansible concern. Compose is
 * daemon-written later via managed.ingress.reconcile.
 */
export async function runProxySqlSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running proxysql-setup playbook");
  await runLocalPlaybook(PROXYSQL_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "proxysql-setup complete");
}

/**
 * Host prerequisites for per-org Orchestrator (dirs, API/raft secrets,
 * systemd unit). The managed Docker network is per-organization and
 * daemon-created, not an Ansible concern. Compose is daemon-written later via
 * managed.ha.reconcile.
 */
export async function runOrchestratorSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running orchestrator-setup playbook");
  await runLocalPlaybook(ORCHESTRATOR_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "orchestrator-setup complete");
}

/** Build and install Redis under runtimes/redis/current. */
export async function runRedisSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running redis-setup playbook");
  await runLocalPlaybook(REDIS_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "redis-setup complete");
}

/** Run RabbitMQ 4 with management plugin in Docker. */
export async function runRabbitmqSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  logInfo("orchestration", "running rabbitmq-setup playbook");
  await runLocalPlaybook(RABBITMQ_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "rabbitmq-setup complete");
}

/**
 * Bootstrap orchestration runtime tools (uv, Python, ansible, Galaxy collections).
 *
 * Docker is not installed here; the `docker` role installs it when a host first
 * needs a container workload.
 * Runs the localhost smoke test only when bootstrap inputs changed or ansible
 * was freshly installed. Writes the bootstrap stamp on success, and only when
 * it changed: on a managed host the root-run install (`run.sh` →
 * `bootstrap-orchestration`) wrote it into the root-owned vendor tree, and the
 * daemon runs this again at every start as `tp`, which cannot write there.
 */
export async function bootstrapOrchestrationRuntime(): Promise<void> {
  const stamp = await computeBootstrapStamp();
  const previousStamp = await readBootstrapStamp();
  const bootstrapInputsChanged = previousStamp !== stamp;
  const ansibleWasReady = await ansiblePlaybookWorks();

  await ensureAnsible();
  const ansibleReinstalled = !ansibleWasReady;

  await ensureGalaxyCollections();

  if (bootstrapInputsChanged || ansibleReinstalled) {
    await runLocalhostTest();
  } else {
    logInfo(
      "orchestration",
      "bootstrap inputs unchanged, skipping localhost smoke-test",
    );
  }

  if (bootstrapInputsChanged) await writeBootstrapStamp(stamp);
}
