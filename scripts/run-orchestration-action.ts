#!/usr/bin/env -S deno run --config=/opt/turbopanel/platform/daemon/deno.json --allow-read --allow-run --allow-env --allow-write --allow-net
/**
 * Runs daemon orchestration playbooks as turbopanel (invoked via sudo from the console).
 * Emits Ansible JSONL events on stdout — one JSON object per line.
 *
 * Installed to /opt/turbopanel/platform/daemon/scripts/ before each orchestration
 * run so the turbopanel user can execute it without reading the developer checkout.
 */
const TURBOPANEL_ROOT = "/opt/turbopanel";
const TURBOPANEL_PLATFORM = `${TURBOPANEL_ROOT}/platform`;
const RUNTIMES_DIR = `${TURBOPANEL_ROOT}/runtimes`;
const ANSIBLE_PLAYBOOK_BIN =
  `${RUNTIMES_DIR}/ansible/current/bin/ansible-playbook`;
const ANSIBLE_LOCAL_TMP = `${RUNTIMES_DIR}/uv/cache/ansible-tmp`;
const ANSIBLE_COLLECTIONS_PATH = `${RUNTIMES_DIR}/ansible/galaxy-collections`;
const DAEMON_ENV_PATH = `${TURBOPANEL_PLATFORM}/daemon/.env`;

const INSTANCE_DEV_INSTALL_PLAYBOOK =
  `${TURBOPANEL_PLATFORM}/daemon/orchestration/playbooks/instance-dev-install.yml`;

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

function ansiblePlaybookEnv(): Record<string, string> {
  return {
    ANSIBLE_CONFIG: `${DAEMON_ORCHESTRATION_DIR}/ansible.cfg`,
    ANSIBLE_LOCAL_TEMP: ANSIBLE_LOCAL_TMP,
    ANSIBLE_COLLECTIONS_PATH: ANSIBLE_COLLECTIONS_PATH,
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
  // #region agent log
  fetch("http://localhost:7882/ingest/09b3950f-5d3f-4c91-a3cf-e073cbcbe3cb", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "8aec57",
    },
    body: JSON.stringify({
      sessionId: "8aec57",
      runId: "pre-fix",
      hypothesisId: "B",
      location: "run-orchestration-action.ts:runInstanceDevInstall",
      message: "starting instance-dev-install",
      data: {
        extraArgs: devInstanceExtraArgs(),
        websiteRepoUrl: SSH_REPO_URLS.website,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
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
    ["-i", "localhost,", "-c", "local", ...devInstanceExtraArgs(), INSTANCE_DEV_INSTALL_PLAYBOOK],
    {
      cwd: DAEMON_ORCHESTRATION_DIR,
      env: ansiblePlaybookEnv(),
      onEvent: emitEvent,
    },
  );
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
      cwd: DAEMON_ORCHESTRATION_DIR,
      env: ansiblePlaybookEnv(),
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
