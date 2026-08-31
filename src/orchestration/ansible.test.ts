import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import {
  buildTimeSyncApplyExtraArgs,
  devOwnershipPlaybookExtraArgs,
  galaxyBootstrapRunContext,
  mergeTimeSyncApplyWithHostState,
  parseGalaxyDockerRoleVersion,
} from "./ansible.ts";
import {
  DEV_CONVERGE_MANIFEST_FILE,
  devOrchestrationAnsibleEnv,
  resolveDevOrchestrationLayout,
} from "./dev-orchestration.ts";
import { setActiveInstallPresenter } from "./install-presenter-context.ts";
import { InstallPresenter } from "./install-presenter.ts";
import { presentStatusLine } from "./presentation.ts";
import {
  ANSIBLE_CFG,
  ANSIBLE_LOCAL_TMP,
  ANSIBLE_PLAYBOOK_CWD,
  ANSIBLE_SHELL_EXECUTABLE,
  ansibleEnv,
  DAEMON_ROOT,
  GALAXY_COLLECTIONS_DIR,
  GALAXY_ROLES_DIR,
  GALAXY_VENDOR_ROLES_DIR,
  RABBITMQ_PLAYBOOK,
  REDIS_PLAYBOOK,
} from "./paths.ts";

const VENDORED_COLLECTIONS_MARKER = "galaxy-collections";
const CHECKOUT_ORCHESTRATION_DIR = join(DAEMON_ROOT, "orchestration");

/** Minimal overlay layout for {@link resolveDevOrchestrationLayout} unit tests. */
async function makeDevOrchestrationFixture(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "tp-dev-orch-" });
  await Deno.writeTextFile(
    join(root, "ansible.cfg"),
    `[defaults]
host_key_checking = False
collections_path = /opt/turbopanel/vendor/ansible/galaxy-collections:/usr/share/ansible/collections
roles_path = roles
`,
  );
  await Deno.writeTextFile(
    join(root, DEV_CONVERGE_MANIFEST_FILE),
    `${
      JSON.stringify(
        {
          playbook: "playbooks/instance-dev-install.yml",
          roles: [],
          devRoles: [],
        },
        null,
        2,
      )
    }\n`,
  );
  await Deno.mkdir(join(root, "playbooks"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "playbooks", "instance-dev-install.yml"),
    `---
# Stub playbook for overlay-resolution unit tests only.
- hosts: localhost
  gather_facts: false
  tasks:
    - name: Fixture noop
      ansible.builtin.debug:
        msg: fixture
`,
  );
  return root;
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function assertMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${label}: expected ${pattern}, got:\n${value}`);
  }
}

function assertNotIn(
  value: Record<string, string>,
  key: string,
  label: string,
): void {
  if (key in value) {
    throw new Error(`${label}: did not expect ${key} to be set`);
  }
}

test("checked-in ansible.cfg defines vendored collections_path", async () => {
  const cfgPaths = [
    join(CHECKOUT_ORCHESTRATION_DIR, "ansible.cfg"),
  ];

  for (const cfgPath of cfgPaths) {
    const cfg = await Deno.readTextFile(cfgPath);
    assertMatch(
      cfg,
      /collections_path\s*=\s*[^\n]*galaxy-collections/,
      `collections_path in ${cfgPath}`,
    );
    assertMatch(
      cfg,
      /roles_path\s*=\s*[^\n]*galaxy-roles/,
      `roles_path galaxy-roles in ${cfgPath}`,
    );
    assertMatch(
      cfg,
      /^executable\s*=\s*\/bin\/bash\s*$/m,
      `executable /bin/bash in ${cfgPath} (Debian /bin/sh is dash)`,
    );
    assertMatch(
      cfg,
      /\/usr\/share\/ansible\/collections/,
      `system fallback collections_path in ${cfgPath}`,
    );
    const collectionsLine = cfg
      .split("\n")
      .find((line) => line.trimStart().startsWith("collections_path"));
    if (!collectionsLine) {
      throw new Error(`${cfgPath}: missing collections_path`);
    }
    if (collectionsLine.includes("~/.ansible")) {
      throw new Error(
        `${cfgPath}: collections_path must not include ~/.ansible (ANSIBLE_HOME is /tmp-scoped)`,
      );
    }
  }
});

test("cache install shell uses bash (Debian dash rejects pipefail)", async () => {
  const tasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/redis/tasks/main.yml"),
  );
  assertMatch(
    tasks,
    /executable:\s*\/bin\/bash/,
    "redis install executable",
  );
});

test(
  "turbopanel-instance.service.j2 loads runtime.env before runtime.dev-vars for Deno",
  async () => {
    const unitPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/turbopanel-instance.service.j2",
    );
    const unit = await Deno.readTextFile(unitPath);
    const envFile = "EnvironmentFile=-{{ turbopanel_instance_runtime_env }}";
    const devVarsFile =
      "EnvironmentFile=-{{ turbopanel_instance_runtime_dev_vars }}";
    const envIdx = unit.indexOf(envFile);
    const devIdx = unit.indexOf(devVarsFile);
    if (envIdx < 0) {
      throw new Error(`missing ${envFile} in ${unitPath}`);
    }
    if (devIdx < 0) {
      throw new Error(`missing ${devVarsFile} in ${unitPath}`);
    }
    if (envIdx >= devIdx) {
      throw new Error(
        `${unitPath}: runtime.env EnvironmentFile must precede runtime.dev-vars`,
      );
    }
    if (!unit.includes("Environment=TURBOPANEL_USER={{ turbopanel_user }}")) {
      throw new Error(
        `${unitPath}: must inject Environment=TURBOPANEL_USER={{ turbopanel_user }}`,
      );
    }
    // Gate runtime.env on non-workers so Deno/compiled get the metrics env.
    assertMatch(
      unit,
      /turbopanel_instance_runtime[\s\S]*!= 'workers'[\s\S]*EnvironmentFile=-\{\{\s*turbopanel_instance_runtime_env\s*\}\}/,
      "runtime.env EnvironmentFile gated to Deno/compiled",
    );
  },
);

test(
  "proxysql / orchestrator stack units never template a compose project name",
  async () => {
    // The ProxySQL and Orchestrator compose projects are the allocated
    // `managed-ingress` / `managed-ha` serviceIds, which Ansible cannot know at
    // converge time. The daemon writes them into each compose file's own
    // top-level `name:` key, so the units address compose by `-f <path>` alone.
    const templates = [
      "roles/proxysql/templates/turbopanel-proxysql-stack.service.j2",
      "roles/proxysql/templates/wait-ready.sh.j2",
      "roles/orchestrator/templates/turbopanel-orchestrator-stack.service.j2",
      "roles/orchestrator/templates/wait-ready.sh.j2",
    ];
    for (const relPath of templates) {
      const text = await Deno.readTextFile(
        join(CHECKOUT_ORCHESTRATION_DIR, relPath),
      );
      if (/docker compose[^\n]*\s-p\s/.test(text)) {
        throw new Error(`${relPath}: docker compose must not pass -p`);
      }
      if (text.includes("project_name")) {
        throw new Error(`${relPath}: must not reference a project name var`);
      }
      if (!text.includes("docker compose -f")) {
        throw new Error(`${relPath}: expected 'docker compose -f <path>'`);
      }
    }

    // …and the role defaults must not carry the retired vars either.
    for (
      const relPath of [
        "roles/proxysql/defaults/main.yml",
        "roles/orchestrator/defaults/main.yml",
      ]
    ) {
      const defaults = await Deno.readTextFile(
        join(CHECKOUT_ORCHESTRATION_DIR, relPath),
      );
      if (defaults.includes("project_name")) {
        throw new Error(`${relPath}: project name default must be removed`);
      }
    }
  },
);

test(
  "instance-launch env templates always set metrics retention (no enable/disable gate)",
  async () => {
    const templates = [
      "roles/instance-launch/templates/instance-deno.env.j2",
      "roles/instance-launch/templates/instance-workers.env.j2",
    ];
    for (const relPath of templates) {
      const templatePath = join(CHECKOUT_ORCHESTRATION_DIR, relPath);
      const template = await Deno.readTextFile(templatePath);
      assertMatch(
        template,
        /TURBOPANEL_SERVER_METRICS_RETENTION_DAYS=\{\{\s*turbopanel_server_metrics_retention_days \| default\(90\)\s*\}\}/,
        `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS in ${relPath}`,
      );
      if (template.includes("TURBOPANEL_SERVER_METRICS_ENABLED")) {
        throw new Error(
          `${relPath} must not expose TURBOPANEL_SERVER_METRICS_ENABLED (metrics are always on)`,
        );
      }
    }
  },
);

test("ansibleEnv pins ANSIBLE_HOME under /tmp without overriding collections_path", () => {
  const env = ansibleEnv();
  if (env.ANSIBLE_CONFIG !== ANSIBLE_CFG) {
    throw new Error(
      `expected ANSIBLE_CONFIG=${ANSIBLE_CFG}, got ${env.ANSIBLE_CONFIG}`,
    );
  }
  if (env.ANSIBLE_EXECUTABLE !== ANSIBLE_SHELL_EXECUTABLE) {
    throw new Error(
      `expected ANSIBLE_EXECUTABLE=${ANSIBLE_SHELL_EXECUTABLE}, got ${env.ANSIBLE_EXECUTABLE}`,
    );
  }
  if (env.ANSIBLE_HOME !== "/tmp/turbopanel-ansible") {
    throw new Error(
      `expected ANSIBLE_HOME=/tmp/turbopanel-ansible, got ${env.ANSIBLE_HOME}`,
    );
  }
  if (env.ANSIBLE_LOCAL_TEMP !== ANSIBLE_LOCAL_TMP) {
    throw new Error(
      `expected ANSIBLE_LOCAL_TEMP=${ANSIBLE_LOCAL_TMP}, got ${env.ANSIBLE_LOCAL_TEMP}`,
    );
  }
  assertNotIn(env, "ANSIBLE_COLLECTIONS_PATH", "ansibleEnv");
  if (
    env.ANSIBLE_ROLES_PATH !== `${GALAXY_ROLES_DIR}:${GALAXY_VENDOR_ROLES_DIR}`
  ) {
    throw new Error(
      `expected ANSIBLE_ROLES_PATH=${GALAXY_ROLES_DIR}:${GALAXY_VENDOR_ROLES_DIR}, got ${env.ANSIBLE_ROLES_PATH}`,
    );
  }
});

test("devOrchestrationAnsibleEnv selects overlay config without collections override", async () => {
  const fixtureRoot = await makeDevOrchestrationFixture();
  try {
    const layout = await resolveDevOrchestrationLayout({
      TURBOPANEL_DEV_ORCHESTRATION_DIR: fixtureRoot,
    });
    const env = devOrchestrationAnsibleEnv(layout);
    if (env.ANSIBLE_CONFIG !== layout.ansibleCfgPath) {
      throw new Error(
        `expected ANSIBLE_CONFIG=${layout.ansibleCfgPath}, got ${env.ANSIBLE_CONFIG}`,
      );
    }
    if (env.ANSIBLE_EXECUTABLE !== ANSIBLE_SHELL_EXECUTABLE) {
      throw new Error(
        `expected ANSIBLE_EXECUTABLE=${ANSIBLE_SHELL_EXECUTABLE}, got ${env.ANSIBLE_EXECUTABLE}`,
      );
    }
    assertNotIn(env, "ANSIBLE_COLLECTIONS_PATH", "devOrchestrationAnsibleEnv");
    const expectedRolesPath =
      `${layout.devRolesDir}:${layout.daemonRolesDir}:${GALAXY_VENDOR_ROLES_DIR}`;
    if (env.ANSIBLE_ROLES_PATH !== expectedRolesPath) {
      throw new Error(
        `expected ANSIBLE_ROLES_PATH=${expectedRolesPath}, got ${env.ANSIBLE_ROLES_PATH}`,
      );
    }
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

test("galaxyBootstrapRunContext matches playbook ansible contract", () => {
  const ctx = galaxyBootstrapRunContext();
  if (ctx.cwd !== ANSIBLE_PLAYBOOK_CWD) {
    throw new Error(
      `expected cwd=${ANSIBLE_PLAYBOOK_CWD}, got ${ctx.cwd}`,
    );
  }
  if (ctx.env.ANSIBLE_CONFIG !== ANSIBLE_CFG) {
    throw new Error(
      `expected ANSIBLE_CONFIG=${ANSIBLE_CFG}, got ${ctx.env.ANSIBLE_CONFIG}`,
    );
  }
  if (ctx.env.ANSIBLE_EXECUTABLE !== ANSIBLE_SHELL_EXECUTABLE) {
    throw new Error(
      `expected ANSIBLE_EXECUTABLE=${ANSIBLE_SHELL_EXECUTABLE}, got ${ctx.env.ANSIBLE_EXECUTABLE}`,
    );
  }
  if (ctx.env.ANSIBLE_HOME !== "/tmp/turbopanel-ansible") {
    throw new Error(
      `expected ANSIBLE_HOME=/tmp/turbopanel-ansible, got ${ctx.env.ANSIBLE_HOME}`,
    );
  }
  assertNotIn(ctx.env, "ANSIBLE_COLLECTIONS_PATH", "galaxyBootstrapRunContext");
});

test("requirements.yml pins ansible.posix to an exact version", async () => {
  const requirements = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "requirements.yml"),
  );
  assertMatch(
    requirements,
    /name:\s*ansible\.posix[\s\S]*version:\s*"\d+\.\d+\.\d+"/,
    "exact ansible.posix pin",
  );
  if (/version:\s*">=/.test(requirements)) {
    throw new Error("requirements.yml must not use ranged collection versions");
  }
  if (/geerlingguy\.docker/.test(requirements)) {
    throw new Error(
      "geerlingguy.docker must live in requirements-docker.yml (deferred), not bootstrap requirements.yml",
    );
  }
});

test("check-orchestration installs ansible.posix when the vendor tree is absent", async () => {
  const script = await Deno.readTextFile(
    join(DAEMON_ROOT, "scripts/check-orchestration.sh"),
  );
  if (!script.includes("ansible-galaxy collection install --force")) {
    throw new Error(
      "check-orchestration.sh must force-install into -p so galaxy cannot skip from another collections_path",
    );
  }
  if (!script.includes("orchestration/requirements.yml")) {
    throw new Error(
      "check-orchestration.sh must install from orchestration/requirements.yml",
    );
  }
  if (/-r[^\n]*requirements-docker\.yml/.test(script)) {
    throw new Error(
      "check-orchestration.sh must not install requirements-docker.yml (deferred Docker role)",
    );
  }
  if (!script.includes("ANSIBLE_COLLECTIONS_PATH")) {
    throw new Error(
      "check-orchestration.sh must set ANSIBLE_COLLECTIONS_PATH for pip-only CI",
    );
  }
  if (!script.includes("TURBOPANEL_RUNTIMES_DIR/ansible/galaxy-collections")) {
    throw new Error(
      "check-orchestration.sh must skip Galaxy when collections are already vendored",
    );
  }
  if (!script.includes("ansible_collections/ansible/posix")) {
    throw new Error(
      "check-orchestration.sh must verify ansible.posix landed in the install path",
    );
  }
  if (script.includes("/opt/turbopanel/vendor")) {
    throw new Error(
      "check-orchestration.sh must not hardcode /opt/turbopanel/vendor (use TURBOPANEL_RUNTIMES_DIR)",
    );
  }
  if (!script.includes('while [ "$attempt" -le 3 ]')) {
    throw new Error(
      "check-orchestration.sh must retry galaxy collection install (3 attempts)",
    );
  }
});

test("requirements-docker.yml pins geerlingguy.docker to an exact version", async () => {
  const requirements = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "requirements-docker.yml"),
  );
  assertMatch(
    requirements,
    /name:\s*geerlingguy\.docker[\s\S]*version:\s*"\d+\.\d+\.\d+"/,
    "exact geerlingguy.docker pin",
  );
  if (/version:\s*">=/.test(requirements)) {
    throw new Error(
      "requirements-docker.yml must not use ranged role versions",
    );
  }
});

test("parseGalaxyDockerRoleVersion reads the requirements-docker pin", async () => {
  const requirements = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "requirements-docker.yml"),
  );
  const version = parseGalaxyDockerRoleVersion(requirements);
  assertMatch(version, /^\d+\.\d+\.\d+$/, "geerlingguy.docker version pin");
  try {
    parseGalaxyDockerRoleVersion("roles: []\n");
    throw new Error("expected TypeError for missing pin");
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
  }
});

test("parseGalaxyDockerRoleVersion accepts spaced pins and rejects unquoted versions", () => {
  assertEquals(
    parseGalaxyDockerRoleVersion(
      '- name: geerlingguy.docker\n  src: ignored\n  version: "8.1.2"\n',
    ),
    "8.1.2",
  );
  try {
    parseGalaxyDockerRoleVersion(
      "- name: geerlingguy.docker\n  version: 8.1.2\n",
    );
    throw new TypeError("expected TypeError for unquoted version");
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
    assertEquals(
      err.message.includes("must pin geerlingguy.docker"),
      true,
    );
  }
});

test("ensureGalaxyDockerRole downloads via codeload, not ansible-galaxy role install", () => {
  const source = Deno.readTextFileSync(
    join(DAEMON_ROOT, "src", "orchestration", "ansible.ts"),
  );
  const start = source.indexOf(
    "async function installGalaxyDockerRoleFromArchive",
  );
  const end = source.indexOf("export async function runLocalhostTest", start);
  if (start < 0 || end < 0) {
    throw new Error(
      "could not locate installGalaxyDockerRoleFromArchive / runLocalhostTest",
    );
  }
  const dockerInstall = source.slice(start, end);
  if (!dockerInstall.includes("galaxyDockerRoleCodeloadUrl")) {
    throw new Error(
      "ensureGalaxyDockerRole must download via galaxyDockerRoleCodeloadUrl",
    );
  }
  if (/"role"\s*,\s*"install"/.test(dockerInstall)) {
    throw new Error(
      "ensureGalaxyDockerRole must not call ansible-galaxy role install",
    );
  }
  if (/github\.com\/.+\/archive\//.test(dockerInstall)) {
    throw new Error(
      "ensureGalaxyDockerRole must not use github.com/.../archive URLs",
    );
  }
  // Staging must share a filesystem with the final path — /tmp → /opt rename
  // fails with EXDEV on typical Vagrant guests.
  if (!dockerInstall.includes("dir: GALAXY_VENDOR_ROLES_DIR")) {
    throw new Error(
      "galaxy docker role staging must use makeTempDir({ dir: GALAXY_VENDOR_ROLES_DIR })",
    );
  }
});

test("galaxy docker lint neutralize silences third-party ansible-lint", () => {
  // Nested role .ansible-lint is the only path the IDE uses when a Galaxy file
  // is opened (exclude_paths do not apply to explicit lintables). Cover both
  // geerlingguy.docker/ and geerlingguy/docker/ layouts.
  const source = Deno.readTextFileSync(
    join(DAEMON_ROOT, "src", "orchestration", "ansible.ts"),
  );
  if (!source.includes("GALAXY_ROLE_ANSIBLE_LINT_CONFIG")) {
    throw new Error(
      "ansible.ts must define GALAXY_ROLE_ANSIBLE_LINT_CONFIG for ensureGalaxyDockerRole",
    );
  }
  for (
    const needle of [
      "no-free-form",
      "fqcn",
      "yaml",
      "offline: true",
      'Deno.remove(join(roleDir, ".yamllint"))',
      'join(GALAXY_VENDOR_ROLES_DIR, "geerlingguy.docker")',
      'join(GALAXY_VENDOR_ROLES_DIR, "geerlingguy", "docker")',
    ]
  ) {
    if (!source.includes(needle)) {
      throw new Error(
        `galaxy docker lint neutralize must include ${JSON.stringify(needle)}`,
      );
    }
  }
});

/**
 * Index of an awaited call in a script source, tolerating the injected-deps
 * form (`await deps.ensureAnsible()`) the orchestration script uses for its
 * test seams. Returns -1 when the call is absent.
 */
function awaitedCallIndex(source: string, fn: string): number {
  return source.search(new RegExp(`await (?:deps\\.)?${fn}\\(`));
}

test("TUI orchestration script emits dev_converge_skipped before expensive setup", () => {
  // instance-dev-install --if-needed must emit the skip JSONL event and return
  // before ensureAnsible / Galaxy / playbook when the stamp matches.
  const script = Deno.readTextFileSync(
    join(DAEMON_ROOT, "scripts", "run-orchestration-action.ts"),
  );
  if (!script.includes("emitDevConvergeSkippedIfNeeded")) {
    throw new Error(
      "run-orchestration-action.ts must use emitDevConvergeSkippedIfNeeded for --if-needed skip",
    );
  }
  const skipCall = awaitedCallIndex(script, "emitDevConvergeSkippedIfNeeded");
  const ensureAnsibleCall = awaitedCallIndex(script, "ensureAnsible");
  const galaxyCall = awaitedCallIndex(script, "ensureGalaxyDockerRole");
  const playbookCall = awaitedCallIndex(script, "runPlaybookStreaming");
  if (skipCall < 0 || ensureAnsibleCall < 0 || skipCall > ensureAnsibleCall) {
    throw new Error(
      "run-orchestration-action.ts must call emitDevConvergeSkippedIfNeeded before ensureAnsible()",
    );
  }
  if (galaxyCall < 0 || skipCall > galaxyCall) {
    throw new Error(
      "run-orchestration-action.ts must call emitDevConvergeSkippedIfNeeded before ensureGalaxyDockerRole()",
    );
  }
  if (playbookCall < 0 || skipCall > playbookCall) {
    throw new Error(
      "run-orchestration-action.ts must call emitDevConvergeSkippedIfNeeded before runPlaybookStreaming()",
    );
  }

  const helper = Deno.readTextFileSync(
    join(DAEMON_ROOT, "src", "orchestration", "converge-stamp.ts"),
  );
  if (!helper.includes('_event: "dev_converge_skipped"')) {
    throw new Error(
      'converge-stamp.ts must emit { _event: "dev_converge_skipped", reason } on skip',
    );
  }
});

test("TUI orchestration script fetches Docker Galaxy before docker-using playbooks", () => {
  // Dev console converge uses scripts/run-orchestration-action.ts — not
  // ansible.ts runInstanceDevInstall — so the script must call
  // ensureGalaxyDockerRole itself (bootstrap no longer installs the role).
  const script = Deno.readTextFileSync(
    join(DAEMON_ROOT, "scripts", "run-orchestration-action.ts"),
  );
  if (!script.includes("ensureGalaxyDockerRole")) {
    throw new Error(
      "run-orchestration-action.ts must call ensureGalaxyDockerRole before docker-using playbooks",
    );
  }
  if (!script.includes("quiet: true")) {
    throw new Error(
      "run-orchestration-action.ts must run playbooks with quiet: true for clean TUI JSONL",
    );
  }
  if (!script.includes("slimAnsibleEvent")) {
    throw new Error(
      "run-orchestration-action.ts must slim ansible events before emitting to the TUI",
    );
  }
  // instance-dev-install must ensure Galaxy *before* the playbook streams —
  // otherwise the TUI hits include_role: geerlingguy.docker with an empty tree.
  const ensureCall = awaitedCallIndex(script, "ensureGalaxyDockerRole");
  const playbookCall = awaitedCallIndex(script, "runPlaybookStreaming");
  if (ensureCall < 0 || playbookCall < 0 || ensureCall > playbookCall) {
    throw new Error(
      "run-orchestration-action.ts must await ensureGalaxyDockerRole() before runPlaybookStreaming()",
    );
  }
  for (
    const playbook of [
      "docker-setup.yml",
      "postgres-setup.yml",
      "rabbitmq-setup.yml",
    ]
  ) {
    if (!script.includes(`"${playbook}"`)) {
      throw new Error(
        `run-orchestration-action.ts must list ${playbook} in PLAYBOOKS_NEEDING_DOCKER_GALAXY`,
      );
    }
  }
});

test("daemon-run attaches Docker monitor via decideDockerMonitorAttach", () => {
  // Keep the startup path on the extracted decision helper so "skip when Docker
  // is not installed" stays enforced (partial-converge stuck-state fix).
  const source = Deno.readTextFileSync(
    join(DAEMON_ROOT, "src", "daemon-run.ts"),
  );
  if (!source.includes("decideDockerMonitorAttach")) {
    throw new Error(
      "daemon-run.ts must use decideDockerMonitorAttach for monitor attach",
    );
  }
  if (!source.includes("dockerBinaryPresent")) {
    throw new Error(
      "daemon-run.ts must consult dockerBinaryPresent before attaching the monitor",
    );
  }
  if (!source.includes("restoreFabricFromPersistedState")) {
    throw new Error(
      "daemon-run.ts must restore TurboFabric from state.json at startup",
    );
  }
  if (!source.includes("reinstallFabricForwardingIfEnabled")) {
    throw new Error(
      "daemon-run.ts must reinstall TP-FORWARD at startup when fabric is enabled",
    );
  }
  if (!source.includes("subscribeReachability")) {
    throw new Error(
      "daemon-run.ts must reinstall TP-FORWARD when Docker becomes reachable again",
    );
  }
});

test("galaxy collections install target matches cfg vendored path default", () => {
  if (!GALAXY_COLLECTIONS_DIR.endsWith(VENDORED_COLLECTIONS_MARKER)) {
    throw new Error(
      `expected GALAXY_COLLECTIONS_DIR to end with ${VENDORED_COLLECTIONS_MARKER}, got ${GALAXY_COLLECTIONS_DIR}`,
    );
  }
  if (!GALAXY_VENDOR_ROLES_DIR.endsWith("galaxy-roles")) {
    throw new Error(
      `expected GALAXY_VENDOR_ROLES_DIR to end with galaxy-roles, got ${GALAXY_VENDOR_ROLES_DIR}`,
    );
  }
});

test("setup playbook paths keep internal redis and rabbitmq identifiers", () => {
  assertEquals(REDIS_PLAYBOOK.endsWith("redis-setup.yml"), true);
  assertEquals(RABBITMQ_PLAYBOOK.endsWith("rabbitmq-setup.yml"), true);
});

test("converge setup status lines sanitize vendor tokens when presenter is active", () => {
  const samples = [
    "running redis-setup playbook",
    "redis-setup complete",
    "running rabbitmq-setup playbook",
    "rabbitmq-setup complete",
    "running daemon-converge playbook",
  ];

  setActiveInstallPresenter(null);
  for (const line of samples) {
    assertEquals(presentStatusLine(line), line, line);
  }

  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);
  try {
    assertEquals(
      presentStatusLine("running redis-setup playbook"),
      "running cache-setup playbook",
    );
    assertEquals(
      presentStatusLine("running rabbitmq-setup playbook"),
      "running queue-setup playbook",
    );
    assertEquals(
      presentStatusLine("running daemon-converge playbook"),
      "running daemon-converge playbook",
    );
  } finally {
    presenter.dispose();
    setActiveInstallPresenter(null);
  }
});

test("instance-repo install probes drizzle-kit not an empty node_modules symlink", async () => {
  const tasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/instance-repo/tasks/main.yml"),
  );
  assertMatch(
    tasks,
    /node_modules\/drizzle-kit\/bin\.cjs/,
    "instance-repo probes drizzle-kit",
  );
  assertMatch(
    tasks,
    /not _instance_drizzle_kit\.stat\.exists/,
    "instance-repo installs when drizzle-kit is missing",
  );
});

test("instance-migrate uses the dev-user HOME for pnpm", async () => {
  const tasks = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/tasks/instance-migrate.yml",
    ),
  );
  assertMatch(
    tasks,
    /HOME: "{{ turbopanel_dev_root if \(turbopanel_dev_user/,
    "instance-migrate HOME follows the co-located dev user",
  );
});

test(
  "instance-launch defaults production Caddyfile and static UI mode",
  async () => {
    const defaultsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/defaults/main.yml",
    );
    const caddyUnitPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/turbopanel-caddy.service.j2",
    );
    const defaults = await Deno.readTextFile(defaultsPath);
    const caddyUnit = await Deno.readTextFile(caddyUnitPath);

    assertMatch(
      defaults,
      /^\s*turbopanel_ui_mode:\s*static\s*$/m,
      "production default turbopanel_ui_mode is static",
    );
    assertMatch(
      defaults,
      /turbopanel_caddyfile:[\s\S]*?dev\/orchestration\/Caddyfile/,
      "turbopanel_caddyfile selects the dev overlay when turbopanel_dev_user is set",
    );
    assertMatch(
      defaults,
      /turbopanel_caddyfile:[\s\S]*?instance_dir ~ '\/Caddyfile'/,
      "turbopanel_caddyfile falls back to the instance checkout Caddyfile",
    );
    assertMatch(
      caddyUnit,
      /--config \{\{\s*turbopanel_caddyfile\s*\}\}/,
      "caddy unit uses turbopanel_caddyfile",
    );
    assertMatch(
      caddyUnit,
      /Environment=CADDY_TLS_CERT=\{\{\s*turbopanel_instance_dir\s*\}\}\/certs\/self-signed\.crt/,
      "caddy unit pins leaf cert to instance checkout (not Caddyfile-relative ./certs)",
    );
    assertMatch(
      caddyUnit,
      /Environment=CADDY_TLS_KEY=\{\{\s*turbopanel_instance_dir\s*\}\}\/certs\/self-signed\.key/,
      "caddy unit pins leaf key to instance checkout",
    );
    if (caddyUnit.includes("TURBOPANEL_DEV_HTTP_CONTROL_PLANE")) {
      throw new Error(
        `${caddyUnitPath}: Caddy unit must not set TURBOPANEL_DEV_HTTP_CONTROL_PLANE (client-only flag)`,
      );
    }
    // Production unit must not bake Expo/wrangler env outside the turbopanel_dev_user block.
    const prodEnvBlock = caddyUnit.split("{% if turbopanel_dev_user")[0] ??
      caddyUnit;
    for (
      const forbidden of [
        "CADDY_HTTP_PORT",
        "EXPO_PORT",
        "WRANGLER_DEV_PORT",
        "TURBOPANEL_UI_MODE",
        "TURBOPANEL_DAEMON_REPO",
      ]
    ) {
      if (prodEnvBlock.includes(forbidden)) {
        throw new Error(
          `${caddyUnitPath}: ${forbidden} must only appear inside the turbopanel_dev_user block`,
        );
      }
    }
  },
);

test(
  "instance-launch secret keyring templates, rotate gate, and mailer notify",
  async () => {
    const defaultsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/defaults/main.yml",
    );
    const tasksPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/tasks/main.yml",
    );
    const denoDevVarsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/instance-deno.dev-vars.j2",
    );
    const workersDevVarsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/instance-workers.dev-vars.j2",
    );

    const defaults = await Deno.readTextFile(defaultsPath);
    const tasks = await Deno.readTextFile(tasksPath);
    const denoDevVars = await Deno.readTextFile(denoDevVarsPath);
    const workersDevVars = await Deno.readTextFile(workersDevVarsPath);

    assertMatch(
      defaults,
      /^\s*turbopanel_instance_secret_rotate:\s*false\s*$/m,
      "rotation is opt-in and defaults to false",
    );
    assertMatch(
      tasks,
      /when:\s*turbopanel_instance_secret_rotate\s*\|\s*default\(false\)\s*\|\s*bool/,
      "rotation task is gated on turbopanel_instance_secret_rotate",
    );
    assertMatch(
      tasks,
      /path:\s*"\{\{\s*turbopanel_config_dir\s*\}\}\/instance\/\.instance_secrets"[\s\S]*?owner:\s*root[\s\S]*?group:\s*"\{\{\s*turbopanel_group\s*\}\}"[\s\S]*?mode:\s*"0640"/,
      ".instance_secrets hardened root:group 0640",
    );
    assertMatch(
      tasks,
      /name:\s*Install Deno runtime dev vars[\s\S]*?Restart turbopanel mailer/,
      "Deno dev-vars task notifies Restart turbopanel mailer",
    );

    for (
      const [label, body] of [
        ["instance-deno.dev-vars.j2", denoDevVars],
        ["instance-workers.dev-vars.j2", workersDevVars],
      ] as const
    ) {
      const pluralAssign = ["TURBOPANEL_SECRETS", "="].join("");
      assertMatch(
        body,
        new RegExp(
          `^${pluralAssign}\\{\\{\\s*turbopanel_instance_secrets\\s*\\}\\}\\s*$`,
          "m",
        ),
        `${label} emits ${pluralAssign.slice(0, -1)} when keyring is set`,
      );
      assertEquals(
        /(?:^|\n)TURBOPANEL_SECRET=/.test(body),
        false,
        `${label} must not emit legacy TURBOPANEL_SECRET`,
      );
    }
  },
);

test(
  "ui-build defaults turbopanel_ui_mode to static",
  async () => {
    const defaultsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/ui-build/defaults/main.yml",
    );
    const defaults = await Deno.readTextFile(defaultsPath);
    assertMatch(
      defaults,
      /^\s*turbopanel_ui_mode:\s*static\s*$/m,
      "ui-build production default turbopanel_ui_mode is static",
    );
  },
);

test("mergeTimeSyncApplyWithHostState preserves host NTP when command omits it", () => {
  const merged = mergeTimeSyncApplyWithHostState(
    { timezone: "America/Chicago" },
    {
      ntpEnabled: false,
      ntpServers: ["203.0.113.10"],
      fallbackNtpServers: ["time.cloudflare.com"],
    },
  );
  assertEquals(merged, {
    timezone: "America/Chicago",
    ntpEnabled: false,
    ntpServers: ["203.0.113.10"],
    ntpFallbackServers: ["time.cloudflare.com"],
  });
  assertEquals(
    mergeTimeSyncApplyWithHostState({ ntpEnabled: true }, {
      ntpEnabled: false,
      ntpServers: ["custom.example"],
    }),
    { ntpEnabled: true, ntpServers: ["custom.example"] },
  );
  assertEquals(
    mergeTimeSyncApplyWithHostState(
      { ntpServers: ["already.set"] },
      { ntpServers: ["host.example"] },
    ),
    { ntpServers: ["already.set"] },
  );
  assertEquals(
    mergeTimeSyncApplyWithHostState({}, { ntpServers: [] }),
    { ntpServers: [] },
  );
});

test("buildTimeSyncApplyExtraArgs preserves native list and boolean types", () => {
  const args = buildTimeSyncApplyExtraArgs({
    ntpEnabled: false,
    ntpServers: ["203.0.113.10", "0.debian.pool.ntp.org"],
    ntpFallbackServers: ["time.cloudflare.com"],
    timezone: "UTC",
  });
  assertEquals(args.length, 2);
  assertEquals(args[0], "-e");
  const parsed = JSON.parse(args[1]!);
  assertEquals(parsed, {
    turbopanel_timezone: "UTC",
    turbopanel_ntp_servers: ["203.0.113.10", "0.debian.pool.ntp.org"],
    turbopanel_ntp_fallback_servers: ["time.cloudflare.com"],
    turbopanel_ntp_enabled: false,
    turbopanel_apply_ntp_config: true,
  });
  assertEquals(typeof parsed.turbopanel_ntp_enabled, "boolean");
  assertEquals(Array.isArray(parsed.turbopanel_ntp_servers), true);
  const timezoneOnly = JSON.parse(
    buildTimeSyncApplyExtraArgs({ timezone: "UTC" })[1]!,
  );
  assertEquals(timezoneOnly.turbopanel_apply_ntp_config, false);
  assertEquals(buildTimeSyncApplyExtraArgs({}), []);
});

test("site apply playbooks vendor engines (never apt nginx/apache2)", async () => {
  const nginxPlaybook = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "playbooks/site-nginx-apply.yml"),
  );
  const apachePlaybook = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "playbooks/site-apache-apply.yml",
    ),
  );
  const olsPlaybook = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "playbooks/site-openlitespeed-apply.yml",
    ),
  );
  const caddyPlaybook = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "playbooks/site-caddy-apply.yml"),
  );

  // The site Caddy reuses the already-vendored binary: one download, two
  // processes. It must NOT provision the control-plane Caddy identity.
  assertEquals(caddyPlaybook.includes("name: caddy"), true);
  assertEquals(caddyPlaybook.includes("name: site-caddy"), true);
  assertEquals(caddyPlaybook.includes("web_service_key: caddy"), true);
  assertEquals(nginxPlaybook.includes("name: nginx"), true);
  assertEquals(apachePlaybook.includes("name: apache"), true);
  assertEquals(apachePlaybook.includes("name: php-fpm"), true);
  assertEquals(olsPlaybook.includes("name: openlitespeed"), true);

  // Distro package installs must stay gone — engines come from vendor roles.
  for (
    const [label, body] of [
      ["nginx", nginxPlaybook],
      ["apache", apachePlaybook],
      ["openlitespeed", olsPlaybook],
      ["caddy", caddyPlaybook],
    ] as const
  ) {
    if (/ansible\.builtin\.apt:/.test(body)) {
      throw new Error(
        `site ${label} playbook must not apt-install packages`,
      );
    }
    if (
      /\bname:\s*nginx\b/.test(body) && label === "nginx" && /apt:/.test(body)
    ) {
      throw new Error(
        "site nginx playbook must not apt install nginx",
      );
    }
    if (body.includes("apache2") || body.includes("libapache2-mod-php")) {
      throw new Error(
        `site ${label} playbook must not reference distro apache2 packages`,
      );
    }
  }

  const nginxDefaults = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/nginx/defaults/main.yml"),
  );
  const apacheDefaults = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/apache/defaults/main.yml"),
  );
  const phpFpmDefaults = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/php-fpm/defaults/main.yml"),
  );
  assertMatch(nginxDefaults, /nginx_version:\s*"1\.\d+\.\d+"/, "nginx pin");
  assertMatch(apacheDefaults, /apache_version:\s*"2\.\d+\.\d+"/, "apache pin");
  // php-fpm is the one component that is NOT vendored: it comes from Ondrej
  // Sury's Debian repo. So the series is the pin (there is no source-build
  // patch version), and the repo wiring must stay deb822 + Signed-By.
  assertMatch(
    phpFpmDefaults,
    /php_fpm_default_series:\s*"8\.\d+"/,
    "php-fpm default series",
  );
  // A list, not a pin: several series install side by side and the daemon
  // overrides this with the distinct series a deploy declared.
  assertMatch(
    phpFpmDefaults,
    /php_fpm_versions:\s*\[/,
    "php-fpm series list",
  );

  const phpFpmSeriesTasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/php-fpm/tasks/series.yml"),
  );
  // Re-validated inside the loop: the series is a path segment, a package
  // name, AND a systemd instance name.
  assertEquals(phpFpmSeriesTasks.includes("Validate the PHP series"), true);
  // The exec gate is the per-series entitlement group, never `tp`.
  assertEquals(
    phpFpmSeriesTasks.includes(
      "tpphp{{ php_fpm_series_item | replace('.', '') }}",
    ),
    true,
  );

  assertMatch(
    phpFpmDefaults,
    /php_fpm_sury_repo_url:\s*"https:\/\/packages\.sury\.org\/php"/,
    "php-fpm sury repo",
  );
  assertEquals(phpFpmDefaults.includes("php_fpm_version:"), false);

  const phpFpmTasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/php-fpm/tasks/main.yml"),
  );
  // apt-key and one-line `[signed-by=]` sources are both deprecated.
  assertEquals(phpFpmTasks.includes("apt_key"), false);
  assertEquals(phpFpmTasks.includes("sury-php.sources"), true);
  // Apt reads the list as root; a tenant does not need it.
  assertMatch(
    phpFpmTasks,
    /sury-php\.sources\n(?:.*\n)*?\s*mode: "0640"/,
    "sury sources mode",
  );

  const principalAccessTasks = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/principal-access/tasks/main.yml",
    ),
  );
  // sshd opens AuthorizedKeysFile as the account; traversal is an ACL, not a
  // world bit. The home root is the same pair: 0750 plus other:x (traverse
  // without list), never a 0751 world bit that trips ansible:S2612.
  assertMatch(
    principalAccessTasks,
    /mode: "0750"\n\s+loop:\n\s+- "{{ principal_access_keys_dir \| dirname }}"/,
    "authorized_keys directory mode",
  );
  assertEquals(principalAccessTasks.includes("ansible.posix.acl:"), true);
  // Fresh Debian hosts often omit Priority: optional `acl`; daemon-prereqs must
  // install setfacl before this role's ansible.posix.acl tasks (install failed
  // on "Grant SSH access groups traversal" without it).
  const daemonPrereqsTasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/daemon-prereqs/tasks/main.yml"),
  );
  assertMatch(
    daemonPrereqsTasks,
    /- acl\n/,
    "daemon-prereqs must install acl for principal-access setfacl",
  );
  assertEquals(
    principalAccessTasks.includes('mode: "0751"'),
    false,
    "principal home root must not use a world bit",
  );
  assertMatch(
    principalAccessTasks,
    /Tighten the principal home root[\s\S]*?mode: "0750"[\s\S]*?etype: other\n\s+permissions: x/,
    "principal home root traverse-only ACL",
  );
  // Sury ships its own unit; TurboPanel runs the same binary under its own.
  // Masked, not merely disabled — an apt upgrade re-enables a disabled unit.
  // Masking is per series now — sury ships one unit per phpX.Y-fpm package.
  assertMatch(
    phpFpmSeriesTasks,
    /masked:\s*true/,
    "sury unit masked per series",
  );

  // Additive install: a deploy that declares 8.4 must not stop 8.3, so the old
  // "disable every other series" task must stay gone.
  assertEquals(phpFpmTasks.includes("php8.3-fpm"), false);
  assertEquals(
    phpFpmTasks.includes("Remove obsolete single-series php-fpm layout"),
    true,
  );

  // The site Caddy is a distinct identity from tpcaddy (9993, control plane)
  // and from the root edge Caddy that owns public :80/:443.
  const webUserDefaults = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/web-service-user/defaults/main.yml",
    ),
  );
  assertMatch(
    webUserDefaults,
    /caddy:\n\s+user: tpcaddysite/,
    "site caddy user",
  );
  assertEquals(webUserDefaults.includes("uid: 9987"), true);
  // 9988 belongs to tpnodeapp; reusing it would collide.
  assertEquals(webUserDefaults.includes("uid: 9988"), false);

  const siteCaddyUnit = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/site-caddy/templates/turbopanel-site-caddy.service.j2",
    ),
  );
  assertEquals(
    siteCaddyUnit.includes("User={{ site_caddy_service_user }}"),
    true,
  );
  // Caddy writes its cert cache under $XDG_DATA_HOME even with auto_https off;
  // pin it so neither the unit nor a `sudo -u` validate falls back to a home
  // this account does not own.
  assertEquals(siteCaddyUnit.includes("XDG_DATA_HOME="), true);
  // It runs the already-vendored binary — one download, two processes.
  assertEquals(
    siteCaddyUnit.includes("{{ turbopanel_vendor_dir }}/caddy/current/caddy"),
    true,
  );

  const siteCaddyDefaults = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/site-caddy/defaults/main.yml"),
  );
  assertMatch(
    siteCaddyDefaults,
    /site_caddy_service_user:\s*tpcaddysite/,
    "site caddy service user",
  );
  // Three Caddy admin endpoints now exist (2019 dev control plane, 2029 edge,
  // 2039 sites); a collision crash-loops the unit.
  assertMatch(
    siteCaddyDefaults,
    /site_caddy_admin_addr:\s*"127\.0\.0\.1:2039"/,
    "site caddy admin port",
  );

  // A zero-match import glob is an error in Caddy, so the placeholder has to
  // exist or every `caddy validate` fails on a host with no sites yet.
  const siteCaddyTasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/site-caddy/tasks/main.yml"),
  );
  assertEquals(siteCaddyTasks.includes("00-empty.conf"), true);

  const nginxUnit = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/nginx/templates/turbopanel-nginx.service.j2",
    ),
  );
  const apacheUnit = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/apache/templates/turbopanel-apache.service.j2",
    ),
  );
  const phpFpmUnit = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/php-fpm/templates/turbopanel-php-fpm@.service.j2",
    ),
  );
  assertEquals(
    nginxUnit.includes("turbopanel_vendor_dir }}/nginx/current"),
    true,
  );
  assertEquals(
    apacheUnit.includes("turbopanel_vendor_dir }}/apache/current"),
    true,
  );
  // php-fpm is installed from sury, so the unit execs the apt binary, not a
  // vendored tree. Keep this in step with `phpFpmBinaryPath` in
  // `../deploy/site/engine-driver.ts`, which builds the same path for the
  // config test.
  assertEquals(phpFpmUnit.includes("turbopanel_vendor_dir }}/php/"), false);
  // `%i` is the systemd instance = the PHP series. One template, one master
  // per co-installed series.
  assertEquals(phpFpmUnit.includes("/usr/sbin/php-fpm%i"), true);
  assertEquals(phpFpmUnit.includes("Conflicts=php%i-fpm.service"), true);
  // The leading colon keeps sury's own conf.d (where every extension
  // registers) and appends ours after it. Without it PHP loads no extensions.
  assertEquals(
    phpFpmUnit.includes("PHP_INI_SCAN_DIR=:"),
    true,
  );
});

test("devOwnershipPlaybookExtraArgs emits user uid gid and root", () => {
  assertEquals(
    devOwnershipPlaybookExtraArgs({
      TURBOPANEL_DEV_USER: "vagrant",
      TURBOPANEL_DEV_UID: "1000",
      TURBOPANEL_DEV_GID: "1000",
      TURBOPANEL_DEV_ROOT: "/home/vagrant",
    }),
    [
      "-e",
      "turbopanel_dev_user=vagrant",
      "-e",
      "turbopanel_dev_uid=1000",
      "-e",
      "turbopanel_dev_gid=1000",
      "-e",
      "turbopanel_dev_root=/home/vagrant",
    ],
  );
  assertEquals(devOwnershipPlaybookExtraArgs({}), []);
  assertEquals(
    devOwnershipPlaybookExtraArgs({
      TURBOPANEL_DEV_USER: "vagrant",
      TURBOPANEL_DEV_ROOT: "  ",
    }),
    ["-e", "turbopanel_dev_user=vagrant"],
  );
});

test("instance-certs apply never passes a platform CA rotate flag", async () => {
  const playbook = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "playbooks/instance-certs-apply.yml"),
  );
  const tasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/instance-certs/tasks/main.yml"),
  );
  const defaults = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/instance-certs/defaults/main.yml"),
  );
  assertEquals(
    playbook.includes("TURBOPANEL_TLS_CA_ROTATE"),
    false,
    "instance-certs-apply.yml must not rotate the platform CA",
  );
  assertEquals(
    tasks.includes("TURBOPANEL_TLS_CA_ROTATE:"),
    false,
    "instance-certs role must not pass TURBOPANEL_TLS_CA_ROTATE",
  );
  assertMatch(
    defaults,
    /turbopanel_instance_ca_dir:\s*"\{\{\s*turbopanel_state_dir\s*\}\}\/tls"/,
    "durable platform CA dir",
  );
  assertMatch(tasks, /TURBOPANEL_TLS_CA:/, "pass TURBOPANEL_TLS_CA");
  assertMatch(
    tasks,
    /TURBOPANEL_TLS_CA_BUNDLE:/,
    "pass TURBOPANEL_TLS_CA_BUNDLE",
  );
});

test("docker-backed optional roles gate readiness and stop disabled containers", async () => {
  const roles = [
    {
      role: "mailpit",
      optionalVar: "turbopanel_optional_mailpit",
      containers: ["mailpit_container_name"],
    },
    {
      role: "redis-insight",
      optionalVar: "turbopanel_optional_redis_insight",
      containers: [
        "redis_insight_bridge_container_name",
        "redis_insight_container_name",
      ],
    },
  ] as const;

  for (const { role, optionalVar, containers } of roles) {
    const tasks = await Deno.readTextFile(
      join(CHECKOUT_ORCHESTRATION_DIR, `roles/${role}/tasks/main.yml`),
    );
    assertEquals(
      tasks.includes(`when: ${optionalVar}`),
      true,
      `${role}: gate wrapper-start on ${optionalVar}`,
    );
    assertEquals(
      tasks.includes("wrapper-start.sh"),
      true,
      `${role}: install wrapper-start.sh`,
    );
    assertEquals(
      tasks.includes('argv: [docker, update, "--restart=no"'),
      true,
      `${role}: disable restart when optional off`,
    );
    assertEquals(
      tasks.includes("argv: [docker, stop,"),
      true,
      `${role}: stop container when optional off`,
    );
    for (const container of containers) {
      assertEquals(
        tasks.includes(`"{{ ${container} }}"`),
        true,
        `${role}: reference ${container}`,
      );
    }
  }
});
