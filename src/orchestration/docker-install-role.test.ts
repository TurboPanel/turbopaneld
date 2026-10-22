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

test("the docker role installs Docker itself from the official apt repository", async () => {
  const main = await Deno.readTextFile(join(DOCKER_ROLE, "tasks/main.yml"));
  assertStringIncludes(main, "ansible.builtin.include_tasks: install.yml");
  // Fast path: a healthy Docker is never touched, so an offline host is fine.
  assertStringIncludes(main, "when: not _docker_ready | bool");

  const install = await Deno.readTextFile(
    join(DOCKER_ROLE, "tasks/install.yml"),
  );
  assertStringIncludes(install, "{{ _docker_repo_base }}");
  assertStringIncludes(install, "Signed-By: {{ _docker_repo_key_path }}");
  assertStringIncludes(install, "_docker_repo_key_fingerprint");
  assertStringIncludes(install, 'name: "{{ _docker_packages }}"');
  assertStringIncludes(install, "Could not reach download.docker.com");

  const vars = await Deno.readTextFile(join(DOCKER_ROLE, "vars/main.yml"));
  assertStringIncludes(vars, "_docker_repo_base: https://download.docker.com/");
  assertStringIncludes(
    vars,
    "_docker_repo_key_fingerprint: 9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
  );
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
  for (const distro of ["Debian: debian", "Ubuntu: ubuntu"]) {
    assertStringIncludes(vars, distro);
  }
  for (const fallback of ["Debian: bookworm", "Ubuntu: noble"]) {
    assertStringIncludes(vars, fallback);
  }
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
