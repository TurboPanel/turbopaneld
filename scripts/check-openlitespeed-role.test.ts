import { assert, assertEquals } from "@std/assert";
import { parse } from "yaml";
import { OPENLITESPEED_LSAPI_SOCKET_DIR } from "../src/deploy/site.ts";

const tasks = await Deno.readTextFile(
  new URL(
    "../orchestration/roles/openlitespeed/tasks/main.yml",
    import.meta.url,
  ),
);

const roleFile = (path: string) =>
  Deno.readTextFile(
    new URL(`../orchestration/roles/openlitespeed/${path}`, import.meta.url),
  );

/** Body of one top-level task, or `null` when it is nested or missing. */
function topLevelTask(name: string): string | null {
  const head = `\n- name: ${name}\n`;
  const at = tasks.indexOf(head);
  if (at === -1) return null;
  const next = tasks.indexOf("\n- name:", at + 1);
  return tasks.slice(at + 1, next === -1 ? undefined : next);
}

Deno.test("openlitespeed role creates fcgi-bin before copying lsperld.fpl", () => {
  const mkdir = tasks.indexOf(
    "Create fcgi-bin directory in the versioned tree",
  );
  const copy = tasks.indexOf("Install lsperld.fpl only");
  assert(mkdir !== -1, "missing fcgi-bin directory task");
  assert(copy !== -1, "missing lsperld.fpl copy task");
  assert(mkdir < copy, "fcgi-bin must exist before lsperld.fpl is copied");
});

Deno.test("openlitespeed role links bin/litespeed outside the install block", () => {
  const head = "- name: Create litespeed exec name expected by lswsctrl";
  const link = tasks.indexOf(`\n${head}\n`);
  assert(
    link !== -1,
    "litespeed link must be a top-level task, not inside the install block",
  );
  const check = tasks.indexOf(
    "Assert vendored OpenLiteSpeed binary is a regular file",
  );
  assert(check !== -1 && check < link, "target must be validated first");
  const body = tasks.slice(link + 1, tasks.indexOf("\n- name:", link + 1));
  assert(body.includes('src: "openlitespeed"'), "link must be relative");
  assert(body.includes("state: link"), "must be a symlink");
  assert(body.includes("follow: false"), "must not follow an existing dest");
  assert(body.includes("force: true"), "must replace a stale link");
});

Deno.test("openlitespeed role installs mime.properties on every converge", async () => {
  const body = topLevelTask("Install OpenLiteSpeed mime.properties");
  assert(body, "mime.properties must be a top-level task, not install-only");
  assert(body.includes("src: mime.properties"), "must ship with the role");
  assert(!body.includes("remote_src"), "must not need the release tarball");
  assert(body.includes("owner: root"), "config stays root-owned");
  assert(body.includes('group: "{{ openlitespeed_service_group }}"'));
  assert(body.includes('mode: "0640"'));
  const mime = await roleFile("files/mime.properties");
  assert(mime.includes("text/html"), "role must carry mime.properties");
});

Deno.test("openlitespeed role ensures runtime dirs outside the install block", () => {
  const body = topLevelTask(
    "Ensure writable server-root-relative runtime dirs",
  );
  assert(body, "runtime dirs must be a top-level task, not install-only");
  for (const dir of ["cachedata", "autoupdate", "tmp", "tmp/ocspcache"]) {
    assert(body.includes(`- ${dir}\n`), `missing ${dir}`);
  }
});

Deno.test("openlitespeed role keeps the config tree root-owned", () => {
  const body = topLevelTask("Keep the OpenLiteSpeed config tree root-owned");
  assert(body, "missing recursive ownership task");
  assert(body.includes("owner: root"));
  assert(body.includes("recurse: true"));
  assert(!body.includes("mode:"), "ownership only: the daemon sets modes");
  assert(!/owner: (tp|"\{\{ turbopanel_user)/.test(tasks), "never tp-owned");
});

Deno.test("openlitespeed unit owns the LSAPI socket dir the renderer names", async () => {
  const unit = await roleFile("templates/turbopanel-openlitespeed.service.j2");
  const name = OPENLITESPEED_LSAPI_SOCKET_DIR.replace(/^\/run\//, "");
  assert(unit.includes(`RuntimeDirectory=${name}\n`));
  const body = topLevelTask("Ensure OpenLiteSpeed LSAPI socket directory");
  assert(body?.includes(`path: ${OPENLITESPEED_LSAPI_SOCKET_DIR}\n`));
});

type LsphpSeries = {
  version: string;
  packages: string[];
  arch_all: string[];
};

Deno.test("every vendored lsphp .deb is pinned with a sha256 per suite and arch", async () => {
  const defaults = parse(await roleFile("defaults/main.yml")) as {
    openlitespeed_lsphp_repo_base: string;
    openlitespeed_lsphp_deb_revision: string;
    openlitespeed_lsphp_series_map: Record<string, LsphpSeries>;
    openlitespeed_lsphp_sha256: Record<string, string>;
    openlitespeed_lsphp_runtime_packages: Record<string, string[]>;
  };
  // The old `pool/main/l/<pkg>/` layout is gone upstream (404).
  assert(defaults.openlitespeed_lsphp_repo_base.endsWith("/debian/pool/main"));
  const suites = Object.keys(defaults.openlitespeed_lsphp_runtime_packages);
  assertEquals(suites.sort(), ["bookworm", "trixie"]);
  const expected: string[] = [];
  for (const series of Object.values(defaults.openlitespeed_lsphp_series_map)) {
    const stem =
      `${series.version}-${defaults.openlitespeed_lsphp_deb_revision}`;
    for (const suite of suites) {
      for (const pkg of series.packages) {
        const arches = series.arch_all.includes(pkg)
          ? ["all"]
          : ["amd64", "arm64"];
        for (const arch of arches) {
          expected.push(`${pkg}_${stem}+${suite}_${arch}.deb`);
        }
      }
    }
  }
  const pinned = defaults.openlitespeed_lsphp_sha256;
  assertEquals(Object.keys(pinned).sort(), expected.sort());
  for (const [deb, sha] of Object.entries(pinned)) {
    assert(/^[0-9a-f]{64}$/.test(sha), `${deb}: bad sha256`);
  }
  // A bookworm build links libzip.so.4, which trixie does not ship.
  assert(
    defaults.openlitespeed_lsphp_runtime_packages.bookworm.includes("libzip4"),
  );
  assert(
    defaults.openlitespeed_lsphp_runtime_packages.trixie.includes("libzip5"),
  );
});

Deno.test("lsphp download is verified and its php.ini relocated", async () => {
  const series = await roleFile("tasks/lsphp-series.yml");
  assert(!series.includes("curl "), "downloads go through get_url");
  assert(
    series.includes(
      'url: "{{ openlitespeed_lsphp_repo_base }}/{{ _lsphp_suite }}/{{ item }}"',
    ),
  );
  assert(
    series.includes(
      'checksum: "sha256:{{ openlitespeed_lsphp_sha256[item] }}"',
    ),
  );
  assert(series.includes('dest: "{{ _lsphp_dest }}/bin/php.ini"'));
  assert(series.includes("extension_dir = "));
  const libs = series.indexOf("Ensure lsphp runtime libraries");
  const guard = series.indexOf("when: not _lsphp_pinned.stat.exists");
  assert(
    libs !== -1 && libs < guard,
    "libraries are ensured on every converge",
  );
});
