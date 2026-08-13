#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env --allow-write --allow-net
/**
 * Runs daemon orchestration playbooks (invoked via `deno run` under sudo from the
 * dev console). Emits Ansible JSONL events on stdout — one JSON object per line.
 *
 * Location-agnostic: this script lives inside the daemon checkout
 * (`<checkout>/scripts/`) and resolves every path through the daemon's own
 * layout-aware modules (`src/orchestration/paths.ts`, `src/paths/layout.ts`). It
 * therefore works whether the checkout is the co-located dev tree under the dev
 * user's home (`<home>/daemon`) or the FHS install root — it never names a
 * `/opt/turbopanel/platform` tree.
 *
 * Co-located dev converge (`instance-dev-install`) resolves the playbook + dev
 * overlay roles from `<dev checkout>/orchestration` ({@link dev-orchestration.ts}),
 * layering the daemon's shared production roles via `ANSIBLE_ROLES_PATH`
 * (see `devOrchestrationAnsibleEnv`). Daemon-only playbooks run from the daemon
 * checkout's own `orchestration/` dir.
 *
 * Docker Galaxy (`geerlingguy.docker`) is not part of bootstrap — call
 * {@link ensureGalaxyDockerRole} before any playbook that pulls in the docker
 * role (dev converge, docker/postgres/rabbitmq/clickhouse setup). Same gate as
 * production `runDockerSetup` / `runPostgresSetup` / `runRabbitmqSetup`.
 */
import { join } from "@std/path";
import { runPlaybookStreaming } from "../src/orchestration/ansible-events.ts";
import {
  coLocatedInstanceServiceEnabled,
  ensureAnsible,
  ensureGalaxyDockerRole,
  runBuildToggle as runAnsibleBuildToggle,
} from "../src/orchestration/ansible.ts";
import {
  computeDevConvergeStamp,
  emitDevConvergeSkippedIfNeeded,
  writeDevConvergeStamp,
} from "../src/orchestration/converge-stamp.ts";
import {
  devOrchestrationAnsibleEnv,
  requireDevOrchestrationLayout,
} from "../src/orchestration/dev-orchestration.ts";
import {
  ANSIBLE_PLAYBOOK_BIN,
  ANSIBLE_PLAYBOOK_CWD,
  ansibleEnv,
  ORCHESTRATION_DIR,
} from "../src/orchestration/paths.ts";
import { readEnv, resolveDevRoot, resolveLayout } from "../src/paths/layout.ts";

/** Playbooks that include the docker role (or a role with a docker meta-dep). */
const PLAYBOOKS_NEEDING_DOCKER_GALAXY = new Set([
  "docker-setup.yml",
  "postgres-setup.yml",
  "rabbitmq-setup.yml",
  "clickhouse-setup.yml",
]);

/**
 * FHS daemon env file — the same `/etc/turbopanel/daemon.env` the dev console
 * writes and the source-mode `turbopaneld.service` consumes via `EnvironmentFile`.
 * Read here to hoist runtime toggles the console does not set directly in the
 * process env (`TURBOPANEL_UI_MODE`, `TURBOPANEL_INSTANCE_RUN_MODE`,
 * `TURBOPANEL_INSTANCE_RUNTIME`). Dev-identity vars come pre-set from the console.
 */
const DAEMON_ENV_PATH = join(
  resolveLayout({
    TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
    TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
  }).configDir,
  "daemon.env",
);

const SSH_REPO_URLS = {
  instance: "git@github.com:turbopanel/turbopanel.git",
  ui: "git@github.com:turbopanel/ui.git",
  website: "git@github.com:turbopanel/website.git",
  github: "git@github.com:turbopanel/.github.git",
  daemon: "git@github.com:turbopanel/turbopaneld.git",
} as const;

function applyDaemonEnvToProcess(): void {
  let content = "";
  try {
    content = Deno.readTextFileSync(DAEMON_ENV_PATH);
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match && !Deno.env.has(match[1])) {
      Deno.env.set(match[1], match[2]);
    }
  }
}

applyDaemonEnvToProcess();

/**
 * Drop bulky host payloads (especially `ansible_facts` from Gathering Facts)
 * before writing JSONL for the TUI. Full facts can be 100KB+ per event and
 * stall Ink while the console JSON.parses them on the main thread.
 */
function slimAnsibleEvent(event: unknown): unknown {
  if (typeof event !== "object" || event === null) {
    return event;
  }
  const record = event as Record<string, unknown>;
  const hosts = record.hosts;
  if (typeof hosts !== "object" || hosts === null) {
    return event;
  }
  const slimHosts: Record<string, unknown> = {};
  for (
    const [host, result] of Object.entries(hosts as Record<string, unknown>)
  ) {
    if (typeof result !== "object" || result === null) {
      slimHosts[host] = result;
      continue;
    }
    const body = result as Record<string, unknown>;
    slimHosts[host] = {
      action: body.action,
      changed: body.changed,
      failed: body.failed,
      skipped: body.skipped,
      unreachable: body.unreachable,
      msg: body.msg,
    };
  }
  return { ...record, hosts: slimHosts };
}

function emitEvent(event: unknown): void {
  console.log(JSON.stringify(slimAnsibleEvent(event)));
}

function usage(): never {
  console.error(
    "Usage: run-orchestration-action.ts <instance-dev-install|build-toggle|playbook> [args…]",
  );
  Deno.exit(2);
}

function optionalDevServiceFlag(
  envKey: string,
  defaultValue: boolean,
): boolean {
  const raw = Deno.env.get(envKey)?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }
  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }
  return defaultValue;
}

function optionalDevServiceExtraArgs(): string[] {
  return [
    "-e",
    `turbopanel_optional_dbstudio=${optionalDevServiceFlag("TURBOPANEL_OPTIONAL_DBSTUDIO", false)}`,
    "-e",
    `turbopanel_optional_ui=${optionalDevServiceFlag("TURBOPANEL_OPTIONAL_UI", true)}`,
    "-e",
    `turbopanel_optional_website=${optionalDevServiceFlag("TURBOPANEL_OPTIONAL_WEBSITE", true)}`,
    "-e",
    `turbopanel_optional_mailpit=${optionalDevServiceFlag("TURBOPANEL_OPTIONAL_MAILPIT", true)}`,
    "-e",
    `turbopanel_optional_redis_insight=${optionalDevServiceFlag("TURBOPANEL_OPTIONAL_REDIS_INSIGHT", false)}`,
    "-e",
    `turbopanel_optional_tabix=${optionalDevServiceFlag("TURBOPANEL_OPTIONAL_TABIX", false)}`,
  ];
}

function devInstanceExtraArgs(): string[] {
  const devUser = Deno.env.get("TURBOPANEL_DEV_USER");
  const devUid = Deno.env.get("TURBOPANEL_DEV_UID");
  const devGid = Deno.env.get("TURBOPANEL_DEV_GID");
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

  const args: string[] = [
    "-e",
    `instance_repo_url=${SSH_REPO_URLS.instance}`,
    "-e",
    `ui_repo_url=${SSH_REPO_URLS.ui}`,
    "-e",
    `website_repo_url=${SSH_REPO_URLS.website}`,
    "-e",
    `github_repo_url=${SSH_REPO_URLS.github}`,
  ];
  if (devUser) args.push("-e", `turbopanel_dev_user=${devUser}`);
  if (devUid) args.push("-e", `turbopanel_dev_uid=${devUid}`);
  if (devGid) args.push("-e", `turbopanel_dev_gid=${devGid}`);
  if (devUser) {
    const devRoot = resolveDevRoot(Deno.env.toObject());
    args.push("-e", `turbopanel_dev_root=${devRoot}`);
  }
  args.push(
    "-e",
    `turbopanel_ui_mode=${uiMode}`,
    "-e",
    `turbopanel_instance_run_mode=${instanceRunMode}`,
    "-e",
    `turbopanel_instance_runtime=${instanceRuntime}`,
    ...optionalDevServiceExtraArgs(),
  );
  if (instanceRuntime === "workers") {
    args.push("-e", "postgres_expose_port=true");
  }
  return args;
}

async function runInstanceDevInstall(ifNeeded: boolean): Promise<void> {
  if (ifNeeded) {
    const instanceEnabled = await coLocatedInstanceServiceEnabled();
    if (
      await emitDevConvergeSkippedIfNeeded(
        true,
        instanceEnabled,
        emitEvent,
      )
    ) {
      // Stamp matches — exit before ensureAnsible / Galaxy / playbook.
      return;
    }
  }

  const layout = await requireDevOrchestrationLayout();

  // Sync orchestration venv packages (ansible-lint for IDE linting, etc.) before converge.
  await ensureAnsible();
  // Dev converge always pulls Docker (postgres/redis/rabbitmq/clickhouse/…);
  // fetch the Galaxy docker role only now — not during orchestration bootstrap.
  await ensureGalaxyDockerRole();

  await runPlaybookStreaming(
    ANSIBLE_PLAYBOOK_BIN,
    [
      "-i",
      "localhost,",
      "-c",
      "local",
      ...devInstanceExtraArgs(),
      layout.playbookPath,
    ],
    {
      cwd: ANSIBLE_PLAYBOOK_CWD,
      env: devOrchestrationAnsibleEnv(layout),
      // TUI consumes JSONL via onEvent only — suppress structured log lines on
      // stdout so they are not mixed with event payloads.
      quiet: true,
      onEvent: emitEvent,
    },
  );

  await writeDevConvergeStamp(await computeDevConvergeStamp());
}

async function runBuildToggle(): Promise<void> {
  const raw = Deno.args[1];
  if (!raw) {
    throw new Error("build-toggle requires a JSON options argument");
  }
  const opts = JSON.parse(raw) as {
    uiMode: "dev" | "static";
    instanceRunMode: "source" | "compiled";
    forceBuild?: boolean;
  };
  await runAnsibleBuildToggle(opts, emitEvent);
}

async function runPlaybook(): Promise<void> {
  const playbookRelative = Deno.args[1];
  if (!playbookRelative) {
    throw new Error("playbook requires a playbook path argument");
  }
  const extraArgs = Deno.args.slice(2);
  const playbook = join(ORCHESTRATION_DIR, "playbooks", playbookRelative);
  if (PLAYBOOKS_NEEDING_DOCKER_GALAXY.has(playbookRelative)) {
    await ensureGalaxyDockerRole();
  }
  // Co-located dev playbooks need dev user + runtime context from the daemon env;
  // CLI extra-vars passed after dev defaults win on duplicate keys.
  await runPlaybookStreaming(
    ANSIBLE_PLAYBOOK_BIN,
    [
      "-i",
      "localhost,",
      "-c",
      "local",
      ...devInstanceExtraArgs(),
      ...extraArgs,
      playbook,
    ],
    {
      cwd: ANSIBLE_PLAYBOOK_CWD,
      env: ansibleEnv(),
      quiet: true,
      onEvent: emitEvent,
    },
  );
}

const action = Deno.args[0];
if (!action) {
  usage();
}

try {
  switch (action) {
    case "instance-dev-install":
      await runInstanceDevInstall(Deno.args.includes("--if-needed"));
      break;
    case "build-toggle":
      await runBuildToggle();
      break;
    case "playbook":
      await runPlaybook();
      break;
    default:
      usage();
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  Deno.exit(1);
}
