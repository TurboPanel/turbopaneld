import { join } from "@std/path";
import { assertEquals } from "jsr:@std/assert";
import { galaxyBootstrapRunContext } from "./ansible.ts";
import {
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
    join(DAEMON_ROOT, "dev", "orchestration", "ansible.cfg"),
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
  const layout = await resolveDevOrchestrationLayout();
  const env = devOrchestrationAnsibleEnv(layout);
  if (env.ANSIBLE_CONFIG !== layout.ansibleCfgPath) {
    throw new Error(
      `expected ANSIBLE_CONFIG=${layout.ansibleCfgPath}, got ${env.ANSIBLE_CONFIG}`,
    );
  }
  assertNotIn(env, "ANSIBLE_COLLECTIONS_PATH", "devOrchestrationAnsibleEnv");
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
