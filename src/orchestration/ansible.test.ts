import { join } from "@std/path";
import { assertEquals } from "jsr:@std/assert";
import { galaxyBootstrapRunContext } from "./ansible.ts";
import {
  devOrchestrationAnsibleEnv,
  resolveDevOrchestrationLayout,
} from "./dev-orchestration.ts";
import {
  setActiveInstallPresenter,
} from "./install-presenter-context.ts";
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

function assertMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${label}: expected ${pattern}, got:\n${value}`);
  }
}

function assertNotIn(value: Record<string, string>, key: string, label: string): void {
  if (key in value) {
    throw new Error(`${label}: did not expect ${key} to be set`);
  }
}

Deno.test("checked-in ansible.cfg defines vendored collections_path", async () => {
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
  }
});

Deno.test("ansibleEnv selects checked-in config without overriding collections_path", () => {
  const env = ansibleEnv();
  if (env.ANSIBLE_CONFIG !== ANSIBLE_CFG) {
    throw new Error(
      `expected ANSIBLE_CONFIG=${ANSIBLE_CFG}, got ${env.ANSIBLE_CONFIG}`,
    );
  }
  assertNotIn(env, "ANSIBLE_COLLECTIONS_PATH", "ansibleEnv");
});

Deno.test("devOrchestrationAnsibleEnv selects overlay config without collections override", async () => {
  const layout = await resolveDevOrchestrationLayout();
  const env = devOrchestrationAnsibleEnv(layout);
  if (env.ANSIBLE_CONFIG !== layout.ansibleCfgPath) {
    throw new Error(
      `expected ANSIBLE_CONFIG=${layout.ansibleCfgPath}, got ${env.ANSIBLE_CONFIG}`,
    );
  }
  assertNotIn(env, "ANSIBLE_COLLECTIONS_PATH", "devOrchestrationAnsibleEnv");
});

Deno.test("galaxyBootstrapRunContext matches playbook ansible contract", () => {
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
  assertNotIn(ctx.env, "ANSIBLE_COLLECTIONS_PATH", "galaxyBootstrapRunContext");
});

Deno.test("requirements.yml pins ansible.posix to an exact version", async () => {
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

Deno.test("galaxy collections install target matches cfg vendored path default", () => {
  if (!GALAXY_COLLECTIONS_DIR.endsWith(VENDORED_COLLECTIONS_MARKER)) {
    throw new Error(
      `expected GALAXY_COLLECTIONS_DIR to end with ${VENDORED_COLLECTIONS_MARKER}, got ${GALAXY_COLLECTIONS_DIR}`,
    );
  }
});

Deno.test("setup playbook paths keep internal redis and rabbitmq identifiers", () => {
  assertEquals(REDIS_PLAYBOOK.endsWith("redis-setup.yml"), true);
  assertEquals(RABBITMQ_PLAYBOOK.endsWith("rabbitmq-setup.yml"), true);
});

Deno.test("converge setup status lines sanitize vendor tokens when presenter is active", () => {
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
