import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "../orchestration/assets.ts";
import { BACKUP_ROOT as GATE_BACKUP_ROOT } from "../../orchestration/roles/docker-gate/files/platform.ts";
import {
  BACKUP_KIND_DIRNAMES,
  BACKUP_ROOT,
  backupKindDir,
  backupRelativePath,
  BUILD_SIBLING_DIR,
  DAEMON_CONFIG_LEAVES,
  DAEMON_STATE_LEAVES,
  panelDatabaseBackupDir,
  PROD_BACKUP_DIR_DEFAULT,
  PROD_STATE_DIR_DEFAULT,
  resolveBackupPath,
  restoreIntentsDir,
  ROLE_MADE_FOLDERS,
  RUN_FOLDER_UNITS,
} from "./layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const LAYOUT = { backupDir: "/backup", daemonStateDir: "/var/lib/turbopanel" };

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(DAEMON_ROOT, rel));
}

test("the backup root is named once and has three kind folders", () => {
  assertEquals(BACKUP_ROOT, "/backup");
  assertEquals(PROD_BACKUP_DIR_DEFAULT, BACKUP_ROOT);
  assertEquals(GATE_BACKUP_ROOT, BACKUP_ROOT);
  assertEquals(backupKindDir(LAYOUT, "managed"), "/backup/managed");
  assertEquals(backupKindDir(LAYOUT, "volumes"), "/backup/volumes");
  assertEquals(backupKindDir(LAYOUT, "panel"), "/backup/panel");
  assertEquals(panelDatabaseBackupDir(LAYOUT), "/backup/panel/database");
  assertEquals(Object.keys(BACKUP_KIND_DIRNAMES).sort(), [
    "managed",
    "panel",
    "volumes",
  ]);
});

test("restore intents are daemon state, not backup data", () => {
  assertEquals(
    restoreIntentsDir(LAYOUT),
    "/var/lib/turbopanel/backup/restore-intents",
  );
});

test("a stored backup path is accepted absolute or relative", () => {
  const rel = "managed/abc/bk_1.dump";
  assertEquals(backupRelativePath(LAYOUT, rel), rel);
  assertEquals(backupRelativePath(LAYOUT, `/backup/${rel}`), rel);
  assertEquals(resolveBackupPath(LAYOUT, rel), `/backup/${rel}`);
  assertEquals(resolveBackupPath(LAYOUT, `/backup/${rel}`), `/backup/${rel}`);
  // A root with a trailing slash behaves the same.
  assertEquals(
    resolveBackupPath({ backupDir: "/mnt/disk/" }, rel),
    `/mnt/disk/${rel}`,
  );
});

test("a stored backup path outside the root or with odd parts is refused", () => {
  for (
    const bad of [
      "/etc/passwd",
      "/backupfoo/managed/x",
      "/backup",
      "/backup/",
      "../managed/x",
      "managed/../x",
      "managed//x",
      "./managed/x",
      "",
    ]
  ) {
    assertThrows(() => backupRelativePath(LAYOUT, bad), Error, "backup path");
  }
});

test("folders made by roles and units are not daemon leaves, and none repeats", () => {
  const leaves = {
    config: new Set(DAEMON_CONFIG_LEAVES.map((l) => l.name)),
    state: new Set(DAEMON_STATE_LEAVES.map((l) => l.name)),
    log: new Set<string>(),
  };
  const seen = new Set<string>();
  for (const folder of ROLE_MADE_FOLDERS) {
    const key = `${folder.root}/${folder.name}`;
    assert(!seen.has(key), `${key} listed twice`);
    seen.add(key);
    assert(!leaves[folder.root].has(folder.name), `${key} is also a leaf`);
    assert(folder.madeBy.length > 0, `${key} names no maker`);
  }
});

test("the former siblings are folders inside the main trees", () => {
  for (
    const key of [
      "state/hosting-caddy",
      "state/docker-gate",
      "log/apache",
    ]
  ) {
    assert(
      ROLE_MADE_FOLDERS.some((f) => `${f.root}/${f.name}` === key),
      `${key} is missing from the roles table`,
    );
  }
});

test("the build folder is the one deliberate sibling of the state root", async () => {
  assertEquals(BUILD_SIBLING_DIR, `${PROD_STATE_DIR_DEFAULT}-build`);
  const role = parse(
    await read("orchestration/roles/build-user/defaults/main.yml"),
  );
  assertEquals((role as Record<string, string>).build_root, BUILD_SIBLING_DIR);
  assert(
    (await read("orchestration/scripts/tp-host")).includes(
      'R_BUILD="$P/var/lib/turbopanel-build"',
    ),
  );
});

test("the run folders are listed once, each for one unit", () => {
  assertEquals(new Set(RUN_FOLDER_UNITS).size, RUN_FOLDER_UNITS.length);
  assert(RUN_FOLDER_UNITS.includes("turbopanel-hosting-caddy"));
});

test("the hosting Caddy, Docker gate and Apache roles use nested folders inside the main trees", async () => {
  const gate = parse(
    await read("orchestration/roles/docker-gate/defaults/main.yml"),
  ) as Record<string, string>;
  assertEquals(gate.docker_gate_cache_dir, "/var/cache/turbopanel/docker-gate");
  assertEquals(
    gate.docker_gate_approval_state_dir,
    "{{ turbopanel_daemon_state_dir }}/docker-gate",
  );
  const unit = await read(
    "orchestration/roles/docker-gate/templates/turbopanel-docker-gate.service.j2",
  );
  assert(unit.includes("StateDirectory=turbopanel/docker-gate\n"));
  assert(unit.includes("CacheDirectory=turbopanel/docker-gate\n"));
  const apache = parse(
    await read("orchestration/roles/apache/defaults/main.yml"),
  ) as Record<string, string>;
  assertEquals(apache.apache_logs_directory, "turbopanel/apache");
  const tasks = await read("orchestration/roles/hosting-caddy/tasks/main.yml");
  assert(tasks.includes('- "{{ turbopanel_state_dir }}"'));
  assert(!tasks.includes("Remove the old root-written hosting Caddy store"));
});

test("the egress helper lives in the install's lib folder", async () => {
  const defaults = await read("orchestration/roles/docker/defaults/main.yml");
  assert(
    defaults.includes(
      "turbopanel_docker_egress_script: /opt/turbopanel/lib/docker-egress",
    ),
  );
});

test("the panel dumps go to the panel backup folder and the upgrade backups beside them", async () => {
  const defaults = await read(
    "orchestration/roles/system-compose/defaults/main.yml",
  );
  assert(defaults.includes("/panel/database"));
  for (const play of ["instance-backup.yml", "instance-rollback.yml"]) {
    const text = await read(`orchestration/playbooks/${play}`);
    assert(text.includes("turbopanel_backup_dir }}/panel/"), play);
    assert(!text.includes("/control-plane/"), play);
  }
});
