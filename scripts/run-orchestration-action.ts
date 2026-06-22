#!/usr/bin/env -S deno run --config=/opt/turbopanel/platform/daemon/deno.json --allow-read --allow-run --allow-env --allow-write
/**
 * Runs daemon orchestration playbooks as turbopanel (invoked via sudo from the console).
 * Emits Ansible JSONL events on stdout — one JSON object per line.
 *
 * Co-located dev converge resolves playbooks from the staged turbopanel-dev
 * orchestration tree; daemon-only playbooks continue to use the daemon checkout.
 */
const TURBOPANEL_ROOT = "/opt/turbopanel";
/** Run playbooks outside daemon checkout so git as turbopanel does not walk into dev-owned .git */
const ANSIBLE_PLAYBOOK_CWD = TURBOPANEL_ROOT;
const TURBOPANEL_PLATFORM = `${TURBOPANEL_ROOT}/platform`;
const RUNTIMES_DIR = `${TURBOPANEL_ROOT}/runtimes`;
const ANSIBLE_PLAYBOOK_BIN =
  `${RUNTIMES_DIR}/ansible/current/bin/ansible-playbook`;
const DAEMON_ENV_PATH = `${TURBOPANEL_PLATFORM}/daemon/.env`;

const SSH_REPO_URLS = {
  instance: "git@github.com:turbopanel/turbopanel.git",
  ui: "git@github.com:turbopanel/turbopanel-ui.git",
  website: "git@github.com:turbopanel/turbopanel-website.git",
  daemon: "git@github.com:turbopanel/turbopanel-daemon.git",
} as const;

const DAEMON_ANSIBLE_EVENTS_PATH =
  `${TURBOPANEL_PLATFORM}/daemon/src/orchestration/ansible-events.ts`;
const DAEMON_ANSIBLE_PATH =
  `${TURBOPANEL_PLATFORM}/daemon/src/orchestration/ansible.ts`;
const DAEMON_CONVERGE_STAMP_PATH =
  `${TURBOPANEL_PLATFORM}/daemon/src/orchestration/converge-stamp.ts`;
const DAEMON_DEV_ORCHESTRATION_PATH =
  `${TURBOPANEL_PLATFORM}/daemon/src/orchestration/dev-orchestration.ts`;
const DAEMON_ORCHESTRATION_DIR =
  `${TURBOPANEL_PLATFORM}/daemon/orchestration`;

function applyDaemonEnvToProcess(): void {
  let content = "";
  try {
    content = Deno.readTextFileSync(DAEMON_ENV_PATH);
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !Deno.env.has(match[1])) {
      Deno.env.set(match[1], match[2]);
    }
  }
}

applyDaemonEnvToProcess();

function daemonAnsibleEnv(): Record<string, string> {
  return {
    ANSIBLE_CONFIG: `${DAEMON_ORCHESTRATION_DIR}/ansible.cfg`,
    ANSIBLE_LOCAL_TEMP: `${RUNTIMES_DIR}/uv/cache/ansible-tmp`,
    ANSIBLE_COLLECTIONS_PATH: `${RUNTIMES_DIR}/ansible/galaxy-collections`,
  };
}

function emitEvent(event: unknown): void {
  console.log(JSON.stringify(event));
}

function usage(): never {
  console.error(
    "Usage: run-orchestration-action.ts <instance-dev-install|build-toggle|playbook> [args…]",
  );
  Deno.exit(2);
}

function devInstanceExtraArgs(): string[] {
  const devUser = Deno.env.get("TURBOPANEL_DEV_USER");
  const devUid = Deno.env.get("TURBOPANEL_DEV_UID");
  const devGid = Deno.env.get("TURBOPANEL_DEV_GID");
  const uiMode = Deno.env.get("TURBOPANEL_UI_MODE") === "static" ? "static" : "dev";
  const instanceRunMode = Deno.env.get("TURBOPANEL_INSTANCE_RUN_MODE") === "compiled"
    ? "compiled"
    : "source";
  const instanceRuntime = Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers"
    ? "workers"
    : "deno";

  const args: string[] = [
    "-e",
    `instance_repo_url=${SSH_REPO_URLS.instance}`,
    "-e",
    `ui_repo_url=${SSH_REPO_URLS.ui}`,
    "-e",
    `website_repo_url=${SSH_REPO_URLS.website}`,
  ];
  if (devUser) args.push("-e", `turbopanel_dev_user=${devUser}`);
  if (devUid) args.push("-e", `turbopanel_dev_uid=${devUid}`);
  if (devGid) args.push("-e", `turbopanel_dev_gid=${devGid}`);
  args.push("-e", `turbopanel_ui_mode=${uiMode}`);
  args.push("-e", `turbopanel_instance_run_mode=${instanceRunMode}`);
  args.push("-e", `turbopanel_instance_runtime=${instanceRuntime}`);
  if (instanceRuntime === "workers") {
    args.push("-e", "postgres_expose_port=true");
  }
  return args;
}

async function runInstanceDevInstall(): Promise<void> {
  const devMod = await import(DAEMON_DEV_ORCHESTRATION_PATH) as {
    requireDevOrchestrationLayout: () => Promise<{
      playbookPath: string;
      ansibleCfgPath: string;
      root: string;
      devRolesDir: string;
      daemonRolesDir: string;
      manifest: {
        playbook: string;
        roles: string[];
        devRoles: string[];
      };
    }>;
    devOrchestrationAnsibleEnv: (
      layout: {
        ansibleCfgPath: string;
      },
    ) => Record<string, string>;
  };
  const layout = await devMod.requireDevOrchestrationLayout();

  const eventsMod = await import(DAEMON_ANSIBLE_EVENTS_PATH) as {
    runPlaybookStreaming: (
      ansiblePlaybookBin: string,
      args: string[],
      options: {
        cwd?: string;
        env?: Record<string, string>;
        onEvent: (event: unknown) => void;
      },
    ) => Promise<void>;
  };
  await eventsMod.runPlaybookStreaming(
    ANSIBLE_PLAYBOOK_BIN,
    ["-i", "localhost,", "-c", "local", ...devInstanceExtraArgs(), layout.playbookPath],
    {
      cwd: ANSIBLE_PLAYBOOK_CWD,
      env: devMod.devOrchestrationAnsibleEnv(layout),
      onEvent: emitEvent,
    },
  );

  const stampMod = await import(DAEMON_CONVERGE_STAMP_PATH) as {
    computeDevConvergeStamp: () => Promise<string>;
    writeDevConvergeStamp: (stamp: string) => Promise<void>;
  };
  await stampMod.writeDevConvergeStamp(await stampMod.computeDevConvergeStamp());
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
  const mod = await import(DAEMON_ANSIBLE_PATH) as {
    runBuildToggle: (
      opts: {
        uiMode: "dev" | "static";
        instanceRunMode: "source" | "compiled";
        forceBuild?: boolean;
      },
      onEvent?: (event: unknown) => void,
    ) => Promise<void>;
  };
  await mod.runBuildToggle(opts, emitEvent);
}

async function runPlaybook(): Promise<void> {
  const playbookRelative = Deno.args[1];
  if (!playbookRelative) {
    throw new Error("playbook requires a playbook path argument");
  }
  const extraArgs = Deno.args.slice(2);
  const eventsMod = await import(DAEMON_ANSIBLE_EVENTS_PATH) as {
    runPlaybookStreaming: (
      ansiblePlaybookBin: string,
      args: string[],
      options: {
        cwd?: string;
        env?: Record<string, string>;
        onEvent: (event: unknown) => void;
      },
    ) => Promise<void>;
  };
  const playbook = `${DAEMON_ORCHESTRATION_DIR}/playbooks/${playbookRelative}`;
  await eventsMod.runPlaybookStreaming(
    ANSIBLE_PLAYBOOK_BIN,
    ["-i", "localhost,", "-c", "local", ...extraArgs, playbook],
    {
      cwd: ANSIBLE_PLAYBOOK_CWD,
      env: daemonAnsibleEnv(),
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
      await runInstanceDevInstall();
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
