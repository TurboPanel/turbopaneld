/**
 * Host-free orchestration runtime fixtures — fake uv/ansible binaries and a minimal
 * orchestration tree. Do not import from production code.
 */

import { dirname, join } from "@std/path";
import { createTempLayout, type TempLayoutFixture } from "./temp-layout.ts";

const REPO_ROOT = join(new URL("../..", import.meta.url).pathname);
const CHECKOUT_ORCHESTRATION = join(REPO_ROOT, "orchestration");

export const UV_VERSION = "0.11.21";
export const ANSIBLE_CORE_VERSION = "2.20";
export const PYTHON_VERSION = "3.14.6";

export const ORCHESTRATION_RUNTIME_ENV_KEYS = [
  "TURBOPANEL_CONFIG_DIR",
  "TURBOPANEL_STATE_DIR",
  "TURBOPANEL_LOG_DIR",
  "TURBOPANEL_RUN_DIR",
  "TURBOPANEL_DAEMON_STATE_DIR",
  "TURBOPANEL_RUNTIMES_DIR",
  "TURBOPANEL_ORCHESTRATION_DIR",
  "TURBOPANEL_DAEMON_ROOT",
  "TURBOPANEL_SKIP_ORCHESTRATION",
  "TURBOPANEL_DEV_INSTANCE",
  "TURBOPANEL_INSTANCE_URL",
  "TURBOPANEL_INSTANCE_RUNTIME",
  "TURBOPANEL_SOCKET",
] as const;

const FAKE_ANSIBLE_PLAYBOOK = String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "ansible-playbook [core 2.20.0]"
  exit 0
fi
if [ "$FAKE_ANSIBLE_FAIL" = "1" ]; then
  echo "orchestration failed" >&2
  exit 1
fi
printf '%s\n' '{"_event":"v2_playbook_on_stats","_timestamp":"2026-01-01T00:00:00.000000Z","stats":{"localhost":{"ok":1,"changed":0,"failures":0,"skipped":0}},"custom_stats":{},"global_custom_stats":{}}'
exit 0
`;

const FAKE_ANSIBLE_LINT = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "ansible-lint 25.0.0"
  exit 0
fi
exit 0
`;

const FAKE_ANSIBLE_GALAXY = `#!/bin/sh
dest=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then
    dest="$arg"
  fi
  prev="$arg"
done
if [ -n "$dest" ]; then
  mkdir -p "$dest/ansible_collections/ansible/posix"
  touch "$dest/ansible_collections/ansible/posix/.installed"
fi
exit 0
`;

function fakeUvScript(): string {
  return `#!/bin/sh
ANSIBLE_BIN="\${TURBOPANEL_RUNTIMES_DIR}/ansible/${ANSIBLE_CORE_VERSION}/bin"
case "$1" in
  --version)
    echo "uv ${UV_VERSION}"
    exit 0
    ;;
  venv)
    mkdir -p "$ANSIBLE_BIN"
    exit 0
    ;;
  pip)
    mkdir -p "$ANSIBLE_BIN"
    printf '%s\\n' '#!/bin/sh' 'if [ "$1" = "--version" ]; then echo "ansible-playbook [core 2.20.0]"; exit 0; fi' 'exit 0' > "$ANSIBLE_BIN/ansible-playbook"
    printf '%s\\n' '#!/bin/sh' 'if [ "$1" = "--version" ]; then echo "ansible-lint 25.0.0"; exit 0; fi' 'exit 0' > "$ANSIBLE_BIN/ansible-lint"
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$ANSIBLE_BIN/ansible-galaxy"
    chmod 755 "$ANSIBLE_BIN/ansible-playbook" "$ANSIBLE_BIN/ansible-lint" "$ANSIBLE_BIN/ansible-galaxy"
    exit 0
    ;;
  python)
    exit 0
    ;;
esac
exit 0
`;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, body);
  // Test stubs must be executable so Deno.Command can invoke them.
  await Deno.chmod(path, 0o755); // NOSONAR typescript:S2612
}

async function copyFileIfPresent(src: string, dest: string): Promise<void> {
  try {
    await Deno.copyFile(src, dest);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

export type OrchestrationSeedOptions = {
  /** Pre-create ansible.posix collection marker (skip galaxy install). */
  withGalaxyCollections?: boolean;
  /** Write bootstrap.stamp matching current requirements. */
  withBootstrapStamp?: boolean;
  /** Pre-create geerlingguy.docker role dir (skip docker galaxy fetch). */
  withGalaxyDockerRole?: boolean;
  /** Install fake ansible-playbook/ansible-lint before tests run. */
  withAnsibleBinaries?: boolean;
  /** When false, omit the stub uv binary (forces download-path tests). */
  withUvBinary?: boolean;
  /** Version string returned by stub uv --version (default pinned {@link UV_VERSION}). */
  uvReportedVersion?: string;
  /** Seed co-located dev overlay under {@link OrchestrationRuntimeFixture.devOrchestrationDir}. */
  withDevOrchestrationOverlay?: boolean;
};

export type OrchestrationRuntimeFixture = {
  layout: TempLayoutFixture;
  orchestrationDir: string;
  runtimesDir: string;
  devOrchestrationDir?: string;
  env: Record<string, string>;
};

function fakeUvVersionScript(reportedVersion: string): string {
  return `#!/bin/sh
case "$1" in
  --version)
    echo "uv ${reportedVersion}"
    exit 0
    ;;
  python)
    exit 0
    ;;
esac
exit 0
`;
}

function snapshotEnv(keys: readonly string[]): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, Deno.env.get(key));
  }
  return previous;
}

export function applyOrchestrationEnv(env: Record<string, string>): void {
  for (const key of ORCHESTRATION_RUNTIME_ENV_KEYS) {
    Deno.env.delete(key);
  }
  for (const [key, value] of Object.entries(env)) {
    Deno.env.set(key, value);
  }
}

export function restoreOrchestrationEnv(
  previous: Map<string, string | undefined>,
): void {
  for (const [key, value] of previous) {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

export function snapshotOrchestrationEnv(): Map<string, string | undefined> {
  return snapshotEnv(ORCHESTRATION_RUNTIME_ENV_KEYS);
}

export async function seedOrchestrationTree(
  orchestrationDir: string,
): Promise<void> {
  await Deno.mkdir(join(orchestrationDir, "playbooks"), { recursive: true });

  for (
    const name of [
      "requirements.txt",
      "requirements.yml",
      "requirements-docker.yml",
      "ansible.cfg",
    ] as const
  ) {
    await copyFileIfPresent(
      join(CHECKOUT_ORCHESTRATION, name),
      join(orchestrationDir, name),
    );
  }

  const stubPlaybook = `---
- hosts: localhost
  gather_facts: false
  tasks:
    - name: Fixture noop
      ansible.builtin.debug:
        msg: fixture
`;

  for (
    const playbook of [
      "localhost-test.yml",
      "daemon-converge.yml",
      "daemon-install.yml",
      "daemon-logs-setup.yml",
      "daemon-systemd-setup.yml",
      "docker-setup.yml",
      "caddy-setup.yml",
      "postgres-setup.yml",
      "proxysql-setup.yml",
      "orchestrator-setup.yml",
      "redis-setup.yml",
      "rabbitmq-setup.yml",
      "clickhouse-setup.yml",
      "socket-dirs-setup.yml",
      "set-hostname.yml",
      "time-sync-apply.yml",
      "instance-build-toggle.yml",
    ] as const
  ) {
    await Deno.writeTextFile(
      join(orchestrationDir, "playbooks", playbook),
      stubPlaybook,
    );
  }
}

/** Co-located dev overlay tree for instance-dev-install playbook tests. */
export async function seedDevOrchestrationOverlay(root: string): Promise<void> {
  await Deno.mkdir(join(root, "roles", "dev-only"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "roles", "dev-only", "tasks.yml"),
    "- name: stub dev task\n  debug:\n    msg: hello\n",
  );
  await Deno.writeTextFile(
    join(root, "dev-converge-manifest.json"),
    `${
      JSON.stringify(
        {
          playbook: "instance-dev-install.yml",
          roles: ["stub-shared"],
          devRoles: ["dev-only"],
        },
        null,
        2,
      )
    }\n`,
  );
  await Deno.writeTextFile(
    join(root, "instance-dev-install.yml"),
    "---\n- hosts: localhost\n  gather_facts: false\n",
  );
  await Deno.writeTextFile(join(root, "ansible.cfg"), "[defaults]\n");
}

export function runtimePaths(runtimesDir: string): {
  uvBin: string;
  ansibleBinDir: string;
  galaxyCollectionsDir: string;
  galaxyVendorRolesDir: string;
  bootstrapStampFile: string;
  galaxyDockerStampFile: string;
} {
  return {
    uvBin: join(runtimesDir, "uv", UV_VERSION, "uv"),
    ansibleBinDir: join(runtimesDir, "ansible", ANSIBLE_CORE_VERSION, "bin"),
    galaxyCollectionsDir: join(runtimesDir, "ansible", "galaxy-collections"),
    galaxyVendorRolesDir: join(runtimesDir, "ansible", "galaxy-roles"),
    bootstrapStampFile: join(runtimesDir, "ansible", "bootstrap.stamp"),
    galaxyDockerStampFile: join(runtimesDir, "ansible", "galaxy-docker.stamp"),
  };
}

async function seedFakeAnsibleBinaries(
  runtimesDir: string,
): Promise<void> {
  const { ansibleBinDir } = runtimePaths(runtimesDir);
  await writeExecutable(
    join(ansibleBinDir, "ansible-playbook"),
    FAKE_ANSIBLE_PLAYBOOK,
  );
  await writeExecutable(join(ansibleBinDir, "ansible-lint"), FAKE_ANSIBLE_LINT);
  await writeExecutable(
    join(ansibleBinDir, "ansible-galaxy"),
    FAKE_ANSIBLE_GALAXY,
  );
}

async function seedGalaxyCollections(runtimesDir: string): Promise<void> {
  const marker = join(
    runtimePaths(runtimesDir).galaxyCollectionsDir,
    "ansible_collections",
    "ansible",
    "posix",
  );
  await Deno.mkdir(marker, { recursive: true });
  await Deno.writeTextFile(join(marker, ".fixture"), "ok\n");
}

async function seedGalaxyDockerRole(runtimesDir: string): Promise<void> {
  const roleDir = join(
    runtimePaths(runtimesDir).galaxyVendorRolesDir,
    "geerlingguy.docker",
  );
  await Deno.mkdir(roleDir, { recursive: true });
  await Deno.writeTextFile(join(roleDir, "README.md"), "# fixture\n");
}

export async function createOrchestrationRuntimeFixture(
  opts: OrchestrationSeedOptions = {},
): Promise<OrchestrationRuntimeFixture> {
  const layout = await createTempLayout();
  const orchestrationDir = join(
    layout.dirs.runtimesDir,
    "orchestration-fixture",
  );
  await seedOrchestrationTree(orchestrationDir);

  const env: Record<string, string> = {
    ...layout.env,
    TURBOPANEL_ORCHESTRATION_DIR: orchestrationDir,
    TURBOPANEL_DAEMON_ROOT: REPO_ROOT,
  };

  let devOrchestrationDir: string | undefined;
  if (opts.withDevOrchestrationOverlay) {
    devOrchestrationDir = join(layout.dirs.runtimesDir, "dev-orchestration");
    await seedDevOrchestrationOverlay(devOrchestrationDir);
    env.TURBOPANEL_DEV_ORCHESTRATION_DIR = devOrchestrationDir;
  }

  const { uvBin } = runtimePaths(layout.dirs.runtimesDir);
  if (opts.withUvBinary !== false) {
    const reported = opts.uvReportedVersion ?? UV_VERSION;
    const body = reported === UV_VERSION
      ? fakeUvScript()
      : fakeUvVersionScript(reported);
    await writeExecutable(uvBin, body);
  }

  if (opts.withAnsibleBinaries !== false) {
    await seedFakeAnsibleBinaries(layout.dirs.runtimesDir);
  }

  if (opts.withGalaxyCollections) {
    await seedGalaxyCollections(layout.dirs.runtimesDir);
  }

  if (opts.withGalaxyDockerRole) {
    await seedGalaxyDockerRole(layout.dirs.runtimesDir);
  }

  return {
    layout,
    orchestrationDir,
    runtimesDir: layout.dirs.runtimesDir,
    devOrchestrationDir,
    env,
  };
}

/** Minimal uv release tar.gz with executable `uv` + `uvx` stubs. */
export async function buildUvFixtureArchive(
  asset: string,
  version: string,
): Promise<Uint8Array> {
  const innerName = asset.replace(/\.tar\.gz$/, "");
  const tmp = await Deno.makeTempDir({ prefix: "tp-uv-" });
  try {
    const inner = join(tmp, innerName);
    await Deno.mkdir(inner, { recursive: true });
    await writeExecutable(
      join(inner, "uv"),
      fakeUvVersionScript(version),
    );
    await writeExecutable(join(inner, "uvx"), "#!/bin/sh\nexit 0\n");
    const archivePath = join(tmp, asset);
    const cmd = new Deno.Command("tar", {
      args: ["-czf", archivePath, "-C", tmp, innerName],
    });
    const output = await cmd.output();
    if (!output.success) {
      throw new TypeError("failed to build uv fixture archive");
    }
    return await Deno.readFile(archivePath);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/** Fake cloudflared binary bytes that report a pinned version on --version. */
export async function buildCloudflaredFixtureBinary(
  version: string,
): Promise<Uint8Array> {
  const script = `#!/bin/sh
case "$1" in
  --version)
    echo "cloudflared version ${version} (fixture)"
    exit 0
    ;;
esac
exit 0
`;
  const path = join(
    await Deno.makeTempDir({ prefix: "tp-cloudflared-" }),
    "cf",
  );
  await writeExecutable(path, script);
  try {
    return await Deno.readFile(path);
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

/** Minimal tar.gz archive for ensureGalaxyDockerRole install path tests. */
export async function buildGalaxyDockerFixtureArchive(
  version: string,
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "tp-galaxy-docker-" });
  try {
    const root = join(tmp, `ansible-role-docker-${version}`);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(join(root, "README.md"), "# fixture role\n");
    const archivePath = join(tmp, "archive.tar.gz");
    const cmd = new Deno.Command("tar", {
      args: ["-czf", archivePath, "-C", tmp, `ansible-role-docker-${version}`],
    });
    const output = await cmd.output();
    if (!output.success) {
      throw new Error("failed to build galaxy docker fixture archive");
    }
    return await Deno.readFile(archivePath);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function writeMatchingStamps(
  opts: OrchestrationSeedOptions,
): Promise<void> {
  if (!opts.withBootstrapStamp) return;
  const bootstrap = await import("../orchestration/bootstrap-stamp.ts");
  const stamp = await bootstrap.computeBootstrapStamp();
  await bootstrap.writeBootstrapStamp(stamp);
  if (opts.withGalaxyDockerRole) {
    const dockerStamp = await bootstrap.computeGalaxyDockerStamp();
    await bootstrap.writeGalaxyDockerStamp(dockerStamp);
  }
}

export async function writeOrchestrationBootstrapStamps(
  opts: Pick<
    OrchestrationSeedOptions,
    "withBootstrapStamp" | "withGalaxyDockerRole"
  >,
): Promise<void> {
  await writeMatchingStamps({
    withBootstrapStamp: opts.withBootstrapStamp,
    withGalaxyDockerRole: opts.withGalaxyDockerRole,
  });
}

export async function withOrchestrationRuntime<T>(
  opts: OrchestrationSeedOptions,
  fn: (fixture: OrchestrationRuntimeFixture) => Promise<T> | T,
): Promise<T> {
  const previous = snapshotEnv(ORCHESTRATION_RUNTIME_ENV_KEYS);
  const fixture = await createOrchestrationRuntimeFixture(opts);
  applyOrchestrationEnv(fixture.env);
  await writeMatchingStamps(opts);
  try {
    return await fn(fixture);
  } finally {
    restoreOrchestrationEnv(previous);
    await fixture.layout.cleanup();
  }
}
