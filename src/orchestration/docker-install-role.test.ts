import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const ORCH = join(DAEMON_ROOT, "orchestration");
const DOCKER_ROLE = join(ORCH, "roles", "docker");
const RELEASE_LIB = join(DAEMON_ROOT, "scripts", "lib", "release-artifacts.sh");

// Spelled in pieces so this file does not trip its own scan.
const RETIRED_ROLE_AUTHOR = ["geerling", "guy"].join("");

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      out.push(...await listFiles(path));
    } else if (entry.isFile) {
      out.push(path);
    }
  }
  return out;
}

async function stageRelease(): Promise<{ root: string; dir: string }> {
  const root = await Deno.makeTempDir({ prefix: "tp-orch-release-" });
  const script = `set -eu
. '${RELEASE_LIB}'
tp_build_orchestration_archive_staging '${root}' /opt/turbopanel '${ORCH}'`;
  const result = await new Deno.Command("bash", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return { root, dir: join(root, "opt/turbopanel/share/orchestration") };
}

test("the release package carries the Docker install role and the playbooks that run it", async () => {
  const { root, dir } = await stageRelease();
  try {
    for (
      const rel of [
        "roles/docker/tasks/main.yml",
        "roles/docker/tasks/install.yml",
        "roles/docker/vars/main.yml",
        "roles/docker/files/docker.asc",
        "roles/docker/files/docker.asc.json",
        "roles/docker/templates/docker.sources.j2",
        "roles/repo-key/tasks/main.yml",
        "playbooks/docker-setup.yml",
        "playbooks/daemon-converge.yml",
      ]
    ) {
      const stat = await Deno.stat(join(dir, rel));
      assertEquals(stat.isFile, true, rel);
    }

    // Everything the shipped playbooks and roles name must exist in the
    // package, so no role has to be fetched from anywhere at run time.
    const files = (await listFiles(dir)).filter((f) => f.endsWith(".yml"));
    const missing: string[] = [];
    for (const file of files) {
      const text = await Deno.readTextFile(file);
      const names = [
        ...text.matchAll(/^\s*-?\s*role:\s*([\w.-]+)\s*$/gm),
        ...text.matchAll(
          /include_role:\s*\n\s*name:\s*([\w.-]+)\s*$/gm,
        ),
      ].map((m) => m[1]!);
      for (const name of names) {
        try {
          const stat = await Deno.stat(join(dir, "roles", name));
          if (!stat.isDirectory) missing.push(`${file}: ${name}`);
        } catch {
          missing.push(`${file}: ${name}`);
        }
      }
    }
    assertEquals(missing, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("the docker role creates the docker system group before any Docker unit is started", async () => {
  const main = await Deno.readTextFile(join(DOCKER_ROLE, "tasks/main.yml"));
  const install = await Deno.readTextFile(
    join(DOCKER_ROLE, "tasks/install.yml"),
  );
  const group = main.indexOf(
    "- name: Make sure the docker system group exists",
  );
  assertEquals(group >= 0, true);
  const task = main.slice(group, main.indexOf("\n\n", group));
  assertStringIncludes(task, "ansible.builtin.group:");
  assertStringIncludes(task, "name: docker");
  assertStringIncludes(task, "system: true");
  assertStringIncludes(task, "state: present");
  // No `when`: it runs on every converge, and is a no-op when the group exists.
  assertEquals(task.includes("when:"), false);
  // Before the start of an installed Docker and before the install that starts it.
  assertEquals(
    group < main.indexOf("- name: Start an installed but stopped Docker"),
    true,
  );
  assertEquals(
    group < main.indexOf("ansible.builtin.include_tasks: install.yml"),
    true,
  );
  assertStringIncludes(install, "name: Enable and start Docker");
});

test("the docker role installs Docker itself from the official apt repository", async () => {
  const main = await Deno.readTextFile(join(DOCKER_ROLE, "tasks/main.yml"));
  assertStringIncludes(main, "ansible.builtin.include_tasks: install.yml");
  // Fast path: only Docker's own package counts, a healthy one is not touched.
  assertStringIncludes(main, "dpkg-query");
  assertStringIncludes(main, "docker-ce");
  assertStringIncludes(main, "(not (_docker_ready | bool))");

  const install = await Deno.readTextFile(
    join(DOCKER_ROLE, "tasks/install.yml"),
  );
  assertStringIncludes(install, "name: repo-key");
  // role_path inside include_role vars would resolve to repo-key's own dir.
  assertStringIncludes(
    install,
    '_docker_key_bundled: "{{ role_path }}/files/docker.asc"',
  );
  assertStringIncludes(
    install,
    'repo_key_bundled: "{{ _docker_key_bundled }}"',
  );
  assertEquals(
    install.indexOf("_docker_key_bundled: ") <
      install.indexOf("name: repo-key"),
    true,
  );
  assertStringIncludes(
    install,
    "Refuse to replace a distribution engine that may have containers",
  );
  assertStringIncludes(install, "python3-apt");
  // The data check must not depend on the docker CLI existing.
  assertEquals(
    install.split("_docker_old_containers is skipped or").length - 1,
    2,
  );
  assertStringIncludes(install, "install_recommends: false");
  assertStringIncludes(install, "selection: hold");
  assertStringIncludes(install, "Could not reach download.docker.com");
  assertStringIncludes(install, "_docker_conflicting_packages");
  // daemon.json goes in before the packages (first dockerd start).
  assertEquals(
    install.indexOf("Write daemon.json ahead of the first dockerd start") <
      install.indexOf("Install the Docker packages"),
    true,
  );

  const template = await Deno.readTextFile(
    join(DOCKER_ROLE, "templates/docker.sources.j2"),
  );
  assertStringIncludes(template, "Signed-By: {{ _docker_repo_key_path }}");
  assertStringIncludes(template, "turbopanel_docker_offline_dir");

  const defaults = await Deno.readTextFile(
    join(DOCKER_ROLE, "defaults/main.yml"),
  );
  assertStringIncludes(defaults, "docker_key_policy: warn");
  assertStringIncludes(defaults, 'turbopanel_docker_offline_dir: ""');
  assertStringIncludes(defaults, 'turbopanel_docker_version: "5:29.');
  assertStringIncludes(defaults, "turbopanel_docker_log_driver: local");
  assertStringIncludes(defaults, "turbopanel_docker_log_max_size: 20m");
  // No descriptor limit by default: a fixed number could lower what containers inherit.
  assertStringIncludes(defaults, "turbopanel_docker_default_nofile: 0");

  const vars = await Deno.readTextFile(join(DOCKER_ROLE, "vars/main.yml"));
  assertStringIncludes(vars, "9DC858229FC7DD38854AE2D88D81803C0EBFCD88");
  for (
    const pkg of [
      "docker-ce",
      "docker-ce-cli",
      "containerd.io",
      "docker-buildx-plugin",
      "docker-compose-plugin",
    ]
  ) {
    assertStringIncludes(vars, `  - ${pkg}\n`);
  }
  for (const conflict of ["docker.io", "podman-docker", "containerd", "runc"]) {
    assertStringIncludes(vars, `  - ${conflict}\n`);
  }
  assertStringIncludes(vars, "Debian: debian");
  assertStringIncludes(vars, "Ubuntu: ubuntu");
  // Docker 29 stopped Raspbian packages; no claim of support.
  assertEquals(vars.includes("Raspbian: raspbian"), false);
  // The Debian fallback is the newest published suite, not an older one.
  assertStringIncludes(vars, "Debian: trixie");
  assertStringIncludes(vars, "Ubuntu: noble");
});

test("daemon.json defaults: log rotation and limits are added only when absent, before first start", async () => {
  const merge = await Deno.readTextFile(
    join(DOCKER_ROLE, "tasks/daemon-json.yml"),
  );
  assertStringIncludes(merge, "log-driver");
  assertStringIncludes(merge, "max-size");
  assertStringIncludes(merge, "default-ulimits");
  // Operator values win: the defaults are filtered by the keys already there.
  assertStringIncludes(
    merge,
    "rejectattr('key', 'in', _docker_daemon_json_current.keys()",
  );
  const handlers = await Deno.readTextFile(
    join(DOCKER_ROLE, "handlers/main.yml"),
  );
  assertStringIncludes(handlers, "_docker_fresh_install");
  // Left at Docker's defaults.
  for (
    const key of [
      "userland-proxy",
      "userns-remap",
      "storage-driver",
      '"iptables"',
    ]
  ) {
    assertEquals(merge.includes(key), false, key);
  }
});

test("repo-key role implements the warn / enforce / bundled key policy", async () => {
  const tasks = await Deno.readTextFile(
    join(ORCH, "roles/repo-key/tasks/main.yml"),
  );
  const defaults = await Deno.readTextFile(
    join(ORCH, "roles/repo-key/defaults/main.yml"),
  );
  assertStringIncludes(defaults, "repo_key_policy: warn");
  assertStringIncludes(defaults, "repo_key_warn_days: 60");
  assertStringIncludes(
    tasks,
    "repo_key_policy in ['warn', 'enforce', 'bundled']",
  );
  assertStringIncludes(tasks, "when: repo_key_policy != 'bundled'");
  assertStringIncludes(tasks, "repository key fingerprint changed: expected");
  assertStringIncludes(tasks, "repo_key_policy == 'enforce'");
  assertStringIncludes(tasks, "rejectattr('expired')");
  assertStringIncludes(tasks, "using the copy shipped with TurboPanel");
});

test("no Galaxy role is referenced or fetched anywhere in the daemon repo", async () => {
  const scanned = [
    ...await listFiles(join(DAEMON_ROOT, "orchestration")),
    ...await listFiles(join(DAEMON_ROOT, "src")),
    ...await listFiles(join(DAEMON_ROOT, "scripts")),
    join(DAEMON_ROOT, "AGENTS.md"),
    join(DAEMON_ROOT, "deno.json"),
    join(DAEMON_ROOT, "THIRD_PARTY_NOTICES.md"),
  ];
  const offenders: string[] = [];
  for (const file of scanned) {
    if (file === import.meta.filename) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    if (
      text.includes(RETIRED_ROLE_AUTHOR) ||
      text.includes("requirements-docker") ||
      /ansible-galaxy\s+role\s+install/.test(text) ||
      text.includes("ensureGalaxyDockerRole")
    ) {
      offenders.push(file.slice(DAEMON_ROOT.length + 1));
    }
  }
  assertEquals(offenders, []);

  const requirements = await Deno.readTextFile(
    join(ORCH, "requirements.yml"),
  );
  assertEquals(/^roles:/m.test(requirements), false);
});
