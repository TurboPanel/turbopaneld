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

// Every role file that holds a package at a version, and what it holds. The
// purge passes --allow-change-held-packages, and only for packages on its own
// list, so each held package must be one of TP_DOCKER_PACKAGES.
const HELD_PACKAGES: Record<string, string[]> = {
  "orchestration/roles/docker/tasks/install.yml": [
    "docker-ce",
    "docker-ce-cli",
  ],
};

// Host files the install changes being reviewed write or wrote on hosts that
// already exist (the Galaxy role on trunk and older releases, the Docker role
// that replaces it, and the PHP key under its key policy). Some are not in
// this tree yet, so the scan cannot see them; purge.sh must still remove them.
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
  "/usr/share/keyrings/turbopanel-sury-php.gpg.tmp",
];

const PATH_RE =
  /\/(?:etc\/apt|usr\/share\/keyrings|etc\/systemd\/system|etc\/docker|etc\/containerd)\/[A-Za-z0-9_.@+-]*(?:\/[A-Za-z0-9_.@+-]+)*({{)?/g;

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

test("every package a role holds at a version is one the purge purges despite the hold", async () => {
  const code = await purgeCode();
  const docker = shellList(code, "TP_DOCKER_PACKAGES");
  const holding: string[] = [];
  for (const file of await installFiles()) {
    const text = stripComments(await Deno.readTextFile(file));
    if (/selection:\s*["']?hold|apt-mark\s+hold|--set-selections/.test(text)) {
      holding.push(relative(repo, file));
    }
  }
  const unknown = holding.filter((f) => !(f in HELD_PACKAGES));
  assertEquals(unknown, [], "list each new hold in HELD_PACKAGES");
  for (const [file, pkgs] of Object.entries(HELD_PACKAGES)) {
    for (const pkg of pkgs) {
      assert(
        docker.includes(pkg),
        `${file} holds ${pkg}, which purge.sh never purges`,
      );
    }
  }
  const purgeLines = code.split("\n").filter((l) => /apt-get purge -y/.test(l));
  assertEquals(purgeLines.length, 1, purgeLines.join("\n"));
  assert(
    purgeLines[0].includes("--allow-change-held-packages"),
    "the purge would refuse a held package",
  );
});
