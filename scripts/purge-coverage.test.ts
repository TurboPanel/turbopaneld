import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// The purge must undo what the install does. This guard reads the install side
// (the orchestration roles, playbooks and host scripts, and the installer) and
// fails when one of them names a host file purge.sh does not remove: an apt
// source, signing key, pin or apt config file, a systemd unit or drop-in, or
// Docker and containerd config. It also fails when a role holds a package at a
// version that the purge does not purge, since a hold makes `apt-get purge -y`
// refuse. Static text only: no network, no clock, sorted output.

const here = dirname(fromFileUrl(import.meta.url));
const repo = join(here, "..");
const purgePath = join(here, "purge.sh");

const SCAN_DIRS = [
  "orchestration/roles",
  "orchestration/playbooks",
  "orchestration/scripts",
];
const SCAN_FILES = ["scripts/run.sh"];
const TEXT_EXT = /\.(ya?ml|j2|sh|py|cfg|conf|service|timer|socket|slice)$/;
const UNIT_FILE = /\.(service|timer|socket|slice|path|mount|target)(\.j2)?$/;

// Host files that are not removed by path because a purged package owns them.
// Each entry names the package, which purge.sh must purge.
const PACKAGE_OWNED: Record<string, string> = {
  "/usr/share/keyrings/debsuryorg-archive-keyring.gpg":
    "debsuryorg-archive-keyring",
};

// systemd paths a role names that are not units the role installs. Each needs
// a reason.
const UNIT_PATHS_NOT_INSTALLED: Record<string, string> = {
  // php-series-prune deletes the distribution's own per-series unit override.
  "/etc/systemd/system/php{{": "removed by the role, never installed",
};

// Host files current and older installs write or wrote: the Galaxy role older
// releases used, the Docker role that replaced it, the key download copies the
// repo-key role writes next to each key, and the PHP key under its key policy.
// Several are computed or gone from the tree, so the scan cannot see them;
// purge.sh must still remove them.
const KNOWN_INSTALLED = [
  "/etc/apt/sources.list.d/docker.sources",
  "/etc/apt/sources.list.d/docker.list",
  "/etc/apt/sources.list.d/download_docker_com_linux_debian.list",
  "/etc/apt/sources.list.d/download_docker_com_linux_ubuntu.list",
  "/etc/apt/keyrings/docker.asc",
  "/etc/apt/keyrings/docker.asc.fetched",
  "/etc/apt/keyrings/docker.gpg",
  "/etc/apt/trusted.gpg.d/docker.asc",
  "/etc/apt/trusted.gpg.d/docker.gpg",
  "/etc/apt/sources.list.d/sury-php.sources",
  "/etc/apt/sources.list.d/sury-php.list",
  "/usr/share/keyrings/turbopanel-sury-php.gpg",
  "/usr/share/keyrings/turbopanel-sury-php.gpg.fetched",
];

const PATH_RE =
  /\/(?:etc\/apt|usr\/share\/keyrings|etc\/systemd\/system|etc\/docker|etc\/containerd)\/[A-Za-z0-9_.@+-]*(?:\/[A-Za-z0-9_.@+-]+)*(\/?{{)?/g;

/** Drops shell/YAML comment lines, trailing ` # ...` comments and Jinja comments. */
function stripComments(text: string): string {
  return text
    .replace(/{#[\s\S]*?#}/g, "")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s#\s.*$/, ""))
    .join("\n");
}

/** Host path literals under the watched prefixes; a templated one ends in `{{`. */
function hostPaths(text: string): string[] {
  const out = new Set<string>();
  for (const match of stripComments(text).matchAll(PATH_RE)) {
    const path = match[0].replace(/[.]+$/, "");
    if (/\/$/.test(path) && !match[1]) continue;
    out.add(path);
  }
  return [...out].sort();
}

async function walk(dir: string, into: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) await walk(path, into);
    else if (entry.isFile) into.push(path);
  }
}

async function installFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) await walk(join(repo, dir), files);
  for (const file of SCAN_FILES) files.push(join(repo, file));
  return files
    .filter((f) => {
      const rel = relative(repo, f);
      if (rel.startsWith("orchestration/scripts/")) return !/\.md$/.test(f);
      return TEXT_EXT.test(f);
    })
    .sort();
}

async function purgeCode(): Promise<string> {
  return stripComments(await Deno.readTextFile(purgePath));
}

function shellList(code: string, name: string): string[] {
  const match = code.match(new RegExp(`^${name}="([^"]*)"`, "m"));
  assert(match, `${name} is missing from purge.sh`);
  return match[1].split(/\s+/).filter(Boolean);
}

function mentions(code: string, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![A-Za-z0-9_.@+/-])`).test(code);
}

/**
 * The unit file a systemd path installs: the file inside a drop-in or wants
 * dir. A bare drop-in dir installs nothing on its own and gives null.
 */
function unitName(path: string): string | null {
  const parts = path.slice("/etc/systemd/system/".length).split("/");
  if (/\.(d|wants|requires)$/.test(parts[0])) return parts[1] || null;
  return parts[0] || null;
}

function unitIsPurged(name: string, extra: string[]): boolean {
  return /^turbopanel/.test(name) || extra.includes(name);
}

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * Role variables that hold lists, from the two YAML shapes roles use: a block
 * list under `name:` and an inline `[a, b]` list. A scalar becomes one item.
 */
function yamlLists(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = stripComments(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_]\w*):\s*(.*)$/);
    if (!m) continue;
    out.set(m[1], listValue(m[2], lines, i));
  }
  return out;
}

/** The list a `key: value` line at index i holds, block or inline. */
function listValue(rest: string, lines: string[], i: number): string[] {
  const value = rest.trim();
  if (value.startsWith("[")) {
    return value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(
      Boolean,
    );
  }
  if (value !== "") return [unquote(value)];
  const items: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const item = lines[j].match(/^\s*-\s+(.+)$/);
    if (!item) break;
    items.push(unquote(item[1]));
  }
  return items;
}

/** Expands `{{ var }}` through role variables; null when it cannot. */
function resolve(
  value: string,
  vars: Map<string, string[]>,
  depth = 0,
): string[] | null {
  const ref = value.match(/^{{\s*([A-Za-z_]\w*)\s*}}$/);
  if (!ref) return value.includes("{{") ? null : [value];
  const list = vars.get(ref[1]);
  if (!list || depth > 4) return null;
  const out: string[] = [];
  for (const item of list) {
    const got = resolve(item, vars, depth + 1);
    if (got === null) return null;
    out.push(...got);
  }
  return out;
}

type Held = { packages: string[]; unresolved: string[] };

/**
 * The packages a role file holds: `dpkg_selections` tasks with
 * `selection: hold` (name, or `{{ item }}` over its loop) and `apt-mark hold`
 * commands. Anything that cannot be read back to package names is unresolved.
 */
function heldPackages(text: string, vars: Map<string, string[]>): Held {
  const held: Held = { packages: [], unresolved: [] };
  const add = (raw: string) => {
    const got = resolve(unquote(raw), vars);
    if (got === null) held.unresolved.push(unquote(raw));
    else held.packages.push(...got);
  };
  const code = stripComments(text);
  for (const task of code.split(/^\s*- name:/m)) {
    if (!/selection:\s*["']?hold/.test(task)) continue;
    const name = task.match(/dpkg_selections:\s*\n\s+name:\s*(.+)/);
    if (!name) {
      held.unresolved.push("a hold without a dpkg_selections name");
      continue;
    }
    if (!/^{{\s*item\s*}}$/.test(unquote(name[1]))) {
      add(name[1]);
      continue;
    }
    const lines = task.split("\n");
    const at = lines.findIndex((l) => /^\s*(loop|with_items):/.test(l));
    if (at < 0) {
      held.unresolved.push("{{ item }} without a loop");
      continue;
    }
    const rest = lines[at].replace(/^\s*(loop|with_items):/, "");
    for (const item of listValue(rest, lines, at)) add(item);
  }
  for (const m of code.matchAll(/apt-mark\s+hold\s+([^\n;&|"'`]+)/g)) {
    for (const word of m[1].match(/{{[^}]*}}|\S+/g) ?? []) add(word);
  }
  if (/--set-selections/.test(code)) {
    held.unresolved.push("dpkg --set-selections");
  }
  return held;
}

/** Holds on packages the purge does not purge despite a hold, as messages. */
function holdGaps(
  files: { rel: string; text: string; vars: Map<string, string[]> }[],
  purged: string[],
): { gaps: string[]; held: string[] } {
  const gaps: string[] = [];
  const held = new Set<string>();
  for (const { rel, text, vars } of files) {
    const found = heldPackages(text, vars);
    for (const pkg of found.packages) {
      held.add(pkg);
      if (!purged.includes(pkg)) {
        gaps.push(`${rel}: holds ${pkg}, which purge.sh never purges`);
      }
    }
    for (const what of found.unresolved) {
      gaps.push(`${rel}: cannot tell which package is held (${what})`);
    }
  }
  return { gaps: gaps.sort(), held: [...held].sort() };
}

async function roleVars(rel: string): Promise<Map<string, string[]>> {
  const role = rel.match(/^orchestration\/roles\/([^/]+)\//);
  const vars = new Map<string, string[]>();
  if (!role) return vars;
  for (const sub of ["defaults/main.yml", "vars/main.yml"]) {
    try {
      const text = await Deno.readTextFile(
        join(repo, "orchestration/roles", role[1], sub),
      );
      for (const [k, v] of yamlLists(text)) vars.set(k, v);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return vars;
}

type Gap = { file: string; path: string; why: string };

async function findGaps(): Promise<{ gaps: Gap[]; seen: string[] }> {
  const code = await purgeCode();
  const ownedTrees = shellList(code, "TP_OWNED_TREES");
  const otherUnits = [
    ...shellList(code, "TP_OTHER_UNITS"),
    ...shellList(code, "TP_LEGACY_UNITS"),
  ];
  const gaps: Gap[] = [];
  const seen = new Set<string>();
  for (const file of await installFiles()) {
    const rel = relative(repo, file);
    const base = file.split("/").pop() ?? "";
    if (UNIT_FILE.test(base) && /\/(templates|files)\//.test(rel)) {
      const unit = base.replace(/\.j2$/, "");
      seen.add(`unit:${unit}`);
      if (!unitIsPurged(unit, otherUnits)) {
        gaps.push({
          file: rel,
          path: unit,
          why: "unit purge.sh does not remove",
        });
      }
    }
    for (const path of hostPaths(await Deno.readTextFile(file))) {
      seen.add(path);
      if (path.startsWith("/etc/systemd/system/")) {
        if (path in UNIT_PATHS_NOT_INSTALLED) continue;
        const name = unitName(path);
        // A fully templated name comes from a role variable; the unit
        // templates themselves are checked by file name above.
        if (name === null || name.startsWith("{{")) continue;
        if (!unitIsPurged(name, otherUnits)) {
          gaps.push({ file: rel, path, why: "unit purge.sh does not remove" });
        }
      } else if (/^\/etc\/(docker|containerd)\//.test(path)) {
        const owned = ownedTrees.some((t) =>
          path === t || path.startsWith(`${t}/`)
        );
        if (!owned) {
          gaps.push({
            file: rel,
            path,
            why: "outside every tree purge.sh deletes",
          });
        }
      } else if (path.endsWith("{{")) {
        gaps.push({
          file: rel,
          path,
          why: "templated apt path; name it in full",
        });
      } else if (path in PACKAGE_OWNED) {
        if (!mentions(code, PACKAGE_OWNED[path])) {
          gaps.push({ file: rel, path, why: "its package is not purged" });
        }
      } else if (!mentions(code, path)) {
        gaps.push({
          file: rel,
          path,
          why: "apt file purge.sh does not remove",
        });
      }
    }
  }
  return { gaps, seen: [...seen].sort() };
}

test("the path scanner skips comments and marks templated paths", () => {
  const text = [
    "# dest: /etc/apt/sources.list.d/commented.sources",
    "    dest: /etc/apt/sources.list.d/real.sources  # was /etc/apt/old.list",
    "{# path: /etc/apt/keyrings/jinja-comment.asc #}",
    'path: "/etc/systemd/system/turbopanel-{{ name }}.service"',
    "src: /etc/docker/daemon.json.",
  ].join("\n");
  assertEquals(hostPaths(text), [
    "/etc/apt/sources.list.d/real.sources",
    "/etc/docker/daemon.json",
    "/etc/systemd/system/turbopanel-{{",
  ]);
  assertEquals(
    unitName("/etc/systemd/system/docker.service.d/tp.conf"),
    "tp.conf",
  );
  assertEquals(unitName("/etc/systemd/system/docker.service.d"), null);
  assertEquals(
    unitName("/etc/systemd/system/turbopanel-x.service"),
    "turbopanel-x.service",
  );
});

test("a template right after an apt directory is flagged, not read as the directory", () => {
  assertEquals(
    hostPaths(
      [
        'dest: "/etc/apt/keyrings/{{ foo }}.asc"',
        "dest: /etc/apt/sources.list.d/{{ foo }}.sources",
      ].join("\n"),
    ),
    ["/etc/apt/keyrings/{{", "/etc/apt/sources.list.d/{{"],
  );
});

test("the scan sees the install side it guards", async () => {
  const { seen } = await findGaps();
  // If these vanish the scan stopped reading the roles, and passing means nothing.
  for (
    const expected of [
      "/etc/apt/sources.list.d/sury-php.sources",
      "/etc/docker/daemon.json",
      "/etc/systemd/system/docker.service.d/turbopanel-ingress-guard.conf",
      "unit:turbopanel-docker-egress.service",
      "unit:turbopaneld.service",
    ]
  ) {
    assert(seen.includes(expected), `the scan no longer finds ${expected}`);
  }
});

test("every apt file, unit and Docker config the install writes is removed by purge.sh", async () => {
  const { gaps } = await findGaps();
  assertEquals(
    gaps.map((g) => `${g.file}: ${g.path} (${g.why})`),
    [],
    "add the path to purge.sh (TP_DOCKER_APT_SOURCES, TP_DOCKER_APT_KEYS, " +
      "TP_SURY_APT_KEYS, TP_OTHER_UNITS or TP_OWNED_TREES) or name a turbopanel* unit",
  );
});

test("the Docker and PHP repository files of current and older installs are removed by purge.sh", async () => {
  const code = await purgeCode();
  const missing = KNOWN_INSTALLED.filter((p) => !mentions(code, p));
  assertEquals(missing, []);
  for (const [path, pkg] of Object.entries(PACKAGE_OWNED)) {
    assert(mentions(code, pkg), `${path}: package ${pkg} is not purged`);
  }
});

test("the hold reader names every held package and flags the rest", () => {
  const vars = yamlLists(
    "_docker_versioned_packages:\n  - docker-ce\n  - docker-ce-cli\nother: [nginx]\n",
  );
  // docker/tasks/install.yml with the real hold plus holds on packages the
  // purge never purges.
  const install = [
    "- name: Hold Docker at the installed version",
    "  ansible.builtin.dpkg_selections:",
    '    name: "{{ item }}"',
    "    selection: hold",
    '  loop: "{{ _docker_versioned_packages }}"',
    "- name: Hold a web server",
    "  ansible.builtin.dpkg_selections:",
    "    name: redis-server",
    "    selection: hold",
    "- name: Hold more",
    "  ansible.builtin.dpkg_selections:",
    '    name: "{{ item }}"',
    "    selection: hold",
    "  loop:",
    "    - containerd.io",
    '    - "{{ other }}"',
    "- name: Hold by command",
    "  ansible.builtin.command: apt-mark hold docker-buildx-plugin {{ unknown_var }}",
    "# apt-mark hold commented-out",
  ].join("\n");
  const docker = [
    "docker-ce",
    "docker-ce-cli",
    "containerd.io",
    "docker-buildx-plugin",
  ];
  const { gaps, held } = holdGaps(
    [{
      rel: "orchestration/roles/docker/tasks/install.yml",
      text: install,
      vars,
    }],
    docker,
  );
  assertEquals(held, [
    "containerd.io",
    "docker-buildx-plugin",
    "docker-ce",
    "docker-ce-cli",
    "nginx",
    "redis-server",
  ]);
  assertEquals(gaps, [
    "orchestration/roles/docker/tasks/install.yml: cannot tell which package is held ({{ unknown_var }})",
    "orchestration/roles/docker/tasks/install.yml: holds nginx, which purge.sh never purges",
    "orchestration/roles/docker/tasks/install.yml: holds redis-server, which purge.sh never purges",
  ]);
});

test("every package a role holds at a version is one the purge purges despite the hold", async () => {
  const code = await purgeCode();
  const docker = shellList(code, "TP_DOCKER_PACKAGES");
  const files = [];
  for (const file of await installFiles()) {
    const rel = relative(repo, file);
    files.push({
      rel,
      text: await Deno.readTextFile(file),
      vars: await roleVars(rel),
    });
  }
  const { gaps, held } = holdGaps(files, docker);
  assertEquals(gaps, []);
  // The Docker role holds these; if the reader stops seeing them it is broken.
  for (const pkg of ["docker-ce", "docker-ce-cli"]) {
    assert(held.includes(pkg), `the hold reader no longer finds ${pkg}`);
  }
  const purgeLines = code.split("\n").filter((l) => /apt-get purge -y/.test(l));
  assertEquals(purgeLines.length, 1, purgeLines.join("\n"));
  assert(
    purgeLines[0].includes("--allow-change-held-packages"),
    "the purge would refuse a held package",
  );
});

function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  assert(start >= 0, `${name} is missing from purge.sh`);
  const end = source.indexOf("\n}\n", start + 1);
  return source.slice(start + 1, end + 2);
}

test("the purge selects every package a role holds when dpkg reports it held", async () => {
  const files = [];
  for (const file of await installFiles()) {
    const rel = relative(repo, file);
    files.push({
      rel,
      text: await Deno.readTextFile(file),
      vars: await roleVars(rel),
    });
  }
  const { held } = holdGaps(files, []);
  assert(held.length > 0, "the hold reader found no held package");
  const source = await Deno.readTextFile(purgePath);
  const constants = ["TP_DOCKER_PACKAGES", "TP_DPKG_ON_DISK"].map((name) => {
    const line = source.match(new RegExp(`^${name}=.*$`, "m"));
    assert(line, `${name} is missing from purge.sh`);
    return line[0];
  });
  const functions = [
    "tp_file_add",
    "tp_pkg_state_in",
    "tp_pkg_installed",
    "tp_pkg_purgeable",
    "tp_collect_docker_packages",
  ].map((name) => shellFunction(source, name));
  // dpkg's own wording for a package held at its installed version.
  const bin = await Deno.makeTempDir({ prefix: "tp-purge-held-" });
  await Deno.writeTextFile(
    join(bin, "dpkg-query"),
    [
      "#!/bin/sh",
      'for last in "$@"; do :; done',
      `case " ${
        held.join(" ")
      } " in *" $last "*) printf 'hold ok installed\\n' ;; *) exit 1 ;; esac`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const tmp = await Deno.makeTempDir({ prefix: "tp-purge-held-tmp-" });
  const out = await new Deno.Command("sh", {
    args: [
      "-c",
      [
        ...constants,
        ...functions,
        `TP_TMP=${tmp}`,
        "tp_collect_docker_packages",
        'cat "$TP_TMP/docker.pkgs"',
      ].join("\n"),
    ],
    env: { PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}` },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const selected = new TextDecoder().decode(out.stdout).trim().split("\n");
  assertEquals(
    held.filter((pkg) => !selected.includes(pkg)),
    [],
    new TextDecoder().decode(out.stderr),
  );
});
