import { run, runLogged, runOrThrow } from "./exec.ts";
import {
  type AnsibleEventHandler,
  type AnsibleRawLineStream,
  AnsibleRunSummaryCollector,
  runPlaybookStreaming,
} from "./ansible-events.ts";
import {
  computeBootstrapStamp,
  computeGalaxyDockerStamp,
  galaxyCollectionsPresent,
  galaxyDockerRolePresent,
  readBootstrapStamp,
  readGalaxyDockerStamp,
  writeBootstrapStamp,
  writeGalaxyDockerStamp,
} from "./bootstrap-stamp.ts";
import {
  computeDevConvergeStamp,
  describeDevConvergeDecision,
  shouldSkipDevConverge,
  writeDevConvergeStamp,
} from "./converge-stamp.ts";
import { join } from "@std/path";
import { logInfo, logWarn } from "../logger.ts";
import { logComponent } from "./presentation.ts";
import { withRetry } from "./retry.ts";
import {
  devOrchestrationAnsibleEnv,
  requireDevOrchestrationLayout,
} from "./dev-orchestration.ts";
import {
  ANSIBLE_CURRENT_DIR,
  ANSIBLE_HOME,
  ANSIBLE_INSTALL_DIR,
  ANSIBLE_LINT_BIN,
  ANSIBLE_PLAYBOOK_BIN,
  ANSIBLE_PLAYBOOK_CWD,
  ansibleEnv,
  BUILD_TOGGLE_PLAYBOOK,
  CADDY_PLAYBOOK,
  DAEMON_CONVERGE_PLAYBOOK,
  DAEMON_LOGS_PLAYBOOK,
  DAEMON_SYSTEMD_PLAYBOOK,
  DOCKER_PLAYBOOK,
  GALAXY_COLLECTIONS_DIR,
  GALAXY_DOCKER_REQUIREMENTS_FILE,
  GALAXY_REQUIREMENTS_FILE,
  GALAXY_ROLES_DIR,
  LOCALHOST_PLAYBOOK,
  ORCHESTRATION_DIR,
  POSTGRES_PLAYBOOK,
  PYTHON_VERSION,
  RABBITMQ_PLAYBOOK,
  REDIS_PLAYBOOK,
  REQUIREMENTS_FILE,
  SET_HOSTNAME_PLAYBOOK,
  SOCKET_DIRS_PLAYBOOK,
  TIME_SYNC_APPLY_PLAYBOOK,
  WIREGUARD_APPLY_PLAYBOOK,
  UV_BIN,
  VENV_BIN_DIR,
  VENV_DIR,
} from "./paths.ts";

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
  const result = await run(ANSIBLE_PLAYBOOK_BIN, ["--version"], {
    stream: false,
  });
  return result.success;
}

export async function ansibleLintWorks(): Promise<boolean> {
  if (!(await fileExists(ANSIBLE_LINT_BIN))) return false;
  const result = await run(ANSIBLE_LINT_BIN, ["--version"], {
    stream: false,
  });
  return result.success;
}

/** Point the stable `current` symlink at the active ansible venv directory. */
async function repointAnsibleCurrent(): Promise<void> {
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
    await Deno.symlink(ANSIBLE_INSTALL_DIR, ANSIBLE_CURRENT_DIR, {
      type: "dir",
    });
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
  if (devUser) args.push("-e", `turbopanel_dev_user=${devUser}`);
  if (devUid) args.push("-e", `turbopanel_dev_uid=${devUid}`);
  if (devGid) args.push("-e", `turbopanel_dev_gid=${devGid}`);
  return args;
}

function devInstanceExtraArgs(): string[] {
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

  const publicUrls = Deno.env.get("TURBOPANEL_PUBLIC_URLS");

  return [
    ...devOwnershipPlaybookExtraArgs(),
    "-e",
    `turbopanel_ui_mode=${uiMode}`,
    "-e",
    `turbopanel_instance_run_mode=${instanceRunMode}`,
    "-e",
    `turbopanel_instance_runtime=${instanceRuntime}`,
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
      "ansible install verification failed: ansible-playbook not runnable",
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
 * Install pinned Ansible Galaxy collections needed for every playbook run.
 *
 * Collections land in `runtimes/ansible/galaxy-collections/` (`ansible.posix`
 * for the JSONL callback and sysctl modules). Docker Galaxy roles are deferred
 * to {@link ensureGalaxyDockerRole} — they are not part of bootstrap.
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
  await Deno.mkdir(ANSIBLE_HOME, { recursive: true });

  logInfo(
    "orchestration",
    `installing galaxy collections from ${GALAXY_REQUIREMENTS_FILE}`,
  );
  await withRetry(
    () =>
      runLogged(
        galaxyBin,
        [
          "collection",
          "install",
          "-r",
          GALAXY_REQUIREMENTS_FILE,
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
 * Replace the Galaxy role's shipped `.ansible-lint` so IDE/CLI lint against an
 * open file under `geerlingguy.docker/` does not use upstream rules. The role
 * is third-party (gitignored); project configs already exclude the tree from
 * discovery, but ansible-lint still lints an explicitly opened path and walks
 * up to this nested config.
 */
async function neutralizeGalaxyDockerLintConfig(): Promise<void> {
  const roleDir = join(GALAXY_ROLES_DIR, "geerlingguy.docker");
  if (!(await galaxyDockerRolePresent())) {
    return;
  }
  await Deno.writeTextFile(
    join(roleDir, ".ansible-lint"),
    `# Written by TurboPanel ensureGalaxyDockerRole after ansible-galaxy install.
# Third-party Galaxy role — do not lint or edit this tree.
offline: true
skip_list:
  - command-instead-of-module
  - experimental
  - fqcn
  - galaxy
  - jinja
  - key-order
  - literal-compare
  - name
  - no-handler
  - package-latest
  - partial-become
  - risky-file-permissions
  - risky-shell-pipe
  - role-name
  - run-once
  - schema
  - var-naming
  - yaml
`,
  );
}

/**
 * Install the pinned geerlingguy.docker Galaxy role when a host needs Docker.
 *
 * Called from docker-using entry points (`runDockerSetup`, co-located dev
 * converge, postgres/rabbitmq setup) — never from orchestration bootstrap —
 * so daemon install skips this download until a container workload appears.
 */
export async function ensureGalaxyDockerRole(): Promise<void> {
  if (!(await ansiblePlaybookWorks())) {
    throw new Error(
      "ansible-galaxy requires a working ansible-playbook install",
    );
  }

  const stamp = await computeGalaxyDockerStamp();
  const storedStamp = await readGalaxyDockerStamp();
  if (storedStamp === stamp && await galaxyDockerRolePresent()) {
    logInfo(
      "orchestration",
      "galaxy docker role up to date, skipping install",
    );
    await neutralizeGalaxyDockerLintConfig();
    return;
  }

  const galaxyBin = join(VENV_BIN_DIR, "ansible-galaxy");
  const galaxyRun = galaxyBootstrapRunContext();
  await Deno.mkdir(ANSIBLE_HOME, { recursive: true });

  logInfo(
    "orchestration",
    `installing galaxy docker role from ${GALAXY_DOCKER_REQUIREMENTS_FILE}`,
  );
  await withRetry(
    () =>
      runLogged(
        galaxyBin,
        [
          "role",
          "install",
          "-r",
          GALAXY_DOCKER_REQUIREMENTS_FILE,
          "-p",
          GALAXY_ROLES_DIR,
        ],
        {
          level: "INFO",
          component: logComponent("ansible-galaxy"),
          ...galaxyRun,
        },
      ),
    { label: "install galaxy docker role", attempts: 3 },
  );
  logInfo("orchestration", "galaxy docker role ready");
  await neutralizeGalaxyDockerLintConfig();
  await writeGalaxyDockerStamp(stamp);
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

export async function runSetHostname(
  hostname: string,
  onEvent?: AnsibleEventHandler,
): Promise<{ summary: string }> {
  logInfo("orchestration", "running set-hostname playbook");
  const collector = new AnsibleRunSummaryCollector();
  const eventHandler: AnsibleEventHandler = (event) => {
    collector.handleEvent(event);
    onEvent?.(event);
  };
  try {
    await runLocalPlaybook(
      SET_HOSTNAME_PLAYBOOK,
      ["-e", `turbopanel_hostname=${hostname}`],
      eventHandler,
    );
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

export type WireguardApplyPeerOpts = {
  publicKey: string;
  allowedIps: string[];
  endpoint?: string;
  persistentKeepalive?: number;
  /** Path to a mode-0600 file containing the plaintext PSK — never pass plaintext via -e. */
  presharedKeyFile?: string;
};

export type WireguardApplyOpts = {
  interfaceName: string;
  address: string;
  privateKeyFile: string;
  listenPort?: number;
  peers: WireguardApplyPeerOpts[];
  configure?: boolean;
  /**
   * Desired host-wide sysctl forwarding state — the OR across every managed
   * WireGuard interface on this host, computed by the daemon (never just
   * this one interface's own gateway role). Only meaningful alongside
   * `manageForwarding: true`.
   */
  enableIpForwarding?: boolean;
  /**
   * When true, reconcile `net.ipv4.ip_forward` / `net.ipv6.conf.all.forwarding`
   * to match `enableIpForwarding` on this run. Bootstrap/tools-only runs must
   * omit this (leave current sysctl state untouched) since they have no
   * host-wide interface knowledge.
   */
  manageForwarding?: boolean;
};

export function buildWireguardApplyExtraArgs(opts: WireguardApplyOpts): string[] {
  const extra: Record<string, unknown> = {
    wireguard_interface: opts.interfaceName,
    wireguard_address: opts.address,
    wireguard_private_key_file: opts.privateKeyFile,
    wireguard_peers: opts.peers,
    wireguard_configure: opts.configure !== false,
    wireguard_ip_forward: opts.enableIpForwarding === true,
    wireguard_manage_forwarding: opts.manageForwarding === true,
  };
  if (opts.listenPort !== undefined) {
    // Stringify so Jinja length/emptiness checks work (numeric | length fails).
    extra.wireguard_listen_port = String(opts.listenPort);
  }
  return ["-e", JSON.stringify(extra)];
}

export async function runWireguardApply(
  opts: WireguardApplyOpts,
  onEvent?: AnsibleEventHandler,
): Promise<{ summary: string }> {
  logInfo("orchestration", "running wireguard-apply playbook");
  const collector = new AnsibleRunSummaryCollector();
  const eventHandler: AnsibleEventHandler = (event) => {
    collector.handleEvent(event);
    onEvent?.(event);
  };
  const args = buildWireguardApplyExtraArgs(opts);
  try {
    await runLocalPlaybook(WIREGUARD_APPLY_PLAYBOOK, args, eventHandler);
  } catch {
    const summary = collector.build();
    throw new Error(
      summary.length > 0
        ? `wireguard-apply playbook failed: ${summary}`
        : "wireguard-apply playbook failed",
    );
  }
  logInfo("orchestration", "wireguard-apply complete");
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

async function coLocatedInstanceServiceEnabled(): Promise<boolean> {
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
  const convergeReason = await describeDevConvergeDecision(instanceEnabled);
  if (await shouldSkipDevConverge(instanceEnabled)) {
    logInfo(
      "orchestration",
      `skipping instance-dev-install: ${convergeReason}`,
    );
    return;
  }

  const layout = await requireDevOrchestrationLayout();
  const args = devInstanceExtraArgs();
  // Dev converge pulls Docker (postgres/redis/rabbitmq/clickhouse/…); fetch the
  // Galaxy docker role only now, not during orchestration bootstrap.
  await ensureGalaxyDockerRole();
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
  await writeDevConvergeStamp(await computeDevConvergeStamp());
  logInfo("orchestration", "instance-dev-install complete");
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
  const instanceRuntime =
    Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers"
      ? "workers"
      : "deno";

  const args = [
    ...devOwnershipPlaybookExtraArgs(),
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

  logInfo(
    "orchestration",
    `running instance-build-toggle playbook (ui=${opts.uiMode}, instance=${opts.instanceRunMode})`,
  );
  await runLocalPlaybook(BUILD_TOGGLE_PLAYBOOK, args, onEvent);
  logInfo("orchestration", "instance-build-toggle complete");
}

/** Install Docker and ensure turbopanel/dev users are in the docker group. */
export async function runDockerSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  await ensureGalaxyDockerRole();
  logInfo("orchestration", "running docker-setup playbook");
  await runLocalPlaybook(DOCKER_PLAYBOOK, devInstanceExtraArgs(), onEvent);
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

/** Run PostgreSQL 18 in Docker (daemon-only hosts). */
export async function runPostgresSetup(
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  await ensureGalaxyDockerRole();
  logInfo("orchestration", "running postgres-setup playbook");
  await runLocalPlaybook(POSTGRES_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "postgres-setup complete");
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
  await ensureGalaxyDockerRole();
  logInfo("orchestration", "running rabbitmq-setup playbook");
  await runLocalPlaybook(RABBITMQ_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "rabbitmq-setup complete");
}

/**
 * ClickHouse setup is deferred: co-located dev installs it via the
 * dev-converge-manifest.json role list (same as postgres/redis/rabbitmq).
 * There is no discrete runClickHouseSetup() step here unless a managed
 * daemon-only-host use case is confirmed — use CLICKHOUSE_PLAYBOOK /
 * playbooks/clickhouse-setup.yml for that future path.
 */

/**
 * Bootstrap orchestration runtime tools (uv, Python, ansible, Galaxy collections).
 *
 * Docker Galaxy roles are not installed here — see {@link ensureGalaxyDockerRole}.
 * Runs the localhost smoke test only when bootstrap inputs changed or ansible
 * was freshly installed. Writes the bootstrap stamp on success.
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

  await writeBootstrapStamp(stamp);
}
