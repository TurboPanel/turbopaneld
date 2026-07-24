import { join } from "@std/path";
import { assertEquals } from "jsr:@std/assert";
import {
  buildTimeSyncApplyExtraArgs,
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
  ANSIBLE_PLAYBOOK_CWD,
  ansibleEnv,
  DAEMON_ROOT,
  GALAXY_COLLECTIONS_DIR,
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
    const tasksPath = join(
      CHECKOUT_ORCHESTRATION_DIR,
      "roles/clickhouse/tasks/main.yml",
    );
    const defaults = await Deno.readTextFile(defaultsPath);
    const config = await Deno.readTextFile(configPath);
    const tasks = await Deno.readTextFile(tasksPath);

    const markCache = parseYamlInt(defaults, "clickhouse_mark_cache_size");
    const serverMemory = parseYamlInt(
      defaults,
      "clickhouse_max_server_memory_usage",
    );
    const memoryBytes = parseYamlInt(
      defaults,
      "clickhouse_container_memory_bytes",
    );
    const nanoCpus = parseYamlInt(defaults, "clickhouse_container_nanocpus");

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
    if (nanoCpus > 1_000_000_000) {
      throw new Error(
        `${defaultsPath}: clickhouse_container_nanocpus=${nanoCpus} exceeds 1.0 CPU ceiling`,
      );
    }

    // Single memory source: docker run and drift check must share the byte var
    // (no parallel clickhouse_container_memory string that can diverge).
    if (/^\s*clickhouse_container_memory:/m.test(defaults)) {
      throw new Error(
        `${defaultsPath}: clickhouse_container_memory must not exist; use clickhouse_container_memory_bytes only`,
      );
    }
    assertMatch(
      tasks,
      /"--memory"\s*\n\s*-\s*"\{\{\s*clickhouse_container_memory_bytes\s*\}\}"/,
      "tasks pass --memory from clickhouse_container_memory_bytes",
    );
    assertMatch(
      tasks,
      /clickhouse_memory_ok:[\s\S]*clickhouse_container_memory_bytes/,
      "tasks drift-check memory against clickhouse_container_memory_bytes",
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
      tasks,
      /"--cpus"/,
      "tasks pass --cpus to docker run",
    );
    assertMatch(
      tasks,
      /clickhouse_cpus_ok/,
      "tasks drift-check container cpus",
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
      "roles/clickhouse/tasks/main.yml",
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
      /turbopanel_caddyfile:.*dev\/orchestration\/Caddyfile/,
      "turbopanel_caddyfile selects the dev overlay when turbopanel_dev_user is set",
    );
    assertMatch(
      defaults,
      /turbopanel_caddyfile:.*\/Caddyfile/,
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
  const timezoneOnly = JSON.parse(buildTimeSyncApplyExtraArgs({ timezone: "UTC" })[1]!);
  assertEquals(timezoneOnly.turbopanel_apply_ntp_config, false);
  assertEquals(buildTimeSyncApplyExtraArgs({}), []);
});
