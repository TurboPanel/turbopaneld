#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env --allow-write --allow-net
/**
 * Runs daemon orchestration playbooks (invoked via `deno run` under sudo from the
 * dev console). Emits Ansible JSONL events on stdout — one JSON object per line.
 *
 * Location-agnostic: this script lives inside the daemon checkout
 * (`<checkout>/scripts/`) and resolves every path through the daemon's own
 * layout-aware modules (`src/orchestration/paths.ts`, `src/paths/layout.ts`). It
 * therefore works whether the checkout is the co-located dev tree under the dev
 * user's home (`<home>/turbopaneld`) or the FHS install root — it never names a
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
 * role (dev converge, docker/postgres/rabbitmq setup). Same gate as
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
  type DevOrchestrationLayout,
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
export const PLAYBOOKS_NEEDING_DOCKER_GALAXY = new Set([
  "docker-setup.yml",
  "postgres-setup.yml",
  "rabbitmq-setup.yml",
]);

/**
 * FHS daemon env file — the same `/etc/turbopanel/daemon.env` the dev console
 * writes and the source-mode `turbopaneld.service` consumes via `EnvironmentFile`.
 * Read here to hoist runtime toggles the console does not set directly in the
 * process env (`TURBOPANEL_UI_MODE`, `TURBOPANEL_INSTANCE_RUN_MODE`,
 * `TURBOPANEL_INSTANCE_RUNTIME`). Dev-identity vars come pre-set from the console.
 */
export function resolveDaemonEnvPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(
    resolveLayout({
      TURBOPANEL_CONFIG_DIR: env.TURBOPANEL_CONFIG_DIR ??
        readEnv("TURBOPANEL_CONFIG_DIR"),
      TURBOPANEL_DAEMON_ROOT: env.TURBOPANEL_DAEMON_ROOT ??
        readEnv("TURBOPANEL_DAEMON_ROOT"),
    }).configDir,
    "daemon.env",
  );
}

const SSH_REPO_URLS = {
  instance: "git@github.com:TurboPanel/turbopanel.git",
  ui: "git@github.com:TurboPanel/ui.git",
  website: "git@github.com:TurboPanel/website.git",
  github: "git@github.com:TurboPanel/.github.git",
  daemon: "git@github.com:TurboPanel/turbopaneld.git",
} as const;

/**
 * Hoist unset keys from `daemon.env` into the process env so playbook extra-vars
 * see the same runtime toggles as a systemd-started daemon.
 */
export function applyDaemonEnvToProcess(
  envPath: string = resolveDaemonEnvPath(),
): void {
  let content = "";
  try {
    content = Deno.readTextFileSync(envPath);
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

/**
 * Drop bulky host payloads (especially `ansible_facts` from Gathering Facts)
 * before writing JSONL for the TUI. Full facts can be 100KB+ per event and
 * stall Ink while the console JSON.parses them on the main thread.
 */
export function slimAnsibleEvent(event: unknown): unknown {
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

export function emitEvent(event: unknown): void {
  console.log(JSON.stringify(slimAnsibleEvent(event)));
}

function usage(): never {
  console.error(
    "Usage: run-orchestration-action.ts <instance-dev-install|build-toggle|playbook> [args…]",
  );
  Deno.exit(2);
}

export function optionalDevServiceFlag(
  envKey: string,
  defaultValue: boolean,
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  const raw = env.get(envKey)?.trim().toLowerCase();
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

export function optionalDevServiceExtraArgs(
  env: { get(key: string): string | undefined } = Deno.env,
): string[] {
  return [
    "-e",
    `turbopanel_optional_dbstudio=${
      optionalDevServiceFlag("TURBOPANEL_OPTIONAL_DBSTUDIO", false, env)
    }`,
    "-e",
    `turbopanel_optional_ui=${
      optionalDevServiceFlag("TURBOPANEL_OPTIONAL_UI", true, env)
    }`,
    "-e",
    `turbopanel_optional_website=${
      optionalDevServiceFlag("TURBOPANEL_OPTIONAL_WEBSITE", true, env)
    }`,
    "-e",
    `turbopanel_optional_mailpit=${
      optionalDevServiceFlag("TURBOPANEL_OPTIONAL_MAILPIT", true, env)
    }`,
    "-e",
    `turbopanel_optional_redis_insight=${
      optionalDevServiceFlag("TURBOPANEL_OPTIONAL_REDIS_INSIGHT", false, env)
    }`,
  ];
}

export function devInstanceExtraArgs(
  env: {
    get(key: string): string | undefined;
    toObject(): { [index: string]: string };
  } = Deno.env,
): string[] {
  const devUser = env.get("TURBOPANEL_DEV_USER");
  const devUid = env.get("TURBOPANEL_DEV_UID");
  const devGid = env.get("TURBOPANEL_DEV_GID");
  const uiMode = env.get("TURBOPANEL_UI_MODE") === "static" ? "static" : "dev";
  const instanceRunMode = env.get("TURBOPANEL_INSTANCE_RUN_MODE") === "compiled"
    ? "compiled"
    : "source";
  const instanceRuntime = env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers"
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
    const devRoot = resolveDevRoot(env.toObject());
    args.push("-e", `turbopanel_dev_root=${devRoot}`);
  }
  args.push(
    "-e",
    `turbopanel_ui_mode=${uiMode}`,
    "-e",
    `turbopanel_instance_run_mode=${instanceRunMode}`,
    "-e",
    `turbopanel_instance_runtime=${instanceRuntime}`,
    ...optionalDevServiceExtraArgs(env),
  );
  if (instanceRuntime === "workers") {
    args.push("-e", "postgres_expose_port=true");
  }
  return args;
}

/** Injectable seams so tests can exercise dispatch without Ansible. */
export type OrchestrationActionDeps = {
  coLocatedInstanceServiceEnabled: () => Promise<boolean>;
  emitDevConvergeSkippedIfNeeded: typeof emitDevConvergeSkippedIfNeeded;
  requireDevOrchestrationLayout: () => Promise<DevOrchestrationLayout>;
  ensureAnsible: () => Promise<void>;
  ensureGalaxyDockerRole: () => Promise<void>;
  runPlaybookStreaming: typeof runPlaybookStreaming;
  writeDevConvergeStamp: typeof writeDevConvergeStamp;
  computeDevConvergeStamp: typeof computeDevConvergeStamp;
  runAnsibleBuildToggle: typeof runAnsibleBuildToggle;
  emit: (event: unknown) => void;
  orchestrationDir: string;
  ansiblePlaybookBin: string;
  ansiblePlaybookCwd: string;
};

function defaultDeps(): OrchestrationActionDeps {
  return {
    coLocatedInstanceServiceEnabled,
    emitDevConvergeSkippedIfNeeded,
    requireDevOrchestrationLayout,
    ensureAnsible,
    ensureGalaxyDockerRole,
    runPlaybookStreaming,
    writeDevConvergeStamp,
    computeDevConvergeStamp,
    runAnsibleBuildToggle,
    emit: emitEvent,
    orchestrationDir: ORCHESTRATION_DIR,
    ansiblePlaybookBin: ANSIBLE_PLAYBOOK_BIN,
    ansiblePlaybookCwd: ANSIBLE_PLAYBOOK_CWD,
  };
}

export async function runInstanceDevInstall(
  ifNeeded: boolean,
  deps: OrchestrationActionDeps = defaultDeps(),
): Promise<"skipped" | "ran"> {
  if (ifNeeded) {
    const instanceEnabled = await deps.coLocatedInstanceServiceEnabled();
    if (
      await deps.emitDevConvergeSkippedIfNeeded(
        true,
        instanceEnabled,
        deps.emit as (
          event: { _event: "dev_converge_skipped"; reason: string },
        ) => void,
      )
    ) {
      // Stamp matches — exit before ensureAnsible / Galaxy / playbook.
      return "skipped";
    }
  }

  const layout = await deps.requireDevOrchestrationLayout();

  // Sync orchestration venv packages (ansible-lint for IDE linting, etc.) before converge.
  await deps.ensureAnsible();
  // Dev converge always pulls Docker (postgres/redis/rabbitmq/…);
  // fetch the Galaxy docker role only now — not during orchestration bootstrap.
  await deps.ensureGalaxyDockerRole();

  await deps.runPlaybookStreaming(
    deps.ansiblePlaybookBin,
    [
      "-i",
      "localhost,",
      "-c",
      "local",
      ...devInstanceExtraArgs(),
      layout.playbookPath,
    ],
    {
      cwd: deps.ansiblePlaybookCwd,
      env: devOrchestrationAnsibleEnv(layout),
      // TUI consumes JSONL via onEvent only — suppress structured log lines on
      // stdout so they are not mixed with event payloads.
      quiet: true,
      onEvent: deps.emit,
    },
  );

  await deps.writeDevConvergeStamp(await deps.computeDevConvergeStamp());
  return "ran";
}

export async function runBuildToggle(
  rawOptions: string | undefined,
  deps: OrchestrationActionDeps = defaultDeps(),
): Promise<void> {
  if (!rawOptions) {
    throw new Error("build-toggle requires a JSON options argument");
  }
  const opts = JSON.parse(rawOptions) as {
    uiMode: "dev" | "static";
    instanceRunMode: "source" | "compiled";
    forceBuild?: boolean;
  };
  await deps.runAnsibleBuildToggle(opts, deps.emit);
}

export async function runPlaybook(
  playbookRelative: string | undefined,
  extraArgs: string[],
  deps: OrchestrationActionDeps = defaultDeps(),
): Promise<void> {
  if (!playbookRelative) {
    throw new Error("playbook requires a playbook path argument");
  }
  const playbook = join(
    deps.orchestrationDir,
    "playbooks",
    playbookRelative,
  );
  if (PLAYBOOKS_NEEDING_DOCKER_GALAXY.has(playbookRelative)) {
    await deps.ensureGalaxyDockerRole();
  }
  // Co-located dev playbooks need dev user + runtime context from the daemon env;
  // CLI extra-vars passed after dev defaults win on duplicate keys.
  await deps.runPlaybookStreaming(
    deps.ansiblePlaybookBin,
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
      cwd: deps.ansiblePlaybookCwd,
      env: ansibleEnv(),
      quiet: true,
      onEvent: deps.emit,
    },
  );
}

/**
 * Dispatch a CLI action without exiting the process. Unknown actions throw so
 * tests can assert; the CLI entry maps that to usage() / exit 2.
 */
export async function dispatchOrchestrationAction(
  action: string,
  args: string[],
  deps: OrchestrationActionDeps = defaultDeps(),
): Promise<"skipped" | "ran" | void> {
  switch (action) {
    case "instance-dev-install":
      return await runInstanceDevInstall(args.includes("--if-needed"), deps);
    case "build-toggle":
      await runBuildToggle(args[0], deps);
      return;
    case "playbook":
      await runPlaybook(args[0], args.slice(1), deps);
      return;
    default:
      throw new Error(`unknown orchestration action: ${action}`);
  }
}

if (import.meta.main) {
  applyDaemonEnvToProcess();

  const action = Deno.args[0];
  if (!action) {
    usage();
  }

  try {
    await dispatchOrchestrationAction(action, Deno.args.slice(1));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unknown orchestration action:")) {
      usage();
    }
    console.error(message);
    Deno.exit(1);
  }
}
