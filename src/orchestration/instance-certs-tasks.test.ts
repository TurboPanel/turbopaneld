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
const letsEncryptTasks = join(
  repoRoot,
  "orchestration/roles/instance-certs/tasks/letsencrypt-files.yml",
);
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

async function openssl(args: string[]): Promise<void> {
  const out = await new Deno.Command("openssl", {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new TypeError(new TextDecoder().decode(out.stderr));
  }
}

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

function itemResults(output: string, task: string): Map<string, string> {
  const start = output.indexOf(`TASK [${task}]`);
  if (start < 0) throw new TypeError(output);
  const rest = output.slice(start);
  const next = rest.indexOf("\nTASK [");
  const section = next < 0 ? rest : rest.slice(0, next);
  const results = new Map<string, string>();
  const pattern = /^(changed|ok|failed): \[localhost\] => \(item=([^)]+)\)/gm;
  let match = pattern.exec(section);
  while (match) {
    const status = match[1];
    const item = match[2];
    if (status && item) results.set(item, status);
    match = pattern.exec(section);
  }
  return results;
}

test({
  name:
    "Let's Encrypt migration reports changed only when a legacy pair is copied",
  ignore: ansiblePlaybook === undefined,
  permissions: { read: true, write: true, run: true, env: true },
  fn: async () => {
    const bin = ansiblePlaybook;
    if (!bin) throw new TypeError("ansible-playbook missing");
    const root = await Deno.makeTempDir({ prefix: "tp-le-migrate-" });
    const legacy = join(
      root,
      "legacy",
      "acme-v02.api.letsencrypt.org-directory",
      "panel.example.com",
    );
    const dest = join(root, "certs");
    const home = join(root, "home");
    await Deno.mkdir(legacy, { recursive: true });
    await Deno.mkdir(home, { recursive: true });
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(legacy, "panel.example.com.key"),
      "-out",
      join(legacy, "panel.example.com.crt"),
      "-days",
      "1",
      "-subj",
      "/CN=panel.example.com",
      "-addext",
      "subjectAltName=DNS:panel.example.com",
    ]);
    const playbook = join(root, "migrate.yml");
    await Deno.writeTextFile(
      playbook,
      [
        "---",
        "- name: Migrate Let's Encrypt certificates",
        "  hosts: localhost",
        "  connection: local",
        "  become: true",
        "  gather_facts: false",
        "  vars:",
        "    turbopanel_hostnames:",
        "      - host: panel.example.com",
        "        source: lets-encrypt",
        '        cert_id: ""',
        "      - host: other.example.com",
        "        source: lets-encrypt",
        '        cert_id: ""',
        '    turbopanel_legacy_acme_certificate_root: "{{ le_legacy_root }}"',
        '    turbopanel_state_dir: "{{ le_legacy_root }}"',
        '    turbopanel_instance_certs_dir: "{{ le_dest }}"',
        "    turbopanel_group: root",
        "    caddy_user: root",
        "  tasks:",
        "    - name: Include Let's Encrypt file tasks",
        '      ansible.builtin.include_tasks: "{{ le_tasks }}"',
        "",
      ].join("\n"),
    );
    const extra = [
      "-e",
      `le_legacy_root=${join(root, "legacy")}`,
      "-e",
      `le_dest=${dest}`,
      "-e",
      `le_tasks=${letsEncryptTasks}`,
    ];
    try {
      const first = await runPlaybook(bin, playbook, home, extra);
      if (first.code !== 0) throw new TypeError(first.output);
      const migrated = itemResults(
        first.output,
        "Migrate validated legacy control-plane certificates",
      );
      assertEquals(migrated.get("panel.example.com"), "changed");
      assertEquals(migrated.get("other.example.com"), "ok");
      const present = await new Deno.Command("sudo", {
        args: [
          "-n",
          "test",
          "-f",
          join(dest, "letsencrypt-panel.example.com.crt"),
        ],
      }).output();
      assertEquals(present.success, true, first.output);
      const absent = await new Deno.Command("sudo", {
        args: [
          "-n",
          "test",
          "-f",
          join(dest, "letsencrypt-other.example.com.crt"),
        ],
      }).output();
      assertEquals(absent.success, false);

      const second = await runPlaybook(bin, playbook, home, extra);
      if (second.code !== 0) throw new TypeError(second.output);
      const again = itemResults(
        second.output,
        "Migrate validated legacy control-plane certificates",
      );
      assertEquals(again.get("panel.example.com"), "ok");
      assertEquals(again.get("other.example.com"), "ok");
    } finally {
      await new Deno.Command("sudo", {
        args: ["-n", "rm", "-rf", dest],
      }).output();
      await Deno.remove(root, { recursive: true });
    }
  },
});

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
