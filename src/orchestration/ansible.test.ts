import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import {
  buildTimeSyncApplyExtraArgs,
  buildWireguardApplyExtraArgs,
  galaxyBootstrapRunContext,
  mergeTimeSyncApplyWithHostState,
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
  ANSIBLE_PLAYBOOK_BIN,
  ANSIBLE_PLAYBOOK_CWD,
  ansibleEnv,
  DAEMON_ROOT,
  GALAXY_COLLECTIONS_DIR,
  RABBITMQ_PLAYBOOK,
  REDIS_PLAYBOOK,
} from "./paths.ts";

const VENDORED_COLLECTIONS_MARKER = "galaxy-collections";
const CHECKOUT_ORCHESTRATION_DIR = join(DAEMON_ROOT, "orchestration");

/** True when the vendored ansible-playbook binary is present on this host. */
function ansiblePlaybookAvailable(): boolean {
  try {
    Deno.statSync(ANSIBLE_PLAYBOOK_BIN);
    return true;
  } catch {
    return false;
  }
}

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

function parseYamlInt(yaml: string, key: string): number {
  const match = new RegExp(
    String.raw`^\s*${key}:\s*["']?(\d+)["']?\s*$`,
    "m",
  ).exec(yaml);
  if (!match) {
    throw new TypeError(`could not parse ${key} as integer from YAML`);
  }
  return Number(match[1]);
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
    // Gate runtime.env on non-workers so Deno/compiled get ClickHouse + metrics env.
    assertMatch(
      unit,
      /turbopanel_instance_runtime[\s\S]*!= 'workers'[\s\S]*EnvironmentFile=-\{\{\s*turbopanel_instance_runtime_env\s*\}\}/,
      "runtime.env EnvironmentFile gated to Deno/compiled",
    );
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

test(
  "clickhouse users.xml keeps only bootstrap default; config.json names separate password files",
  async () => {
    const usersPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/templates/users.xml.j2",
    );
    const configPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/templates/clickhouse-config.json.j2",
    );
    const users = await Deno.readTextFile(usersPath);
    const config = await Deno.readTextFile(configPath);
    if (/<\{\{\s*clickhouse_app_user\s*\}\}>/.test(users)) {
      throw new Error(
        `${usersPath}: app user must not be declared in users.xml (SQL-only)`,
      );
    }
    assertMatch(
      users,
      /_clickhouse_admin_password/,
      "users.xml uses admin password fact",
    );
    assertMatch(
      config,
      /\.clickhouse_admin_pass/,
      "config.json references admin password file",
    );
    assertMatch(
      config,
      /\.clickhouse_app_pass/,
      "config.json references app password file",
    );
  },
);

test(
  "clickhouse low-footprint defaults pin cache size and container resource caps",
  async () => {
    const defaultsPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/defaults/main.yml",
    );
    const configPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/templates/config.xml.j2",
    );
    // Container resource caps (mem_limit/cpus) are rendered into the shared
    // turbopanel-system Compose file by system-compose, not a per-role docker
    // run/inspect path — see roles/system-compose/templates/docker-compose.yml.j2.
    const composeTemplatePath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/system-compose/templates/docker-compose.yml.j2",
    );
    const defaults = await Deno.readTextFile(defaultsPath);
    const config = await Deno.readTextFile(configPath);
    const composeTemplate = await Deno.readTextFile(composeTemplatePath);

    const markCache = parseYamlInt(defaults, "clickhouse_mark_cache_size");
    const serverMemory = parseYamlInt(
      defaults,
      "clickhouse_max_server_memory_usage",
    );
    const memoryBytes = parseYamlInt(
      defaults,
      "clickhouse_container_memory_bytes",
    );

    // Ceilings: catch silent upward regressions of the low-footprint profile.
    if (markCache > 67_108_864) {
      throw new Error(
        `${defaultsPath}: clickhouse_mark_cache_size=${markCache} exceeds 64 MiB ceiling`,
      );
    }
    if (serverMemory > 536_870_912) {
      throw new Error(
        `${defaultsPath}: clickhouse_max_server_memory_usage=${serverMemory} exceeds 512 MiB ceiling`,
      );
    }
    if (memoryBytes > 805_306_368) {
      throw new Error(
        `${defaultsPath}: clickhouse_container_memory_bytes=${memoryBytes} exceeds 768 MiB ceiling`,
      );
    }

    // Single memory source: the Compose template and cache-size config must
    // share the byte var (no parallel clickhouse_container_memory string that
    // can diverge).
    if (/^\s*clickhouse_container_memory:/m.test(defaults)) {
      throw new Error(
        `${defaultsPath}: clickhouse_container_memory must not exist; use clickhouse_container_memory_bytes only`,
      );
    }
    assertMatch(
      composeTemplate,
      /mem_limit:\s*\{\{\s*clickhouse_container_memory_bytes\s*\}\}/,
      "compose template sets mem_limit from clickhouse_container_memory_bytes",
    );

    assertMatch(
      config,
      /<mark_cache_size>\{\{\s*clickhouse_mark_cache_size\s*\}\}<\/mark_cache_size>/,
      "config.xml.j2 renders mark_cache_size from defaults",
    );
    assertMatch(
      config,
      /<max_server_memory_usage>\{\{\s*clickhouse_max_server_memory_usage\s*\}\}<\/max_server_memory_usage>/,
      "config.xml.j2 renders max_server_memory_usage from defaults",
    );
    assertMatch(
      composeTemplate,
      /cpus:\s*"\{\{\s*clickhouse_container_cpus\s*\}\}"/,
      "compose template sets cpus from clickhouse_container_cpus",
    );
  },
);

test(
  "clickhouse config.xml.j2 comments never contain XML-illegal double hyphens",
  async () => {
    const configPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/templates/config.xml.j2",
    );
    const config = await Deno.readTextFile(configPath);
    // XML comments may not contain "--" (SAXParseException / CH refuses to boot).
    const commentBodies = [...config.matchAll(/<!--([\s\S]*?)-->/g)].map(
      (match) => match[1]!,
    );
    for (const body of commentBodies) {
      if (body.includes("--")) {
        throw new Error(
          `${configPath}: XML comment contains "--" (illegal; breaks ClickHouse config merge):\n${
            body.slice(0, 200)
          }`,
        );
      }
    }
  },
);

test(
  "clickhouse system-log DROP cleanup stays aligned with config.xml remove list",
  async () => {
    const configPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/templates/config.xml.j2",
    );
    const tasksPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/tasks/bootstrap.yml",
    );
    const config = await Deno.readTextFile(configPath);
    const tasks = await Deno.readTextFile(tasksPath);

    const removedLogs = [
      ...config.matchAll(/<([a-z0-9_]+)\s+remove="remove"\s*\/>/g),
    ].map((match) => match[1]!);
    if (removedLogs.length === 0) {
      throw new Error(
        `${configPath}: expected at least one <*_log remove="remove"/> entry`,
      );
    }
    for (const logName of removedLogs) {
      const drop = `DROP TABLE IF EXISTS system.${logName};`;
      if (!tasks.includes(drop)) {
        throw new Error(
          `${tasksPath}: missing cleanup for disabled system log ${logName} (expected ${drop})`,
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
  if (env.ANSIBLE_HOME !== "/tmp/turbopanel-ansible") {
    throw new Error(
      `expected ANSIBLE_HOME=/tmp/turbopanel-ansible, got ${env.ANSIBLE_HOME}`,
    );
  }
  assertNotIn(env, "ANSIBLE_COLLECTIONS_PATH", "ansibleEnv");
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
    assertNotIn(env, "ANSIBLE_COLLECTIONS_PATH", "devOrchestrationAnsibleEnv");
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
      'join(GALAXY_ROLES_DIR, "geerlingguy.docker")',
      'join(GALAXY_ROLES_DIR, "geerlingguy", "docker")',
    ]
  ) {
    if (!source.includes(needle)) {
      throw new Error(
        `galaxy docker lint neutralize must include ${JSON.stringify(needle)}`,
      );
    }
  }
});

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
  const skipCall = script.indexOf("emitDevConvergeSkippedIfNeeded");
  const ensureAnsibleCall = script.indexOf("await ensureAnsible()");
  const galaxyCall = script.indexOf("await ensureGalaxyDockerRole()");
  const playbookCall = script.indexOf("await runPlaybookStreaming(");
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
  const ensureCall = script.indexOf("await ensureGalaxyDockerRole()");
  const playbookCall = script.indexOf("await runPlaybookStreaming(");
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
      "clickhouse-setup.yml",
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
});

test("galaxy collections install target matches cfg vendored path default", () => {
  if (!GALAXY_COLLECTIONS_DIR.endsWith(VENDORED_COLLECTIONS_MARKER)) {
    throw new Error(
      `expected GALAXY_COLLECTIONS_DIR to end with ${VENDORED_COLLECTIONS_MARKER}, got ${GALAXY_COLLECTIONS_DIR}`,
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
      // Split the assignment marker so scan-secrets does not treat this test as a
      // fixture env line (allowlist is for the j2 files only).
      const singularAssign = ["TURBOPANEL_SECRET", "="].join("");
      const pluralAssign = ["TURBOPANEL_SECRETS", "="].join("");
      assertMatch(
        body,
        new RegExp(
          `^${singularAssign}\\{\\{\\s*turbopanel_instance_secret\\s*\\}\\}\\s*$`,
          "m",
        ),
        `${label} still emits ${singularAssign.slice(0, -1)}`,
      );
      assertMatch(
        body,
        new RegExp(
          `turbopanel_instance_secrets[\\s\\S]*?${pluralAssign}\\{\\{\\s*turbopanel_instance_secrets\\s*\\}\\}`,
        ),
        `${label} emits ${pluralAssign.slice(0, -1)} when keyring is set`,
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

test("buildWireguardApplyExtraArgs stringifies listenPort and omits plaintext PSK", () => {
  const plaintextPsk = "SHOULD_NOT_APPEAR";
  const args = buildWireguardApplyExtraArgs({
    interfaceName: "tpwg550e8400",
    address: "203.0.113.10/32",
    privateKeyFile: "/var/lib/turbopanel/wireguard/tpwg550e8400.key",
    listenPort: 51820,
    peers: [
      {
        publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        allowedIps: ["203.0.113.11/32"],
        presharedKeyFile: "/var/lib/turbopanel/wireguard/psk/peer.psk",
      },
    ],
    configure: true,
  });
  assertEquals(args[0], "-e");
  const parsed = JSON.parse(args[1]!);
  assertEquals(parsed.wireguard_listen_port, "51820");
  assertEquals(typeof parsed.wireguard_listen_port, "string");
  assertEquals(
    parsed.wireguard_peers[0].presharedKeyFile,
    "/var/lib/turbopanel/wireguard/psk/peer.psk",
  );
  assertEquals(JSON.stringify(parsed).includes(plaintextPsk), false);
  assertEquals("presharedKey" in (parsed.wireguard_peers[0] as object), false);
});

test("buildWireguardApplyExtraArgs wires manageForwarding + enableIpForwarding independently", () => {
  const baseOpts = {
    interfaceName: "tpwg550e8400",
    address: "203.0.113.10/32",
    privateKeyFile: "/var/lib/turbopanel/wireguard/tpwg550e8400.key",
    peers: [],
  };

  // Bootstrap/tools-only runs omit both — must not reset host sysctl state.
  const bootstrap = JSON.parse(buildWireguardApplyExtraArgs(baseOpts)[1]!);
  assertEquals(bootstrap.wireguard_manage_forwarding, false);
  assertEquals(bootstrap.wireguard_ip_forward, false);

  // Host-wide reconciliation disabling forwarding (no interface needs it).
  const disable = JSON.parse(
    buildWireguardApplyExtraArgs({
      ...baseOpts,
      manageForwarding: true,
      enableIpForwarding: false,
    })[1]!,
  );
  assertEquals(disable.wireguard_manage_forwarding, true);
  assertEquals(disable.wireguard_ip_forward, false);

  // Host-wide reconciliation enabling forwarding (at least one interface needs it).
  const enable = JSON.parse(
    buildWireguardApplyExtraArgs({
      ...baseOpts,
      manageForwarding: true,
      enableIpForwarding: true,
    })[1]!,
  );
  assertEquals(enable.wireguard_manage_forwarding, true);
  assertEquals(enable.wireguard_ip_forward, true);
});

test("wireguard template guards ListenPort and PSK file lookups", async () => {
  const templatePath = join(
    CHECKOUT_ORCHESTRATION_DIR,
    "roles/wireguard/templates/wg.conf.j2",
  );
  const template = await Deno.readTextFile(templatePath);
  // Avoid `wireguard_listen_port | length` on a bare number (Jinja TypeError).
  assertEquals(template.includes("wireguard_listen_port | length"), false);
  assertEquals(
    template.includes("wireguard_listen_port | string | length"),
    true,
  );
  assertEquals(template.includes("peer.presharedKeyFile"), true);
  assertEquals(template.includes("peer.presharedKey "), false);
});

test({
  name: "wireguard template renders ListenPort for numeric listen port",
  // Requires vendored ansible-playbook; skip explicitly when absent so CI does
  // not report a green test that never ran the render.
  ignore: !ansiblePlaybookAvailable(),
  fn: async () => {
    const templatePath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/wireguard/templates/wg.conf.j2",
    );
    const tmpDir = await Deno.makeTempDir({ prefix: "tp-wg-template-" });
    try {
      const privateKeyFile = join(tmpDir, "iface.key");
      const pskFile = join(tmpDir, "peer.psk");
      const dest = join(tmpDir, "wg.conf");
      await Deno.writeTextFile(privateKeyFile, "PRIVATEKEYLINE\n", {
        mode: 0o600,
      });
      await Deno.writeTextFile(pskFile, "PSKLINE\n", { mode: 0o600 });

      const playbook = join(tmpDir, "render.yml");
      await Deno.writeTextFile(
        playbook,
        [
          "---",
          "- hosts: localhost",
          "  gather_facts: false",
          "  connection: local",
          "  tasks:",
          "    - ansible.builtin.template:",
          `        src: ${templatePath}`,
          `        dest: ${dest}`,
          "",
        ].join("\n"),
      );

      const extra = {
        wireguard_interface: "tpwgtest",
        wireguard_address: "203.0.113.10/32",
        wireguard_private_key_file: privateKeyFile,
        wireguard_listen_port: "51820",
        wireguard_peers: [
          {
            publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
            allowedIps: ["203.0.113.11/32"],
            presharedKeyFile: pskFile,
          },
        ],
      };

      const command = new Deno.Command(ANSIBLE_PLAYBOOK_BIN, {
        args: [
          "-i",
          "localhost,",
          "-c",
          "local",
          "-e",
          JSON.stringify(extra),
          playbook,
        ],
        cwd: CHECKOUT_ORCHESTRATION_DIR,
        env: ansibleEnv(),
        stdout: "piped",
        stderr: "piped",
      });
      const output = await command.output();
      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr);
        throw new Error(`ansible-playbook failed: ${stderr}`);
      }

      const rendered = await Deno.readTextFile(dest);
      assertEquals(rendered.includes("ListenPort = 51820"), true);
      assertEquals(rendered.includes("PresharedKey = PSKLINE"), true);
      assertEquals(rendered.includes("PrivateKey = PRIVATEKEYLINE"), true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

test("traditional-web apply playbooks vendor engines (never apt nginx/apache2)", async () => {
  const nginxPlaybook = await Deno.readTextFile(
    join(CHECKOUT_ORCHESTRATION_DIR, "playbooks/traditional-web-apply.yml"),
  );
  const apachePlaybook = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "playbooks/traditional-web-apache-apply.yml",
    ),
  );
  const olsPlaybook = await Deno.readTextFile(
    join(
      CHECKOUT_ORCHESTRATION_DIR,
      "playbooks/traditional-web-openlitespeed-apply.yml",
    ),
  );

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
    ] as const
  ) {
    if (/ansible\.builtin\.apt:/.test(body)) {
      throw new Error(
        `traditional-web ${label} playbook must not apt-install packages`,
      );
    }
    if (
      /\bname:\s*nginx\b/.test(body) && label === "nginx" && /apt:/.test(body)
    ) {
      throw new Error(
        "traditional-web nginx playbook must not apt install nginx",
      );
    }
    if (body.includes("apache2") || body.includes("libapache2-mod-php")) {
      throw new Error(
        `traditional-web ${label} playbook must not reference distro apache2 packages`,
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
  assertMatch(
    phpFpmDefaults,
    /php_fpm_version:\s*"8\.\d+\.\d+"/,
    "php-fpm pin",
  );
  assertMatch(phpFpmDefaults, /php_fpm_series:\s*"8\.\d+"/, "php-fpm series");

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
      "roles/php-fpm/templates/turbopanel-php-fpm.service.j2",
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
  assertEquals(
    phpFpmUnit.includes("turbopanel_vendor_dir }}/php/current"),
    true,
  );
});
