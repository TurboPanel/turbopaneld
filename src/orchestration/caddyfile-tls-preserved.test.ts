import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The update flow's unit refresh once rewrote a Let's Encrypt Caddyfile as
 * self-signed because it ran the whole instance-launch role with none of the
 * TLS extra-vars the control plane's apply passes. These pin the fix: the
 * refresh renders unit templates only, and the Caddyfile render derives its
 * hostnames from the persisted sidecar and refuses to downgrade.
 */
const repoRoot = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
const orchestration = join(repoRoot, "orchestration");
const read = (path: string) => Deno.readTextFile(join(orchestration, path));

function findAnsiblePlaybook(): string | undefined {
  const dirs = ["/opt/turbopanel/vendor/ansible/current/bin"].concat(
    (Deno.env.get("PATH") ?? "").split(":").filter((dir) => dir.length > 0),
  );
  for (const dir of dirs) {
    const bin = join(dir, "ansible-playbook");
    try {
      if (Deno.statSync(bin).isFile) return bin;
    } catch {
      // not here
    }
  }
  return undefined;
}

const ansiblePlaybook = findAnsiblePlaybook();
const stripComments = (text: string) => text.replaceAll(/^\s*#.*$/gm, "");
const HOST = "canary.example.com";

const LETS_ENCRYPT = JSON.stringify([
  { host: HOST, source: "lets-encrypt", cert_id: "" },
]);

interface Scenario {
  /** Contents of instance-hostnames.json; undefined = no sidecar. */
  sidecar?: string;
  /** Contents of the already-installed Caddyfile; undefined = none. */
  installed?: string;
  /** Extra-vars the caller passes, as key=value. */
  extra?: string[];
}

interface Rendered {
  caddyfile: string | undefined;
  output: string;
}

// Mirrors the instance-launch order: resolve hostnames, then the guarded
// Caddyfile render (tasks/caddyfile.yml), with the Let's Encrypt files on disk.
function playbookFor(root: string): string {
  const certs = join(root, "certs");
  return [
    "- hosts: localhost",
    "  connection: local",
    "  gather_facts: false",
    "  vars:",
    `    turbopanel_config_dir: ${join(root, "etc")}`,
    `    turbopanel_caddyfile: ${join(root, "etc/caddy/Caddyfile")}`,
    `    turbopanel_instance_certs_dir: ${certs}`,
    `    turbopanel_caddy_admin_socket: ${join(root, "admin.sock")}`,
    `    turbopanel_run_dir: ${join(root, "run")}`,
    `    turbopanel_ui_dist_dir: ${join(root, "ui")}`,
    "    turbopanel_group: root",
    "    turbopanel_dev_user: ''",
    `    turbopanel_letsencrypt_ready: ['${HOST}']`,
    "  tasks:",
    "    - ansible.builtin.include_tasks: " +
    join(orchestration, "roles/instance-certs/tasks/resolve-hostnames.yml"),
    "    - ansible.builtin.include_role:",
    "        name: instance-launch",
    "        tasks_from: caddyfile.yml",
    "  handlers:",
    "    - name: Reload turbopanel caddy",
    "      ansible.builtin.debug:",
    "        msg: reload",
    "",
  ].join("\n");
}

async function render(scenario: Scenario): Promise<Rendered> {
  const bin = ansiblePlaybook;
  if (!bin) throw new TypeError("ansible-playbook missing");
  const root = await Deno.makeTempDir({ prefix: "tp-caddyfile-" });
  const caddyDir = join(root, "etc/caddy");
  await Deno.mkdir(caddyDir, { recursive: true });
  await Deno.mkdir(join(root, "home"), { recursive: true });
  if (scenario.sidecar !== undefined) {
    await Deno.writeTextFile(
      join(caddyDir, "instance-hostnames.json"),
      scenario.sidecar,
    );
  }
  if (scenario.installed !== undefined) {
    await Deno.writeTextFile(join(caddyDir, "Caddyfile"), scenario.installed);
  }
  const playbook = join(root, "play.yml");
  await Deno.writeTextFile(playbook, playbookFor(root));
  // instance_start=false is what the unit refresh passes: no handler restarts.
  const extra = ["instance_start=false", ...(scenario.extra ?? [])].flatMap((
    arg,
  ) => ["-e", arg]);
  const out = await new Deno.Command("unshare", {
    args: ["-r", bin, playbook, "-i", "localhost,", "-c", "local", ...extra],
    clearEnv: true,
    env: {
      PATH: `${dirname(bin)}:/usr/bin:/bin`,
      HOME: join(root, "home"),
      ANSIBLE_HOME: join(root, "home"),
      ANSIBLE_LOCAL_TEMP: join(root, "home"),
      ANSIBLE_NOCOWS: "1",
      ANSIBLE_REMOTE_TMP: join(root, "home"),
      ANSIBLE_ROLES_PATH: join(orchestration, "roles"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (!out.success) throw new TypeError(output);
  let caddyfile: string | undefined;
  try {
    caddyfile = await Deno.readTextFile(join(caddyDir, "Caddyfile"));
  } catch {
    caddyfile = undefined;
  }
  return { caddyfile, output };
}

// The role chowns to root:<group>. A user namespace that maps the caller to
// root lets that succeed without privileges; without one, skip.
function canMapToRoot(): boolean {
  try {
    return new Deno.Command("unshare", {
      args: ["-r", "true"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

const ignore = ansiblePlaybook === undefined || !canMapToRoot();
const permissions = { read: true, write: true, run: true, env: true };

test({
  name:
    "the units-refresh arguments (no hostname vars) render the persisted Let's Encrypt site",
  ignore,
  permissions,
  fn: async () => {
    const { caddyfile } = await render({ sidecar: LETS_ENCRYPT });
    if (caddyfile === undefined) throw new TypeError("no Caddyfile rendered");
    assertStringIncludes(caddyfile, "tls mode: lets_encrypt");
    assertStringIncludes(caddyfile, `${HOST}:8443`);
    assertStringIncludes(caddyfile, `letsencrypt-${HOST}.crt`);
    assertStringIncludes(caddyfile, `letsencrypt-${HOST}.key`);
  },
});

test({
  name: "no vars and no sidecar is a fresh install: self-signed, unchanged",
  ignore,
  permissions,
  fn: async () => {
    const { caddyfile } = await render({});
    if (caddyfile === undefined) throw new TypeError("no Caddyfile rendered");
    assertStringIncludes(caddyfile, "tls mode: self_signed");
    assertEquals(caddyfile.includes("letsencrypt-"), false);
  },
});

test({
  name: "an explicit empty hostname list still removes the hostnames",
  ignore,
  permissions,
  fn: async () => {
    const { caddyfile } = await render({
      sidecar: LETS_ENCRYPT,
      installed: "# tls mode: self_signed\n",
      extra: ["turbopanel_hostnames_json=[]"],
    });
    if (caddyfile === undefined) throw new TypeError("no Caddyfile rendered");
    assertStringIncludes(caddyfile, "tls mode: self_signed");
  },
});

test({
  name:
    "a Let's Encrypt Caddyfile is kept, with a warning, when nothing names a hostname",
  ignore,
  permissions,
  fn: async () => {
    const installed =
      `# TurboPanel (managed install, tls mode: lets_encrypt).\n${HOST}:8443 {\n}\n`;
    const { caddyfile, output } = await render({ installed });
    assertEquals(caddyfile, installed);
    assertStringIncludes(output, "kept the installed Caddyfile");
  },
});

test({
  name: "a corrupt sidecar is ignored, not fatal",
  ignore,
  permissions,
  fn: async () => {
    const { caddyfile, output } = await render({ sidecar: "{not json" });
    if (caddyfile === undefined) throw new TypeError("no Caddyfile rendered");
    assertStringIncludes(caddyfile, "tls mode: self_signed");
    assertStringIncludes(output, "not valid JSON");
  },
});

test("the units refresh renders unit templates only, never the Caddyfile", async () => {
  const playbook = await read("playbooks/instance-units-refresh.yml");
  const units = await read("roles/instance-launch/tasks/units.yml");
  assertStringIncludes(playbook, "tasks_from: units.yml");
  assertEquals(
    /include_role:\s*\n\s*name: instance-launch\s*\n(?!\s*tasks_from)/.test(
      playbook,
    ),
    false,
  );
  for (const text of [playbook, units].map(stripComments)) {
    assertEquals(/Caddyfile|caddyfile/.test(text), false);
    assertEquals(/hostnames/.test(text), false);
  }
  // The unit tasks still notify the single restart the caller owns.
  assertStringIncludes(units, "Restart turbopanel instance");
  assertStringIncludes(units, "turbopanel-caddy.service.j2");
});
