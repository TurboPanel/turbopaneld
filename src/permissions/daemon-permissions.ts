/**
 * The production daemon's Deno permission contract.
 *
 * One definition, rendered into every place the managed daemon is launched:
 * the `compile` / `compile:linux-*` tasks in `deno.json` (baked into the
 * native binary), the JS-fallback `ExecStart` in
 * `orchestration/roles/daemon-launch/templates/turbopaneld.service.j2`, and
 * the installer-time `deno run` invocations in `scripts/run.sh`.
 * `daemon-permissions.test.ts` holds each copy to this module, refuses
 * `--allow-all` and bare read/write/run grants on those paths, derives the
 * spawn allowlist from `src/` so a new `Deno.Command` target cannot land
 * without its grant, and maps every orchestration write target onto the
 * write grant so an install-time path cannot fall outside it.
 *
 * The native binary is also the installer: `scripts/run.sh` runs the root-only
 * `bootstrap-orchestration` / `run-installer` verbs through it on hosts where
 * it executes, and `deno compile` bakes exactly one grant set that the binary
 * cannot widen at runtime. The daemon grant therefore has to carry the
 * install-time writes too ({@link INSTALLER_VENDOR_DIRS}).
 *
 * Paths are the production layout defaults (`src/paths/layout.ts`); the
 * vendored-tool paths carry the pinned versions from `orchestration/assets.ts`
 * because Deno resolves `--allow-run` entries to exact executables.
 */
import {
  ANSIBLE_CORE_VERSION,
  CLOUDFLARED_VERSION,
  UV_VERSION,
} from "../orchestration/assets.ts";
import {
  PROD_BACKUP_DIR_DEFAULT,
  PROD_BIN_DIR_DEFAULT,
  PROD_CONFIG_DIR_DEFAULT,
  PROD_HOME_DEFAULT,
  PROD_LOG_DIR_DEFAULT,
  PROD_RUN_DIR_DEFAULT,
  PROD_RUNTIME_DIR_DEFAULT,
  PROD_STATE_DIR_DEFAULT,
} from "../paths/layout.ts";

const VENDOR = PROD_RUNTIME_DIR_DEFAULT;
const PRINCIPAL_HOME_ROOT = "/srv/users";
/**
 * The Docker gate's socket directory (`orchestration/roles/docker-gate`):
 * `root:tp 0750`, holding only the gate's listening socket. Deno gates a Unix
 * `connect()` on read and write access to the socket path, so the daemon needs
 * both here for the in-process Docker client to reach the gate once
 * `TURBOPANEL_DOCKER_SOCKET` points at it. The directory is root-owned: the
 * grant cannot be used to create or replace anything in it.
 */
export const DOCKER_GATE_SOCKET_DIR = "/run/turbopanel-gate";
const DOCKER_SOCKETS = [
  "/run/docker.sock",
  "/var/run/docker.sock",
  DOCKER_GATE_SOCKET_DIR,
];

/**
 * Vendor subtrees the daemon process itself writes at runtime: uv's download
 * cache and the cloudflared connector it vendors on demand for its own
 * tunnels (run as the daemon, never as root). Everything else under the
 * install root is root-owned and immutable to the daemon
 * (`orchestration/roles/turbopanel-user`, mirrored as
 * `turbopanel_daemon_vendor_cache_dirs`), so a compromised daemon cannot
 * replace its binary, the orchestration tree root executes, a Galaxy role,
 * or a runtime it is launched from. railpack and its frontend are installed
 * by the `buildkit` role (root); the Galaxy Docker role by `tp-orchestrate`.
 */
export const DAEMON_WRITABLE_VENDOR_DIRS: readonly string[] = [
  `${VENDOR}/uv/cache`,
  `${VENDOR}/cloudflared`,
];

/**
 * The orchestration runtime the root-run installer verbs populate
 * (`src/orchestration/{uv,python,ansible,bootstrap-stamp}.ts`): uv and the
 * pinned interpreter with their `current` symlinks, the Ansible venv, the
 * Galaxy roles/collections, and the bootstrap stamps. The compiled binary
 * carries these because it *is* the installer on native hosts. At daemon
 * runtime the grant is inert: the trees are `root:tp 0750` and the process
 * runs as `tp`, so the kernel refuses what Deno would allow, and the
 * `ensure*` steps short-circuit once root has populated them. The binary
 * (`bin/`), the orchestration tree (`share/`), and the Deno/Node/buildkit/
 * railpack runtimes stay outside the grant.
 */
export const INSTALLER_VENDOR_DIRS: readonly string[] = [
  `${VENDOR}/uv`,
  `${VENDOR}/python`,
  `${VENDOR}/ansible`,
];

/**
 * Run-allowlist entries that also sit inside a write grant.
 *
 * Deno refuses **every** write — `writeFile`, `copyFile`, `chmod`, `rename`,
 * `remove` — to a path in `--allow-run`, no matter what `--allow-write` says:
 * a process that may execute a file must not be able to rewrite it. Nothing
 * reports this at compile time, so the first canary install after the
 * 2026-09-19 hardening died on `Requires write access to` the pinned uv
 * binary — with that path's parent squarely inside
 * {@link INSTALLER_VENDOR_DIRS}.
 *
 * Each of these is therefore materialised by something that is not a Deno
 * file API:
 * - uv / uvx / cloudflared — `installVendorExecutable` (`cp` + `chmod`) in
 *   `scoped-writes.ts`;
 * - the Ansible venv entrypoints — written by `uv venv` / `uv pip install`;
 * - the Deno runtime — extracted by `scripts/run.sh` before the daemon runs.
 *
 * `daemon-permissions.test.ts` recomputes the intersection from the rendered
 * flag sets, so a new vendored tool cannot land on both lists unnoticed.
 */
export const RUN_TARGETS_INSIDE_WRITE_GRANT: readonly string[] = [
  `${VENDOR}/uv/${UV_VERSION}/uv`,
  `${VENDOR}/uv/${UV_VERSION}/uvx`,
  `${VENDOR}/cloudflared/${CLOUDFLARED_VERSION}/cloudflared`,
  `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-playbook`,
  `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-galaxy`,
  `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-lint`,
  `${VENDOR}/deno/bin/deno`,
  `${VENDOR}/deno/current/deno`,
];

/** Read roots: the install tree, host facts, and everything the daemon may write. */
export const DAEMON_READ_PATHS: readonly string[] = [
  PROD_HOME_DEFAULT,
  PROD_CONFIG_DIR_DEFAULT,
  PROD_STATE_DIR_DEFAULT,
  PROD_LOG_DIR_DEFAULT,
  PROD_RUN_DIR_DEFAULT,
  PROD_BACKUP_DIR_DEFAULT,
  PRINCIPAL_HOME_ROOT,
  ...DOCKER_SOCKETS,
  "/tmp",
  // Host facts and managed-service config the daemon reads directly; /proc
  // is listed for completeness but Deno gates it behind --allow-all, so the
  // collectors already fall back to `cat` (see metrics/collector/proc-read.ts).
  "/proc",
  "/sys",
  "/dev",
  "/etc/os-release",
  "/etc/hostname",
  "/etc/machine-id",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/ssl",
  "/etc/ssh",
  "/etc/systemd",
  "/etc/docker",
  "/etc/php",
  "/etc/apache2",
  "/etc/nginx",
  "/etc/caddy",
  "/etc/wireguard",
  "/etc/sysctl.d",
  // Executable trees, for `stat`-style "is this tool installed" probes.
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
];

/**
 * Write roots: mutable FHS trees, the daemon's vendor cache, and the
 * orchestration runtime the installer verbs populate.
 */
export const DAEMON_WRITE_PATHS: readonly string[] = [
  PROD_CONFIG_DIR_DEFAULT,
  PROD_STATE_DIR_DEFAULT,
  PROD_LOG_DIR_DEFAULT,
  PROD_RUN_DIR_DEFAULT,
  PROD_BACKUP_DIR_DEFAULT,
  PRINCIPAL_HOME_ROOT,
  ...DOCKER_SOCKETS,
  "/tmp",
  ...DAEMON_WRITABLE_VENDOR_DIRS,
  ...INSTALLER_VENDOR_DIRS,
];

/**
 * Programs the daemon spawns. Bare names resolve on the unit's PATH; vendored
 * tools are exact paths. `sudo` is here because root host changes go through
 * `sudo -n tp-host …` / `tp-orchestrate` and native builds through
 * `sudo -n -u <self> -- env … sh -c`; `sh` because builds and deploy hooks
 * run shell commands as the daemon account. Neither widens what the account
 * can do as root — that is `/etc/sudoers.d/tp` (turbopanel-user role) and
 * tp-host. Nothing spawns `bash` directly, so it is not granted.
 */
export const DAEMON_RUN_PROGRAMS: readonly string[] = [
  // privilege boundary + shell
  "sudo",
  "sh",
  "/bin/sh",
  // host inspection (all read-only; /proc fallbacks)
  "cat",
  "ls",
  "df",
  "dmesg",
  "getconf",
  "getent",
  "id",
  "/usr/bin/id",
  "test",
  "smartctl",
  "nvidia-smi",
  // who holds :80 during instance ACME (`ss -H -ltnp`)
  "ss",
  // networking / firewall / fabric
  "ip",
  "iptables",
  "ip6tables",
  "iptables-restore",
  "ip6tables-restore",
  "iptables-save",
  "ip6tables-save",
  "wg",
  "sysctl",
  "tee",
  "chmod",
  "mkdir",
  "cp",
  "ln",
  // services, sources, archives, TLS
  "systemctl",
  "sshd",
  "git",
  "curl",
  "/usr/bin/curl",
  "tar",
  "/usr/bin/tar",
  "openssl",
  "/usr/bin/openssl",
  "/usr/bin/env",
  "/usr/bin/prlimit",
  // containers and image builds
  "docker",
  "/usr/bin/docker",
  `${VENDOR}/railpack/current/railpack`,
  // the daemon itself (dev-sync cache warm, restart) and its runtime
  `${PROD_BIN_DIR_DEFAULT}/turbopaneld`,
  `${VENDOR}/deno/bin/deno`,
  `${VENDOR}/deno/current/deno`,
  // orchestration runtime (pinned versions from orchestration/assets.ts)
  `${VENDOR}/uv/${UV_VERSION}/uv`,
  `${VENDOR}/uv/${UV_VERSION}/uvx`,
  `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-playbook`,
  `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-galaxy`,
  `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-lint`,
  `${VENDOR}/cloudflared/${CLOUDFLARED_VERSION}/cloudflared`,
];

/**
 * `Deno.hostname()`, `Deno.networkInterfaces()`, filesystem `statfs`, and
 * `Deno.uid()` (orchestration/privileged.ts decides root-helper routing).
 */
export const DAEMON_SYS_APIS: readonly string[] = [
  "networkInterfaces",
  "hostname",
  "statfs",
  "uid",
];

/** NVML lives under the distro library trees (metrics/collector/gpu). */
export const DAEMON_FFI_PATHS: readonly string[] = [
  "/usr/lib",
  "/usr/lib64",
  "/lib",
  "/lib64",
];

/**
 * Link-local metadata services. The daemon has no business talking to a
 * cloud instance-metadata endpoint; denying them closes the classic SSRF
 * pivot even though the network grant itself cannot be enumerated.
 */
export const DAEMON_DENY_NET: readonly string[] = [
  "169.254.169.254", // NOSONAR typescript:S1313 — cloud-metadata deny list, not a bind
  "metadata.google.internal",
  // Deno wants IPv6 hosts bracketed on the command line (`deno compile`
  // refuses the bare form: "ipv6 addresses must be enclosed in square
  // brackets").
  "[fd00:ec2::254]",
];

/**
 * Grants that stay unscoped, each with the reason the test accepts it. No
 * other permission may be unscoped on a production path.
 *
 * - `net`: the control-plane origin is operator configuration, ACME probes
 *   dial tenant domains, metrics scrape container addresses, and ProxySQL
 *   listens on a configured bind — Deno has no wildcard or CIDR host grant,
 *   so a static list cannot express it. `--deny-net` closes the metadata
 *   endpoints instead.
 *
 * `env` is scoped: see {@link DAEMON_ENV_NAMES}.
 */
export const DAEMON_UNSCOPED_GRANTS: Readonly<Record<"net", string>> = {
  net: "operator-configured origins; no wildcard host grant exists",
};

/**
 * Environment variables the daemon (and the installer and backup runner that
 * share its bundle) may read. Every name the source reads is project-owned
 * `TURBOPANEL_*` except the account basics `HOME` (dev layout root, git/ansible
 * homes), `PATH` (the minimal env handed to clearEnv build/git children), and
 * `USER` / `LOGNAME` (dev-mode account detection).
 * `src/permissions/env-allowlist.test.ts` scans the source and fails on a
 * read this list does not cover.
 *
 * Paired with a bare `--ignore-env`: a read of any other name returns
 * `undefined` (as if unset) instead of throwing, and `Deno.env.toObject()` —
 * which Deno refuses outright under a scoped grant — returns just the allowed
 * names. Children still inherit the full process environment (Deno does not
 * filter it), so this narrows what the daemon's own JavaScript can see, not
 * what its spawned tools get. The `*` is Deno's prefix wildcard; shells leave
 * it literal because no file is named like the whole flag.
 */
export const DAEMON_ENV_NAMES: readonly string[] = [
  "TURBOPANEL_*",
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
];

/** `--allow-env=<names>` plus the `--ignore-env` that makes it workable. */
export function renderEnvFlags(): string[] {
  return [`--allow-env=${DAEMON_ENV_NAMES.join(",")}`, "--ignore-env"];
}

/** Render the flags in canonical order for `deno run` / `deno compile`. */
export function renderDaemonPermissionFlags(): string[] {
  return [
    `--allow-read=${DAEMON_READ_PATHS.join(",")}`,
    `--allow-write=${DAEMON_WRITE_PATHS.join(",")}`,
    `--allow-run=${DAEMON_RUN_PROGRAMS.join(",")}`,
    ...renderEnvFlags(),
    "--allow-net",
    `--deny-net=${DAEMON_DENY_NET.join(",")}`,
    `--allow-sys=${DAEMON_SYS_APIS.join(",")}`,
    `--allow-ffi=${DAEMON_FFI_PATHS.join(",")}`,
  ];
}

/**
 * The scheduled-backup runner's Deno permission contract (JS mode).
 *
 * `turbopaneld backup-run <policyId>` is started by a policy's systemd timer
 * through `lib/tp-backup-run` (`orchestration/roles/daemon-launch/templates/
 * tp-backup-run.j2`). It never talks to the control plane or a socket and
 * only ever drives the Docker CLI, so it gets a fraction of the daemon's set
 * instead of a copy of it:
 *
 * - read/write: the policies file and result spool under
 *   `<state>/backup`, the two per-target lock directories under the run dir,
 *   and the backup tree itself. Nothing else under the state dir (licence,
 *   server id, TLS, tunnels), no tenant home (`/srv/users`: the volume is
 *   read by a helper container, never by this process), and not the Docker
 *   socket (the CLI child opens that, not Deno).
 * - read of the docker binary: `ensureDocker` stats it.
 * - run: the Docker CLI only. Not `sudo`: a timer-started process has fresh
 *   credentials, and `docker-cli.ts` reports the real socket error when it
 *   may not run the sudo fallback.
 * - env: the daemon's scoped set ({@link renderEnvFlags}) — layout
 *   resolution reads `TURBOPANEL_*` overrides.
 * - sys: `statfs` for the free-space check.
 * - no net, no ffi.
 *
 * Native hosts execute the compiled binary instead, whose baked grants are
 * the daemon's ({@link renderDaemonPermissionFlags}) and cannot be narrowed
 * at runtime.
 */
export const BACKUP_RUNNER_STATE_SUBDIR = "backup";
export const BACKUP_RUNNER_LOCK_SUBDIRS: readonly string[] = [
  "managed-locks",
  "copy-locks",
];
export const BACKUP_RUNNER_DOCKER_BIN = "/usr/bin/docker";

/** Folders the runner reads and writes. */
export const BACKUP_RUNNER_DATA_PATHS: readonly string[] = [
  `${PROD_STATE_DIR_DEFAULT}/${BACKUP_RUNNER_STATE_SUBDIR}`,
  ...BACKUP_RUNNER_LOCK_SUBDIRS.map((dir) => `${PROD_RUN_DIR_DEFAULT}/${dir}`),
  PROD_BACKUP_DIR_DEFAULT,
];
export const BACKUP_RUNNER_READ_PATHS: readonly string[] = [
  ...BACKUP_RUNNER_DATA_PATHS,
  BACKUP_RUNNER_DOCKER_BIN,
];
export const BACKUP_RUNNER_WRITE_PATHS: readonly string[] = [
  ...BACKUP_RUNNER_DATA_PATHS,
];
export const BACKUP_RUNNER_RUN_PROGRAMS: readonly string[] = [
  BACKUP_RUNNER_DOCKER_BIN,
];
export const BACKUP_RUNNER_SYS_APIS: readonly string[] = ["statfs"];

/** Render the backup runner's flags in canonical order for `deno run`. */
export function renderBackupRunnerPermissionFlags(): string[] {
  return [
    `--allow-read=${BACKUP_RUNNER_READ_PATHS.join(",")}`,
    `--allow-write=${BACKUP_RUNNER_WRITE_PATHS.join(",")}`,
    `--allow-run=${BACKUP_RUNNER_RUN_PROGRAMS.join(",")}`,
    ...renderEnvFlags(),
    `--allow-sys=${BACKUP_RUNNER_SYS_APIS.join(",")}`,
  ];
}

/**
 * What `scripts/run.sh` grants the JS bundle for `bootstrap-orchestration`
 * and `run-installer`, which run as **root** before the unit exists. Same
 * shape as the daemon set minus the socket/principal/tenant surfaces the
 * installer never touches, plus the install-time scratch it does.
 */
export function renderInstallerPermissionFlags(): string[] {
  const read = [
    PROD_HOME_DEFAULT,
    PROD_CONFIG_DIR_DEFAULT,
    PROD_STATE_DIR_DEFAULT,
    PROD_LOG_DIR_DEFAULT,
    PROD_RUN_DIR_DEFAULT,
    "/tmp",
    "/root/.ansible",
    "/etc/os-release",
    "/etc/hostname",
    "/etc/machine-id",
    "/etc/passwd",
    "/etc/group",
    "/etc/ssl",
    "/etc/systemd",
    "/proc",
    "/sys",
    "/dev",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
  ];
  const write = [
    PROD_HOME_DEFAULT,
    PROD_CONFIG_DIR_DEFAULT,
    PROD_STATE_DIR_DEFAULT,
    PROD_LOG_DIR_DEFAULT,
    PROD_RUN_DIR_DEFAULT,
    "/tmp",
    "/root/.ansible",
  ];
  const run = [
    "sh",
    "/bin/sh",
    "bash",
    "cat",
    "ls",
    // `installVendorExecutable`: the only way to write uv/uvx/cloudflared,
    // which are themselves run targets — see RUN_TARGETS_INSIDE_WRITE_GRANT.
    "cp",
    "chmod",
    // `createSymlink`: Deno.symlink() refuses path-scoped grants outright.
    "ln",
    "id",
    "/usr/bin/id",
    "getent",
    "systemctl",
    "tar",
    "/usr/bin/tar",
    "curl",
    "/usr/bin/curl",
    "git",
    "openssl",
    "/usr/bin/openssl",
    `${VENDOR}/deno/bin/deno`,
    `${VENDOR}/deno/current/deno`,
    `${VENDOR}/uv/${UV_VERSION}/uv`,
    `${VENDOR}/uv/${UV_VERSION}/uvx`,
    `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-playbook`,
    `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-galaxy`,
    `${VENDOR}/ansible/${ANSIBLE_CORE_VERSION}/bin/ansible-lint`,
  ];
  return [
    `--allow-read=${read.join(",")}`,
    `--allow-write=${write.join(",")}`,
    `--allow-run=${run.join(",")}`,
    ...renderEnvFlags(),
    "--allow-net",
    `--deny-net=${DAEMON_DENY_NET.join(",")}`,
    `--allow-sys=${DAEMON_SYS_APIS.join(",")}`,
  ];
}
