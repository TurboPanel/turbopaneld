import { dirname, join } from "@std/path";
import { readEnv, resolveDaemonRoot, resolveLayout } from "../paths/layout.ts";

export {
  DaemonSourceRootError,
  defaultDaemonRootForMode,
  detectInstallMode,
  DEV_DAEMON_ROOT_DEFAULT as DEV_DEFAULT_DAEMON_ROOT,
  hasDaemonCheckout,
  isCompiledStubRoot,
  resolveDaemonRoot,
} from "../paths/layout.ts";

export const UV_VERSION = "0.11.21";
export const PYTHON_VERSION = "3.14.6";
export const ANSIBLE_CORE_VERSION = "2.20";

const layoutEnv = {
  TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
  TURBOPANEL_RUNTIMES_DIR: readEnv("TURBOPANEL_RUNTIMES_DIR"),
  TURBOPANEL_ORCHESTRATION_DIR: readEnv("TURBOPANEL_ORCHESTRATION_DIR"),
  TURBOPANEL_HOME: readEnv("TURBOPANEL_HOME"),
  TURBOPANEL_LIB_DIR: readEnv("TURBOPANEL_LIB_DIR"),
  TURBOPANEL_STATE_DIR: readEnv("TURBOPANEL_STATE_DIR"),
  TURBOPANEL_DAEMON_STATE_DIR: readEnv("TURBOPANEL_DAEMON_STATE_DIR"),
  TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
};

const layout = resolveLayout(layoutEnv);

/** Default managed install layout for the active install mode. */
export const DEFAULT_DAEMON_ROOT = layout.daemonRootDefault;

/**
 * Absolute path to the daemon install root.
 *
 * Compiled `turbopaneld` resolves `import.meta.url` under a temporary
 * `deno-compile-*` directory — never use that as the install root. Prefer
 * `TURBOPANEL_DAEMON_ROOT`, then cwd (systemd WorkingDirectory), then a tree
 * with `orchestration/ansible.cfg`, then the default managed install path.
 */
export const DAEMON_ROOT = resolveDaemonRoot(layoutEnv);

/** Checked-in orchestration source assets (playbooks, ansible.cfg, requirements). */
export const ORCHESTRATION_DIR = layout.orchestrationDir;

/**
 * Root for vendored, versioned third-party runtimes shared across the host
 * (uv/python/ansible, cloudflared, and room for more). Override with
 * `TURBOPANEL_RUNTIMES_DIR`.
 */
export const RUNTIMES_DIR = layout.runtimesDir;

/**
 * Working directory for ansible-playbook invocations.
 * Outside the daemon checkout so git/ansible does not walk dev-owned `.git`.
 */
export const ANSIBLE_PLAYBOOK_CWD = dirname(RUNTIMES_DIR);

/** Versioned directory where uv binaries are installed. */
export const UV_INSTALL_DIR = join(RUNTIMES_DIR, "uv", UV_VERSION);
export const RUNTIME_BIN_DIR = UV_INSTALL_DIR;
export const UV_BIN = join(RUNTIME_BIN_DIR, "uv");
export const UVX_BIN = join(RUNTIME_BIN_DIR, "uvx");

/** Stable `current` symlink pointing at the active uv version dir. */
export const UV_CURRENT_DIR = join(RUNTIMES_DIR, "uv", "current");

/** `UV_PYTHON_INSTALL_DIR` target: versioned managed Python tree. */
export const PYTHON_RUNTIME_DIR = join(RUNTIMES_DIR, "python", PYTHON_VERSION);

/** Stable `current` symlink pointing at the active Python version dir. */
export const PYTHON_CURRENT_DIR = join(RUNTIMES_DIR, "python", "current");

/** @deprecated Alias for {@link PYTHON_RUNTIME_DIR} — passed to `UV_PYTHON_INSTALL_DIR`. */
export const PYTHON_INSTALL_DIR = PYTHON_RUNTIME_DIR;

/** `UV_CACHE_DIR` target: keeps uv's download/build cache under runtimes. */
export const CACHE_DIR = join(RUNTIMES_DIR, "uv", "cache");

/** The ansible virtualenv created by `uv venv`. */
export const ANSIBLE_INSTALL_DIR = join(
  RUNTIMES_DIR,
  "ansible",
  ANSIBLE_CORE_VERSION,
);
export const VENV_DIR = ANSIBLE_INSTALL_DIR;
export const VENV_BIN_DIR = join(VENV_DIR, "bin");
export const ANSIBLE_PLAYBOOK_BIN = join(VENV_BIN_DIR, "ansible-playbook");
export const ANSIBLE_LINT_BIN = join(VENV_BIN_DIR, "ansible-lint");

/** Stable `current` symlink pointing at the active ansible venv dir. */
export const ANSIBLE_CURRENT_DIR = join(RUNTIMES_DIR, "ansible", "current");

export const REQUIREMENTS_FILE = join(ORCHESTRATION_DIR, "requirements.txt");
/** Collections (ansible.posix) — installed at orchestration bootstrap. */
export const GALAXY_REQUIREMENTS_FILE = join(
  ORCHESTRATION_DIR,
  "requirements.yml",
);
/** Docker Galaxy roles (geerlingguy.docker) — installed on demand only. */
export const GALAXY_DOCKER_REQUIREMENTS_FILE = join(
  ORCHESTRATION_DIR,
  "requirements-docker.yml",
);
/**
 * Upstream GitHub repo for the pinned geerlingguy.docker Galaxy role.
 * ansible-galaxy resolves classic roles via `github.com/.../archive/*.tar.gz`,
 * which intermittently returns 503 from GitHub's edge; {@link ensureGalaxyDockerRole}
 * downloads the same tag via codeload instead (see {@link galaxyDockerRoleCodeloadUrl}).
 */
export const GALAXY_DOCKER_ROLE_GITHUB_REPO =
  "geerlingguy/ansible-role-docker";

/** Codeload archive URL for a pinned geerlingguy.docker role tag. */
export function galaxyDockerRoleCodeloadUrl(version: string): string {
  return `https://codeload.github.com/${GALAXY_DOCKER_ROLE_GITHUB_REPO}/tar.gz/refs/tags/${version}`;
}
/** First-party Ansible roles in the orchestration checkout (not Galaxy). */
export const GALAXY_ROLES_DIR = join(ORCHESTRATION_DIR, "roles");
/**
 * Galaxy-installed roles (`geerlingguy.docker`, …). Under vendor — never the
 * checkout `roles/` tree — so Vagrant VirtFS mounts (host-owned, guest-unwritable)
 * and production FHS stay consistent with {@link GALAXY_COLLECTIONS_DIR}.
 */
export const GALAXY_VENDOR_ROLES_DIR = join(
  RUNTIMES_DIR,
  "ansible",
  "galaxy-roles",
);
export const GALAXY_COLLECTIONS_DIR = join(
  RUNTIMES_DIR,
  "ansible",
  "galaxy-collections",
);
export const ANSIBLE_LOCAL_TMP = join(CACHE_DIR, "ansible-tmp");
/**
 * Ephemeral Ansible home (galaxy download cache, etc.). Under `/tmp` so root-run
 * install bootstrap never writes `/root/.ansible`. Real content lands in FHS
 * paths (`GALAXY_*`); this dir is disposable and cleaned after managed install.
 */
export const ANSIBLE_HOME = "/tmp/turbopanel-ansible"; // NOSONAR typescript:S5443 — disposable ephemeral cache; durable content uses FHS GALAXY_* paths
export const ANSIBLE_CFG = join(ORCHESTRATION_DIR, "ansible.cfg");
/**
 * `ansible.builtin.shell` default is `/bin/sh`. Debian `/bin/sh` is dash,
 * which rejects `set -o pipefail` used by role install snippets (cache, Deno,
 * Caddy, …). Force bash — present on Debian, matches the bash wrappers.
 */
export const ANSIBLE_SHELL_EXECUTABLE = "/bin/bash";

/** Ansible env vars for playbook and galaxy bootstrap invocations. */
export function ansibleEnv(): Record<string, string> {
  return {
    ANSIBLE_CONFIG: ANSIBLE_CFG,
    ANSIBLE_EXECUTABLE: ANSIBLE_SHELL_EXECUTABLE,
    ANSIBLE_HOME,
    ANSIBLE_LOCAL_TEMP: ANSIBLE_LOCAL_TMP,
    ANSIBLE_ROLES_PATH: `${GALAXY_ROLES_DIR}:${GALAXY_VENDOR_ROLES_DIR}`,
  };
}

export const LOCALHOST_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "localhost-test.yml",
);
export const DAEMON_CONVERGE_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "daemon-converge.yml",
);
export const DOCKER_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "docker-setup.yml",
);
export const CADDY_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "caddy-setup.yml",
);
export const POSTGRES_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "postgres-setup.yml",
);
export const PROXYSQL_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "proxysql-setup.yml",
);
export const REDIS_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "redis-setup.yml",
);
export const RABBITMQ_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "rabbitmq-setup.yml",
);
export const CLICKHOUSE_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "clickhouse-setup.yml",
);
export const SOCKET_DIRS_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "socket-dirs-setup.yml",
);
export const DAEMON_LOGS_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "daemon-logs-setup.yml",
);
export const DAEMON_SYSTEMD_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "daemon-systemd-setup.yml",
);
export const BUILD_TOGGLE_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "instance-build-toggle.yml",
);
export const INSTANCE_CERTS_APPLY_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "instance-certs-apply.yml",
);
export const SET_HOSTNAME_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "set-hostname.yml",
);
export const TIME_SYNC_APPLY_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "time-sync-apply.yml",
);
export const WIREGUARD_APPLY_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "wireguard-apply.yml",
);
export const TRADITIONAL_WEB_APPLY_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "traditional-web-apply.yml",
);
export const TRADITIONAL_WEB_APACHE_APPLY_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "traditional-web-apache-apply.yml",
);
export const TRADITIONAL_WEB_OPENLITESPEED_APPLY_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "traditional-web-openlitespeed-apply.yml",
);
export const DAEMON_INSTALL_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  "playbooks",
  "daemon-install.yml",
);

export interface UvTarget {
  /** uv release target triple, e.g. `aarch64-unknown-linux-gnu`. */
  triple: string;
  /** Release asset file name, e.g. `uv-aarch64-unknown-linux-gnu.tar.gz`. */
  asset: string;
}

/**
 * Map the current platform to the matching uv release asset.
 *
 * Only Linux on aarch64 / x86_64 is supported for now (the daemon's deployment
 * targets). Throws a clear error elsewhere so the failure is obvious rather than a
 * confusing 404 from the download step.
 */
export function resolveUvTarget(
  os: typeof Deno.build.os = Deno.build.os,
  arch: typeof Deno.build.arch = Deno.build.arch,
): UvTarget {
  if (os !== "linux") {
    throw new Error(
      `Unsupported OS for orchestration runtime: "${os}". Only "linux" is supported.`,
    );
  }

  let archPart: string;
  switch (arch) {
    case "aarch64":
      archPart = "aarch64";
      break;
    case "x86_64":
      archPart = "x86_64";
      break;
    default:
      throw new Error(
        `Unsupported CPU architecture for orchestration runtime: "${arch}". ` +
          'Only "aarch64" and "x86_64" are supported.',
      );
  }

  const triple = `${archPart}-unknown-linux-gnu`;
  return { triple, asset: `uv-${triple}.tar.gz` };
}

export function uvDownloadUrl(asset: string, version = UV_VERSION): string {
  return `https://github.com/astral-sh/uv/releases/download/${version}/${asset}`;
}

/** Pinned cloudflared release. */
export const CLOUDFLARED_VERSION = "2026.5.2";

export function cloudflaredDir(version = CLOUDFLARED_VERSION): string {
  return join(RUNTIMES_DIR, "cloudflared", version);
}

export function cloudflaredBin(version = CLOUDFLARED_VERSION): string {
  return join(cloudflaredDir(version), "cloudflared");
}

/** Stable `current` symlink pointing at the active cloudflared version dir. */
export const CLOUDFLARED_CURRENT_DIR = join(
  RUNTIMES_DIR,
  "cloudflared",
  "current",
);

/**
 * Map the current architecture to the matching cloudflared release asset.
 * cloudflared publishes raw Linux binaries (not tarballs).
 */
export function resolveCloudflaredAsset(
  arch: typeof Deno.build.arch = Deno.build.arch,
): string {
  switch (arch) {
    case "aarch64":
      return "cloudflared-linux-arm64";
    case "x86_64":
      return "cloudflared-linux-amd64";
    default:
      throw new Error(
        `Unsupported CPU architecture for cloudflared: "${arch}". ` +
          'Only "aarch64" and "x86_64" are supported.',
      );
  }
}

export function cloudflaredDownloadUrl(
  asset: string,
  version = CLOUDFLARED_VERSION,
): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`;
}

/**
 * Pinned Deno runtime. Used for co-located `deno run main.ts` and the managed
 * JS-fallback ExecStart (`deno run …/bin/turbopaneld.js`). Keep in step with
 * `deno_version` in `orchestration/roles/deno-runtime/defaults/main.yml`.
 */
export const DENO_VERSION = "2.9.5";

/**
 * Pinned ClickHouse version — Docker image tag
 * (`clickhouse/clickhouse-server:<version>`). Keep in step with
 * `clickhouse_version` in `orchestration/roles/clickhouse/defaults/main.yml`.
 */
export const CLICKHOUSE_VERSION = "26.5.5.8"; // NOSONAR typescript:S1313 — pinned ClickHouse semver, not an IP address

/** Versioned directory where the Deno runtime is installed. */
export const DENO_RUNTIME_DIR = join(RUNTIMES_DIR, "deno", DENO_VERSION);

/** Stable `current` symlink pointing at the active Deno version dir. */
export const DENO_CURRENT_DIR = join(RUNTIMES_DIR, "deno", "current");

/** Stable `bin/deno` convenience path used by the JS-fallback systemd unit. */
export const DENO_BIN_DIR = join(RUNTIMES_DIR, "deno", "bin");

/** Resolved Deno binary path (matches `turbopanel_daemon_deno_bin`). */
export const DENO_BIN = join(DENO_BIN_DIR, "deno");

/**
 * Directory of per-tunnel token files. Each `*.token` file holds one Cloudflare
 * tunnel token; the file's basename is the tunnel's name. Drop in more files to
 * run more tunnels side by side.
 *
 * Both dev and managed installs store tokens under the FHS state dir
 * (`/var/lib/turbopanel/cloudflared/tunnels`).
 */
export const TUNNELS_DIR = join(
  layout.daemonStateDir,
  "cloudflared",
  "tunnels",
);
