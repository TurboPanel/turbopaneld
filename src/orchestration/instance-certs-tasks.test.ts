import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const repoRoot = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
const resolveTasks = join(
  repoRoot,
  "orchestration/roles/instance-certs/tasks/resolve-hostnames.yml",
);

const VENDOR_ANSIBLE =
  "/opt/turbopanel/vendor/ansible/current/bin/ansible-playbook";

function isExecutable(path: string): boolean {
  try {
    const info = Deno.statSync(path);
    return info.isFile && ((info.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findAnsiblePlaybook(): string | undefined {
  if (isExecutable(VENDOR_ANSIBLE)) return VENDOR_ANSIBLE;
  const fromPath = (Deno.env.get("PATH") ?? "").split(":")
    .filter((dir) => dir.length > 0)
    .map((dir) => join(dir, "ansible-playbook"));
  return fromPath.find(isExecutable);
}

const ansiblePlaybook = findAnsiblePlaybook();

async function runPlaybook(
  bin: string,
  playbook: string,
  home: string,
  extra: string[],
): Promise<{ code: number; output: string }> {
  const cfg = join(home, "ansible.cfg");
  await Deno.writeTextFile(
    cfg,
    [
      "[defaults]",
      "stdout_callback = default",
      "interpreter_python = /usr/bin/python3",
      "host_key_checking = False",
      "nocows = True",
      "",
      "[privilege_escalation]",
      "become_flags = -H -S -n",
      "",
    ].join("\n"),
  );
  await Deno.mkdir(join(home, "ansible-home"), { recursive: true });
  await Deno.mkdir(join(home, "ansible-local"), { recursive: true });
  const out = await new Deno.Command(bin, {
    args: [playbook, "-i", "localhost,", "-c", "local", ...extra],
    clearEnv: true,
    env: {
      PATH: `${dirname(bin)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      ANSIBLE_CONFIG: cfg,
      ANSIBLE_STDOUT_CALLBACK: "default",
      ANSIBLE_HOME: join(home, "ansible-home"),
      ANSIBLE_LOCAL_TEMP: join(home, "ansible-local"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    output: new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr),
  };
}

test({
  name: "hostname projection keeps a forwarded LAN address off hostname rows",
  ignore: ansiblePlaybook === undefined,
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const bin = ansiblePlaybook;
    if (!bin) throw new TypeError("ansible-playbook missing");
    const root = await Deno.makeTempDir({ prefix: "tp-cert-hosts-" });
    const home = join(root, "home");
    await Deno.mkdir(home, { recursive: true });
    const playbook = join(root, "resolve.yml");
    await Deno.writeTextFile(
      playbook,
      [
        "---",
        "- name: Keep forwarded names on the leaf list",
        "  hosts: localhost",
        "  connection: local",
        "  gather_facts: false",
        "  vars:",
        "    turbopanel_tls_mode: self_signed",
        '    turbopanel_dev_user: ""',
        "    turbopanel_hostnames:",
        "      - host: https://panel.example.com:8443",
        "        source: platform-ca",
        '        cert_id: ""',
        '    turbopanel_public_urls: "192.0.2.10"',
        "  tasks:",
        "    - name: Resolve hostnames",
        '      ansible.builtin.include_tasks: "{{ resolve_tasks }}"',
        "    - name: Forwarded LAN address stays on the leaf list",
        "      ansible.builtin.assert:",
        "        that:",
        "          - turbopanel_hostnames | length == 1",
        "          - \"(turbopanel_hostnames | map(attribute='host') | list) == ['https://panel.example.com:8443']\"",
        "          - \"'192.0.2.10' in (turbopanel_public_urls.split(',') | map('trim') | list)\"",
        "          - \"'https://panel.example.com:8443' in (turbopanel_public_urls.split(',') | map('trim') | list)\"",
        "",
      ].join("\n"),
    );
    try {
      const result = await runPlaybook(bin, playbook, home, [
        "-e",
        `resolve_tasks=${resolveTasks}`,
      ]);
      assertEquals(result.code, 0, result.output);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
