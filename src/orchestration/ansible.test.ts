import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import {
  buildDockerSetupExtraArgs,
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
} from "./assets.ts";

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

test("entry run attaches Docker monitor via decideDockerMonitorAttach", () => {
  // Keep the startup path on the extracted decision helper so "skip when Docker
  // is not installed" stays enforced (partial-converge stuck-state fix).
  const source = Deno.readTextFileSync(
    join(DAEMON_ROOT, "src", "entry", "run.ts"),
  );
  if (!source.includes("decideDockerMonitorAttach")) {
    throw new Error(
      "entry/run.ts must use decideDockerMonitorAttach for monitor attach",
    );
  }
  if (!source.includes("dockerBinaryPresent")) {
    throw new Error(
      "entry/run.ts must consult dockerBinaryPresent before attaching the monitor",
    );
  }
  if (!source.includes("restoreFabricFromPersistedState")) {
    throw new Error(
      "entry/run.ts must restore TurboFabric from state.json at startup",
    );
  }
  if (!source.includes("reinstallFabricForwardingIfEnabled")) {
    throw new Error(
      "entry/run.ts must reinstall TP-FORWARD at startup when fabric is enabled",
    );
  }
  if (!source.includes("subscribeReachability")) {
    throw new Error(
      "entry/run.ts must reinstall TP-FORWARD when Docker becomes reachable again",
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
      /turbopanel_caddyfile:[\s\S]*?turbopanel_config_dir ~ '\/caddy\/Caddyfile'/,
      "turbopanel_caddyfile falls back to the rendered site config under the platform config dir",
    );
    assertEquals(
      defaults.includes("turbopanel_caddyfile_dir"),
      false,
      "no Caddyfile is read from the release package any more (it is rendered)",
    );
    assertEquals(
      /Caddyfile\.acme/.test(defaults),
      false,
      "the static Caddyfile.acme sibling is gone — lets_encrypt is a branch of Caddyfile.j2",
    );
    // The instance package lies flat in the install root; the instance "dir"
    // a managed host hands the roles is the install root itself, and the
    // binary is bin/turbopanel-instance beside turbopaneld.
    assertMatch(
      defaults,
      /turbopanel_instance_dir:[\s\S]*?else turbopanel_install_root/,
      "managed turbopanel_instance_dir is the install root",
    );
    assertMatch(
      defaults,
      /turbopanel_instance_binary:[\s\S]*?turbopanel_install_root ~ '\/bin\/turbopanel-instance'/,
      "managed turbopanel_instance_binary is bin/turbopanel-instance under the install root",
    );
    assertMatch(
      defaults,
      /turbopanel_instance_run_mode:[\s\S]*?'source' if \(turbopanel_dev_user[\s\S]*?else 'compiled'/,
      "run mode defaults to compiled on a managed host (instance-certs-apply runs with defaults only)",
    );
    assertMatch(
      defaults,
      /turbopanel_duckdb_lib_dir:[\s\S]*?else turbopanel_lib_dir/,
      "managed LD_LIBRARY_PATH is lib/ (the package ships libduckdb.so there)",
    );
    assertEquals(
      defaults.includes("lib/instance"),
      false,
      "no nested lib/instance tree",
    );
    assertMatch(
      caddyUnit,
      /--config \{\{\s*turbopanel_caddyfile\s*\}\}/,
      "caddy unit uses turbopanel_caddyfile",
    );
    // The leaf's home follows the run mode (instance-runtime-packaging): the
    // checkout's certs/ in source mode, <state>/tls/certs in compiled mode —
    // the compiled binary can only write its state tree. Never
    // Caddyfile-relative ./certs.
    assertMatch(
      caddyUnit,
      /Environment=CADDY_TLS_CERT=\{\{\s*turbopanel_instance_certs_dir\s*\}\}\/self-signed\.crt/,
      "caddy unit pins leaf cert to turbopanel_instance_certs_dir",
    );
    assertMatch(
      caddyUnit,
      /Environment=CADDY_TLS_KEY=\{\{\s*turbopanel_instance_certs_dir\s*\}\}\/self-signed\.key/,
      "caddy unit pins leaf key to turbopanel_instance_certs_dir",
    );
    assertMatch(
      defaults,
      /turbopanel_instance_certs_dir:[\s\S]*?turbopanel_state_dir ~ '\/tls\/certs'[\s\S]*?turbopanel_instance_dir ~ '\/certs'/,
      "turbopanel_instance_certs_dir is <state>/tls/certs in compiled mode and <checkout>/certs in source mode",
    );
    assertMatch(
      defaults,
      /^\s*turbopanel_tls_mode:\s*self_signed\s*$/m,
      "production default turbopanel_tls_mode is self_signed",
    );
    // The rendered Caddyfile is one template whose branches are the TLS modes.
    const tasks = await Deno.readTextFile(
      join(CHECKOUT_ORCHESTRATION_DIR, "roles/instance-launch/tasks/main.yml"),
    );
    assertMatch(
      tasks,
      /- name: Render the Caddy site config\n\s+when: turbopanel_dev_user \| default\(''\) \| length == 0\n\s+ansible\.builtin\.template:\n\s+src: Caddyfile\.j2\n\s+dest: "\{\{ turbopanel_caddyfile \}\}"[\s\S]*?notify:\n\s+- Restart turbopanel caddy/,
      "instance-launch renders Caddyfile.j2 to turbopanel_caddyfile on managed hosts and restarts Caddy on change",
    );
    const caddyfile = await Deno.readTextFile(
      join(
        CHECKOUT_ORCHESTRATION_DIR,
        "roles/instance-launch/templates/Caddyfile.j2",
      ),
    );
    for (const prefix of ["/api/*", "/ws/*", "/webhook/*"]) {
      assertEquals(
        caddyfile.includes(`path ${prefix}`),
        true,
        `Caddyfile.j2 forwards ${prefix} ahead of the SPA catch-all`,
      );
    }
    assertEquals(
      caddyfile.lastIndexOf("path /webhook/*") <
        caddyfile.lastIndexOf("try_files {path} /index.html"),
      true,
      "the SPA catch-all is the last handle",
    );
    assertMatch(
      caddyfile,
      /\{% if _tls_mode == 'lets_encrypt' %\}[\s\S]*?\{% if turbopanel_acme_email \| default\(''\) \| length > 0 %\}\n\s+email \{\{ turbopanel_acme_email \}\}\n\{% endif %\}\n\{% else %\}[\s\S]*?auto_https off\n\{% endif %\}/,
      "lets_encrypt gets an optional email directive; every other mode keeps auto_https off",
    );
    assertMatch(
      caddyfile,
      /\{% if _tls_mode == 'lets_encrypt' %\}\n[^\n]*\n[^\n]*\n\{\{ turbopanel_public_hostname \}\} \{\n\{% else %\}\n[^\n]*\n:\{\{ caddy_port \| default\(8443\) \}\} \{\n\s+tls \{\{ _certs_dir \}\}\/\{\{ _leaf \}\}\.crt \{\{ _certs_dir \}\}\/\{\{ _leaf \}\}\.key\n\{% endif %\}/,
      "lets_encrypt binds the public hostname with no tls line; the other modes bind the port with the leaf from turbopanel_instance_certs_dir",
    );
    assertMatch(
      caddyfile,
      /_leaf = 'uploaded' if _tls_mode == 'upload' else 'self-signed'/,
      "upload serves the operator pair, self_signed the platform-CA leaf",
    );
    assertEquals(
      (caddyfile.match(
        /reverse_proxy unix\/\{\{ turbopanel_run_dir \}\}\/instance\.sock/g,
      ) ?? []).length,
      3,
      "all three instance prefixes dial unix/<run dir>/instance.sock",
    );
    assertMatch(
      caddyfile,
      /root \* \{\{ turbopanel_ui_dist_dir \}\}/,
      "the catch-all serves turbopanel_ui_dist_dir",
    );
    assertEquals(
      /\{\$[A-Z_]+/.test(caddyfile),
      false,
      "values are baked at render time — no Caddy env placeholders",
    );
    assertMatch(
      caddyUnit,
      /lets_encrypt[\s\S]*?Environment=CADDY_PORT=443/,
      "lets_encrypt Caddy unit binds :443",
    );
    assertMatch(
      caddyUnit,
      /lets_encrypt[\s\S]*?AmbientCapabilities=CAP_NET_BIND_SERVICE/,
      "lets_encrypt Caddy unit grants CAP_NET_BIND_SERVICE",
    );
    assertMatch(
      caddyUnit,
      /lets_encrypt[\s\S]*?CapabilityBoundingSet=CAP_NET_BIND_SERVICE/,
      "lets_encrypt Caddy unit bounds CAP_NET_BIND_SERVICE",
    );
    const withoutLetsEncrypt = caddyUnit.replace(
      /\{%\s*if\s+turbopanel_tls_mode[\s\S]*?lets_encrypt[\s\S]*?\{%\s*elif\s/g,
      "{% elif ",
    );
    assertEquals(
      withoutLetsEncrypt.includes("AmbientCapabilities"),
      false,
      "AmbientCapabilities only appear inside the lets_encrypt branch",
    );
    assertEquals(
      withoutLetsEncrypt.includes("CapabilityBoundingSet"),
      false,
      "CapabilityBoundingSet only appear inside the lets_encrypt branch",
    );
    assertEquals(
      caddyUnit.includes("TURBOPANEL_CADDY_ACME_EMAIL_DIRECTIVE"),
      false,
      "the ACME contact is rendered into the Caddyfile, not smuggled through the unit env",
    );

    const denoEnv = await Deno.readTextFile(
      join(
        CHECKOUT_ORCHESTRATION_DIR,
        "roles/instance-launch/templates/instance-deno.env.j2",
      ),
    );
    const workersEnv = await Deno.readTextFile(
      join(
        CHECKOUT_ORCHESTRATION_DIR,
        "roles/instance-launch/templates/instance-workers.env.j2",
      ),
    );
    assertMatch(
      denoEnv,
      /turbopanel_tls_public_effective[\s\S]*?TURBOPANEL_TLS_PUBLIC=1/,
      "instance-deno.env.j2 gates TURBOPANEL_TLS_PUBLIC on turbopanel_tls_public_effective",
    );
    assertEquals(
      workersEnv.includes("TURBOPANEL_TLS_PUBLIC"),
      false,
      "instance-workers.env.j2 must not emit TURBOPANEL_TLS_PUBLIC",
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
    const launchTasksForStripe = await Deno.readTextFile(
      join(CHECKOUT_ORCHESTRATION_DIR, "roles/instance-launch/tasks/main.yml"),
    );
    assertEquals(
      launchTasksForStripe.includes("dev/local/stripe.env"),
      true,
      "co-located dev seeds the protected Stripe files from the mounted dev checkout",
    );
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
      defaults,
      /^\s*turbopanel_instance_secret_escrow_path:\s*""\s*$/m,
      "off-host escrow is opt-in and defaults to empty (skipped)",
    );
    assertMatch(
      tasks,
      /when:\s*turbopanel_instance_secret_escrow_path\s*\|\s*default\('\s*'\)\s*\|\s*length\s*>\s*0/,
      "escrow task is gated on turbopanel_instance_secret_escrow_path",
    );
    assertMatch(
      tasks,
      /ansible\.builtin\.fetch:[\s\S]*?src:\s*"\{\{\s*turbopanel_config_dir\s*\}\}\/instance\/\.instance_secrets"[\s\S]*?dest:\s*"\{\{\s*turbopanel_instance_secret_escrow_path\s*\}\}"[\s\S]*?flat:\s*true/,
      "escrow task fetches .instance_secrets to the operator-supplied controller path",
    );
    // `fetch` accepts a `mode` and ignores it — proven on a real converge
    // 2026-09-18, where the escrowed copy of the single root of trust landed
    // 0644. The follow-up task is what actually restricts it, on the
    // controller, where the file is.
    assertMatch(
      tasks,
      /name:\s*Restrict the escrowed keyring copy to its owner[\s\S]*?delegate_to:\s*localhost[\s\S]*?ansible\.builtin\.file:[\s\S]*?path:\s*"\{\{\s*_instance_secrets_escrow\.dest\s*\}\}"[\s\S]*?mode:\s*"0600"/,
      "escrowed keyring copy is chmodded 0600 on the controller",
    );
    assertEquals(
      /ansible\.builtin\.fetch:[\s\S]{0,300}?mode:/.test(tasks),
      false,
      "fetch carries no mode — it would be silently ignored",
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
      const singularAssign = ["TURBOPANEL_SECRET", "="].join("");
      assertEquals(
        new RegExp(`(?:^|\\n)${singularAssign}`).test(body),
        false,
        `${label} must not emit legacy ${singularAssign.slice(0, -1)}`,
      );
    }
  },
);

test(
  "system-compose Postgres backup: defaults, gate, script shape, and systemd units",
  async () => {
    const defaultsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/system-compose/defaults/main.yml",
    );
    const tasksPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/system-compose/tasks/main.yml",
    );
    const scriptPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/system-compose/templates/postgres-backup.sh.j2",
    );
    const timerPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/system-compose/templates/turbopanel-postgres-backup.timer.j2",
    );
    const servicePath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/system-compose/templates/turbopanel-postgres-backup.service.j2",
    );

    const defaults = await Deno.readTextFile(defaultsPath);
    const tasks = await Deno.readTextFile(tasksPath);
    const script = await Deno.readTextFile(scriptPath);
    const timer = await Deno.readTextFile(timerPath);
    const service = await Deno.readTextFile(servicePath);

    assertMatch(
      defaults,
      /^\s*postgres_backup_enabled:\s*true\s*$/m,
      "nightly backup is on by default — this DB holds every org's secrets",
    );
    assertMatch(
      defaults,
      /^\s*postgres_backup_retention_keep:\s*14\s*$/m,
      "retention defaults to 14 dumps",
    );
    assertMatch(
      defaults,
      /^\s*postgres_backup_remote_destination:\s*""\s*$/m,
      "off-host push is opt-in and defaults to empty (local-only)",
    );
    assertMatch(
      tasks,
      /name:\s*Install Postgres backup script[\s\S]*?when:[\s\S]*?_system_compose_database_active \| bool[\s\S]*?postgres_backup_enabled \| bool/,
      "backup script install is gated on the database being active and the feature being enabled",
    );
    assertMatch(
      tasks,
      /name:\s*Ensure Postgres backup timer desired state[\s\S]*?name:\s*turbopanel-postgres-backup\.timer[\s\S]*?enabled:\s*true[\s\S]*?state:\s*started/,
      "backup timer is enabled and started once installed",
    );

    assertMatch(
      script,
      /pg_dump -Fc -U "\$db_user" -d "\$db_name" > "\$tmp"/,
      "dumps in custom format (already compressed) to a .part file, never the final path directly",
    );
    assertMatch(
      script,
      /mv -- "\$tmp" "\$dest"/,
      "atomic rename from .part to the final dump path",
    );
    assertEquals(
      script.includes("PGPASSWORD"),
      false,
      "no password handling — pg_dump runs inside the container over its default local trust connection, matching managed/engines/postgres.ts's dumpArgv",
    );
    assertMatch(
      script,
      /retention_keep \+ 1/,
      "retention pruning keeps the newest N dumps and deletes the rest",
    );
    assertMatch(
      script,
      /if \[ -n "\$remote_destination" \]; then\s*\n\s*rsync/,
      "off-host push only runs when a remote destination was configured",
    );

    assertMatch(
      timer,
      /OnCalendar=\{\{ postgres_backup_oncalendar \}\}/,
      "backup cadence is configurable, not hardcoded in the timer unit",
    );
    assertMatch(
      timer,
      /Persistent=true/,
      "a missed nightly run (host down at 03:00) still fires on next boot",
    );
    assertMatch(
      service,
      /Requires=\{\{ system_compose_service_name \}\}\.service/,
      "backup service requires the compose stack it dumps from",
    );
  },
);

test(
  "system-compose CIS hardening: cap_drop, no-new-privileges, read_only, resource ceiling, healthcheck",
  async () => {
    const composeTemplatePath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/system-compose/templates/docker-compose.yml.j2",
    );
    const postgresDefaultsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/postgres/defaults/main.yml",
    );
    const rabbitmqDefaultsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/rabbitmq/defaults/main.yml",
    );

    const compose = await Deno.readTextFile(composeTemplatePath);
    const postgresDefaults = await Deno.readTextFile(postgresDefaultsPath);
    const rabbitmqDefaults = await Deno.readTextFile(rabbitmqDefaultsPath);

    for (const service of ["database", "queue"] as const) {
      const databaseStart = compose.indexOf("  database:");
      const queueStart = compose.indexOf("  queue:");
      const topLevelNetworksStart = compose.indexOf("\nnetworks:\n");
      const serviceBlock = service === "database"
        ? compose.slice(databaseStart, queueStart)
        : compose.slice(queueStart, topLevelNetworksStart);
      assertMatch(
        serviceBlock,
        /cap_drop:\s*\n\s*- ALL/,
        `${service} drops all Linux capabilities`,
      );
      assertMatch(
        serviceBlock,
        /security_opt:\s*\n\s*- no-new-privileges:true/,
        `${service} refuses privilege escalation`,
      );
      assertMatch(
        serviceBlock,
        /read_only:\s*true/,
        `${service} runs with a read-only root filesystem`,
      );
      assertMatch(
        serviceBlock,
        /tmpfs:\s*\n\s*- \/tmp/,
        `${service} gets a writable /tmp via tmpfs, not the rootfs`,
      );
      assertMatch(
        serviceBlock,
        /mem_limit:\s*\{\{ \w+_container_mem_limit \}\}/,
        `${service} has a configurable memory ceiling`,
      );
      assertMatch(
        serviceBlock,
        /pids_limit:\s*\{\{ \w+_container_pids_limit \}\}/,
        `${service} has a configurable pids ceiling`,
      );
      assertMatch(
        serviceBlock,
        /healthcheck:\s*\n\s*test:/,
        `${service} has a healthcheck, so a degraded-but-running container is noticed`,
      );
    }
    assertMatch(
      compose,
      /test: \["CMD", "pg_isready", "-U", "\{\{ postgres_user \}\}"\]/,
      "database healthcheck reuses the same pg_isready command the readiness-wait script already uses",
    );
    assertMatch(
      compose,
      /test: \["CMD", "rabbitmq-diagnostics", "-q", "ping"\]/,
      "queue healthcheck reuses the same rabbitmq-diagnostics command the readiness-wait script already uses",
    );

    assertMatch(
      postgresDefaults,
      /^\s*postgres_container_mem_limit:\s*512m\s*$/m,
      "postgres container memory ceiling defaults to 512m",
    );
    assertMatch(
      postgresDefaults,
      /^\s*postgres_container_pids_limit:\s*200\s*$/m,
      "postgres container pids ceiling defaults to 200",
    );
    assertMatch(
      rabbitmqDefaults,
      /^\s*rabbitmq_container_mem_limit:\s*512m\s*$/m,
      "rabbitmq container memory ceiling defaults to 512m",
    );
    assertMatch(
      rabbitmqDefaults,
      /^\s*rabbitmq_container_pids_limit:\s*200\s*$/m,
      "rabbitmq container pids ceiling defaults to 200",
    );
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

  // The global `metrics` option is what actually exposes `/metrics` on the
  // admin listener — `servers { metrics }` alone only turns on per-server
  // instrumentation and leaves `/metrics` 404, which would silently strand
  // the daemon's traffic collector (`src/metrics/collector/ingress/caddy.ts`).
  const siteCaddyfile = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/site-caddy/templates/Caddyfile.j2"),
  );
  assertMatch(
    siteCaddyfile,
    /^\tmetrics$/m,
    "site Caddyfile enables the global metrics option",
  );
  assertMatch(
    siteCaddyfile,
    /servers\s*\{\s*metrics\s*\}/,
    "site Caddyfile keeps per-server metrics instrumentation on",
  );

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

test("stripe-listen role is unit-only, gated on its optional var, and never re-templates stripe.env", async () => {
  const tasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/stripe-listen/tasks/main.yml"),
  );
  assertEquals(
    tasks.includes("turbopanel_optional_stripe_listen | default(false) | bool"),
    true,
    "stripe-listen: unit state follows turbopanel_optional_stripe_listen, default off",
  );
  assertEquals(
    tasks.includes("wrapper-start.sh"),
    true,
    "stripe-listen: install wrapper-start.sh",
  );
  assertEquals(
    tasks.includes("force: false"),
    true,
    "stripe-listen: stripe.env is seeded once, never overwritten",
  );
  assertEquals(tasks.includes("docker"), false, "stripe-listen: no container");
  assertEquals(
    tasks.includes("stripe-cli/{{ stripe_cli_version }}/stripe"),
    true,
    "stripe-listen: vendors the pinned binary under vendor/stripe-cli/<version>/",
  );
  const wrapper = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/stripe-listen/templates/stripe-listen-wrapper-start.sh.j2",
    ),
  );
  assertEquals(
    wrapper.includes("listen --print-secret"),
    true,
    "wrapper: reads the forwarding secret deterministically",
  );
  assertEquals(
    wrapper.includes("TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET="),
    true,
    "wrapper: writes the signing secret",
  );
  assertEquals(
    wrapper.includes("--api-key"),
    false,
    "wrapper: the key never appears in argv",
  );
  assertEquals(
    wrapper.includes("--skip-verify"),
    true,
    "wrapper: Caddy is self-signed on the dev listener",
  );
  // `wrangler dev` never fires the Worker's cron, so the Workers dev runtime
  // ships a minutely timer that hits wrangler's local trigger endpoint —
  // without it the offline sweep and the billing chores never run in dev.
  const cronService = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/turbopanel-instance-cron.service.j2",
    ),
  );
  assertEquals(
    cronService.includes("/cdn-cgi/local/scheduled"),
    true,
    "cron oneshot: hits wrangler's local scheduled trigger",
  );
  assertEquals(
    cronService.includes("{{ wrangler_dev_port }}"),
    true,
    "cron oneshot: uses the configured wrangler port",
  );
  const cronTimer = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/turbopanel-instance-cron.timer.j2",
    ),
  );
  assertEquals(
    cronTimer.includes("OnCalendar=*-*-* *:*:00"),
    true,
    "cron timer: every minute, like the deployed trigger",
  );
  const launchTasks = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "roles/instance-launch/tasks/main.yml"),
  );
  assertEquals(
    /Install Workers dev cron trigger units\n {2}when: \(turbopanel_instance_runtime \| default\('deno'\)\) == 'workers'/
      .test(launchTasks),
    true,
    "cron units are installed only on the Workers runtime",
  );
  // The Workers dev instance takes its Stripe values from two by-hand files
  // under the protected config dir, so a re-converge keeps them; the Deno
  // dev-vars template must never carry them.
  const workersDevVars = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/instance-workers.dev-vars.j2",
    ),
  );
  assertEquals(
    workersDevVars.includes("TURBOPANEL_STRIPE_SECRET_KEY="),
    true,
    "workers dev vars: secret key line",
  );
  assertEquals(
    workersDevVars.includes("TURBOPANEL_STRIPE_WEBHOOK_SIGNING_SECRET="),
    true,
    "workers dev vars: signing secret line",
  );
  const denoDevVars = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/instance-deno.dev-vars.j2",
    ),
  );
  assertEquals(
    denoDevVars.includes("TURBOPANEL_STRIPE"),
    false,
    "deno dev vars: no Stripe, self-hosted has no billing",
  );
  const instanceUnit = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/turbopanel-instance.service.j2",
    ),
  );
  // Billing is Workers-only and self-hosted Deno has no billing surface, so
  // the instance unit must never hand the instance a Stripe key.
  assertEquals(
    instanceUnit.includes("stripe-listen/stripe.env"),
    false,
    "instance unit does not load stripe.env: a Deno instance must never see a Stripe key",
  );
  assertEquals(
    instanceUnit.includes("TURBOPANEL_STRIPE"),
    false,
    "instance unit sets no Stripe variables",
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

test("docker role merges daemon.json address pools and live-restore, skipping the restart on a co-located instance host", async () => {
  const roleDir = join(CHECKOUT_ORCHESTRATION_DIR, "roles/docker");
  const main = await Deno.readTextFile(join(roleDir, "tasks/main.yml"));
  const daemonJson = await Deno.readTextFile(
    join(roleDir, "tasks/daemon-json.yml"),
  );
  const handlers = await Deno.readTextFile(join(roleDir, "handlers/main.yml"));
  const defaults = await Deno.readTextFile(join(roleDir, "defaults/main.yml"));

  // Included whenever the master switch is on — no longer gated on the
  // address pools being non-empty, since the merge also owns live-restore,
  // which every host should carry regardless of org address-pool usage.
  assertEquals(main.includes("include_tasks: daemon-json.yml"), true);
  assertEquals(
    main.includes("turbopanel_docker_manage_daemon_json | bool"),
    true,
  );
  assertEquals(
    main.includes("(turbopanel_docker_address_pools | length > 0)"),
    false,
    "the pools-non-empty gate was removed — the merge always runs",
  );
  // Defaults are empty so an unrelated converge writes nothing beyond
  // live-restore (a real diff only on the very first run).
  assertEquals(defaults.includes("turbopanel_docker_address_pools: []"), true);
  assertEquals(
    defaults.includes('turbopanel_docker_default_bridge_cidr: ""'),
    true,
  );
  assertEquals(
    defaults.includes("turbopanel_docker_clear_addressing: false"),
    true,
  );
  assertEquals(
    defaults.includes("turbopanel_docker_manage_daemon_json: true"),
    true,
  );

  // Merge, not overwrite: read the existing file and combine onto it.
  assertEquals(daemonJson.includes("ansible.builtin.slurp"), true);
  assertEquals(daemonJson.includes("from_json"), true);
  assertEquals(daemonJson.includes("| combine("), true);
  assertEquals(daemonJson.includes("'default-address-pools'"), true);
  assertEquals(daemonJson.includes("'bip'"), true);
  // live-restore is always forced true, unconditionally combined (no
  // "clear" case the way the address-pool keys have).
  assertEquals(daemonJson.includes("combine({'live-restore': true})"), true);
  // The three owned keys are dropped before the combine so an empty var
  // removes a previously written value (the non-empty → empty clear case).
  assertEquals(
    daemonJson.includes(
      "rejectattr('key', 'in', ['default-address-pools', 'bip', 'live-restore'])",
    ),
    true,
    "strip owned keys before merging the current values back on",
  );
  assertEquals(
    daemonJson.includes("_docker_daemon_json_current is mapping"),
    true,
    "refuse to merge into a non-object daemon.json",
  );
  // Detects the co-located self-hosted instance by its systemd unit.
  assertEquals(
    daemonJson.includes(
      "path: /etc/systemd/system/turbopanel-instance.service",
    ),
    true,
  );
  assertEquals(
    daemonJson.includes("_docker_colocated_instance_host"),
    true,
  );
  // The write is the only mutation and it notifies the restart handler.
  assertEquals(daemonJson.includes("dest: /etc/docker/daemon.json"), true);
  assertEquals(daemonJson.includes("to_nice_json"), true);
  assertEquals(daemonJson.includes("notify: Restart docker"), true);
  assertEquals(daemonJson.includes("backup: true"), true);
  assertEquals(daemonJson.includes('mode: "0640"'), true);
  assertEquals(daemonJson.includes("owner: root"), true);
  // Loud restart notice, with the co-located case flagged separately.
  assertEquals(daemonJson.includes("dockerd RESTARTS"), true);
  assertEquals(
    daemonJson.includes("Existing containers keep their current"),
    true,
  );
  assertEquals(
    daemonJson.includes("will NOT be restarted automatically"),
    true,
  );
  assertEquals(handlers.includes("name: Restart docker"), true);
  assertEquals(handlers.includes("state: restarted"), true);
  // The handler itself skips on a co-located instance host — a control-plane
  // outage risk, not just a database blip.
  assertEquals(
    handlers.includes(
      "when: not (_docker_colocated_instance_host | default(false) | bool)",
    ),
    true,
  );
});

test("buildDockerSetupExtraArgs emits one JSON -e object and nothing when empty", () => {
  assertEquals(buildDockerSetupExtraArgs({}), []);
  assertEquals(
    buildDockerSetupExtraArgs({ addressPools: [], defaultBridgeCidr: null }),
    [],
  );
  const args = buildDockerSetupExtraArgs({
    addressPools: [{ base: "10.200.0.0/16", size: 24 }],
    defaultBridgeCidr: "172.26.0.1/16",
  });
  assertEquals(args[0], "-e");
  assertEquals(JSON.parse(args[1] ?? "{}"), {
    turbopanel_docker_address_pools: [{ base: "10.200.0.0/16", size: 24 }],
    turbopanel_docker_default_bridge_cidr: "172.26.0.1/16",
  });
  const poolsOnly = buildDockerSetupExtraArgs({
    addressPools: [{ base: "10.200.0.0/16", size: 24 }],
  });
  assertEquals(JSON.parse(poolsOnly[1] ?? "{}"), {
    turbopanel_docker_address_pools: [{ base: "10.200.0.0/16", size: 24 }],
  });
});

test("buildDockerSetupExtraArgs forces the daemon.json merge when clearing an applied descriptor", () => {
  // Empty values alone stay a no-op; the clear flag is what makes the role
  // include daemon-json.yml and strip the previously written keys.
  assertEquals(
    buildDockerSetupExtraArgs({
      addressPools: [],
      defaultBridgeCidr: null,
      clearAddressing: false,
    }),
    [],
  );
  const cleared = buildDockerSetupExtraArgs({
    addressPools: [],
    defaultBridgeCidr: null,
    clearAddressing: true,
  });
  assertEquals(cleared[0], "-e");
  assertEquals(JSON.parse(cleared[1] ?? "{}"), {
    turbopanel_docker_clear_addressing: true,
  });
});

test("runDockerSetup passes docker addressing as -e extra-vars", () => {
  const source = Deno.readTextFileSync(
    join(DAEMON_ROOT, "src/orchestration/ansible.ts"),
  );
  const start = source.indexOf("export async function runDockerSetup(");
  const end = source.indexOf("export async function runCaddySetup(");
  if (start < 0 || end < 0) throw new Error("could not locate runDockerSetup");
  const body = source.slice(start, end);
  assertEquals(body.includes("buildDockerSetupExtraArgs(resolved)"), true);
  assertEquals(body.includes("readDockerNetworkingState("), true);
  assertEquals(body.includes("devInstanceExtraArgs()"), true);
});

test(
  "compiled run mode needs no source checkout: mailer binary, secret and cert verbs",
  async () => {
    // instance-runtime-packaging (Road to 0.1.x): in compiled mode every
    // install-time step the roles used to run from the checkout with node
    // is a verb of the instance binary, and the mailer is its own binary
    // shipped beside it.
    const launchDefaults = await Deno.readTextFile(join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/defaults/main.yml",
    ));
    const launchTasks = await Deno.readTextFile(join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/tasks/main.yml",
    ));
    const mailerUnit = await Deno.readTextFile(join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/templates/turbopanel-mailer.service.j2",
    ));
    const certsDefaults = await Deno.readTextFile(join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-certs/defaults/main.yml",
    ));
    const certsTasks = await Deno.readTextFile(join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-certs/tasks/main.yml",
    ));

    assertMatch(
      launchDefaults,
      /turbopanel_mailer_binary:\s*"\{\{ turbopanel_instance_binary \| dirname \}\}\/turbopanel-mailer"/,
      "the compiled mailer sits beside the instance binary",
    );
    assertMatch(
      launchDefaults,
      /turbopanel_instance_secret_cmd:[\s\S]*?turbopanel_instance_binary ~ ' generate-secret'[\s\S]*?compiled[\s\S]*?generate-secret\.mjs/,
      "the secret generator is the binary's verb in compiled mode and the node script otherwise",
    );
    assertEquals(
      (launchTasks.match(/\{\{ turbopanel_instance_secret_cmd \}\}/g) ?? [])
        .length,
      2,
      "both keyring tasks (create + rotate) mint through turbopanel_instance_secret_cmd",
    );
    assert(
      !launchTasks.includes("generate-secret.mjs"),
      "instance-launch tasks must not reach into the checkout for generate-secret.mjs",
    );
    assertMatch(
      mailerUnit,
      /\{% if turbopanel_instance_run_mode == 'compiled' %\}\s*\{#[\s\S]*?#\}\s*ExecStart=\{\{ turbopanel_mailer_binary \}\}\s*\{% else %\}/,
      "the mailer unit exec's the compiled mailer in compiled mode",
    );
    assertMatch(
      mailerUnit,
      /mailer\/main\.ts\s*\{% endif %\}/,
      "source mode still runs mailer/main.ts from the checkout",
    );
    assertMatch(
      certsDefaults,
      /turbopanel_instance_cert_argv:[\s\S]*?\[turbopanel_instance_binary, 'generate-self-signed-cert'\][\s\S]*?compiled[\s\S]*?generate-self-signed-cert\.mjs/,
      "the cert generator is the binary's verb in compiled mode and the node script otherwise",
    );
    assertMatch(
      certsTasks,
      /argv: "\{\{ turbopanel_instance_cert_argv \}\}"/,
      "instance-certs runs whichever generator the run mode selects",
    );
    const migrateTasks = await Deno.readTextFile(join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/instance-launch/tasks/instance-migrate.yml",
    ));
    assertMatch(
      launchDefaults,
      /turbopanel_instance_migrate_argv:[\s\S]*?\[turbopanel_instance_binary, 'migrate'\][\s\S]*?compiled[\s\S]*?bootstrap-dev-db\.sh/,
      "migrations run through the binary's migrate verb in compiled mode and the checkout script otherwise",
    );
    assertMatch(
      migrateTasks,
      /argv: "\{\{ turbopanel_instance_migrate_argv \}\}"/,
      "instance-migrate runs whichever migrator the run mode selects",
    );
    assert(
      !migrateTasks.includes(
        'argv: \["{{ turbopanel_instance_dir }}/scripts/bootstrap-dev-db.sh"\]',
      ),
      "instance-migrate must not hard-code the checkout's bootstrap script",
    );
    assertMatch(
      certsTasks,
      /TURBOPANEL_TLS_CERTS_DIR: "\{\{ turbopanel_instance_certs_dir \}\}"/,
      "the generator is told where the leaf lives, so both modes agree with Caddy",
    );
    assert(
      !certsTasks.includes("turbopanel_instance_dir }}/certs"),
      "instance-certs must not hard-code the checkout's certs/ directory",
    );
  },
);
