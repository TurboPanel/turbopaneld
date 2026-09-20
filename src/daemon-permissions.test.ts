import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  DAEMON_RUN_PROGRAMS,
  DAEMON_UNSCOPED_GRANTS,
  DAEMON_WRITABLE_VENDOR_DIRS,
  DAEMON_WRITE_PATHS,
  INSTALLER_VENDOR_DIRS,
  renderDaemonPermissionFlags,
  renderInstallerPermissionFlags,
  RUN_TARGETS_INSIDE_WRITE_GRANT,
} from "./daemon-permissions.ts";
import {
  BOOTSTRAP_STAMP_FILE,
  GALAXY_DOCKER_STAMP_FILE,
} from "./orchestration/bootstrap-stamp.ts";
import {
  ANSIBLE_CURRENT_DIR,
  ANSIBLE_INSTALL_DIR,
  CACHE_DIR,
  cloudflaredDir,
  GALAXY_COLLECTIONS_DIR,
  GALAXY_VENDOR_ROLES_DIR,
  PYTHON_CURRENT_DIR,
  PYTHON_RUNTIME_DIR,
  RUNTIMES_DIR,
  UV_CURRENT_DIR,
  UV_INSTALL_DIR,
} from "./orchestration/paths.ts";
import { PROD_RUNTIME_DIR_DEFAULT } from "./paths/layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const root = join(dirname(fromFileUrl(import.meta.url)), "..");

const DENO_JSON = join(root, "deno.json");
const SERVICE_TEMPLATE = join(
  root,
  "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2",
);
const RUN_SH = join(root, "scripts/run.sh");

/** Permissions that must never appear unscoped on a production daemon path. */
const SCOPED_ONLY = ["read", "write", "run", "ffi", "sys"] as const;

/**
 * Every `deno run` / `deno compile` invocation on a production path, with its
 * flag list. `source` names the file for failure messages.
 */
async function productionInvocations(): Promise<
  Array<{ source: string; flags: string[] }>
> {
  const out: Array<{ source: string; flags: string[] }> = [];

  const denoJson = JSON.parse(await Deno.readTextFile(DENO_JSON)) as {
    tasks: Record<string, string>;
  };
  for (
    const name of ["compile", "compile:linux-amd64", "compile:linux-arm64"]
  ) {
    const task = denoJson.tasks[name];
    if (!task) throw new TypeError(`deno.json lost task ${name}`);
    out.push({ source: `deno.json ${name}`, flags: task.split(/\s+/) });
  }

  const template = await Deno.readTextFile(SERVICE_TEMPLATE);
  const jsExec = template.split("\n").find((line) =>
    line.startsWith("ExecStart=") && line.includes("turbopanel_daemon_js")
  );
  if (!jsExec) throw new TypeError("service template lost the JS ExecStart");
  out.push({ source: "turbopaneld.service.j2 js", flags: jsExec.split(/\s+/) });

  const runSh = await Deno.readTextFile(RUN_SH);
  const installer = /^TP_INSTALLER_DENO_PERMISSIONS="([^"]+)"$/m.exec(runSh)
    ?.[1];
  if (!installer) {
    throw new TypeError("run.sh lost TP_INSTALLER_DENO_PERMISSIONS");
  }
  out.push({ source: "run.sh installer", flags: installer.split(/\s+/) });
  // Every JS-fallback `deno run` in run.sh must use that variable.
  for (const line of runSh.split("\n")) {
    if (
      line.includes('"$DENO_BIN" run ') && !line.trimStart().startsWith("#")
    ) {
      out.push({ source: `run.sh: ${line.trim()}`, flags: line.split(/\s+/) });
    }
  }
  return out;
}

test("no production daemon path grants --allow-all", async () => {
  for (const { source, flags } of await productionInvocations()) {
    for (const flag of flags) {
      if (flag === "--allow-all" || flag === "-A") {
        throw new TypeError(`${source} grants ${flag}`);
      }
    }
  }
});

test("no production daemon path carries a bare read/write/run/ffi/sys grant", async () => {
  for (const { source, flags } of await productionInvocations()) {
    for (const kind of SCOPED_ONLY) {
      if (flags.includes(`--allow-${kind}`)) {
        throw new TypeError(`${source} grants bare --allow-${kind}`);
      }
    }
  }
});

test("unscoped net/env grants appear only with their documented reason, and net carries --deny-net", async () => {
  assertEquals(Object.keys(DAEMON_UNSCOPED_GRANTS).sort(), ["env", "net"]);
  for (const reason of Object.values(DAEMON_UNSCOPED_GRANTS)) {
    assertEquals(reason.length > 20, true);
  }
  for (const { source, flags } of await productionInvocations()) {
    if (!source.startsWith("run.sh:")) {
      // The rendered sets carry the grants; the inline run.sh lines carry the
      // variable reference and are checked below.
      assertEquals(flags.includes("--allow-net"), true, `${source} net`);
      assertEquals(
        flags.some((f) => f.startsWith("--deny-net=169.254.169.254")),
        true,
        `${source} must pair --allow-net with --deny-net for metadata endpoints`,
      );
    }
  }
});

test("deno.json compile tasks and the JS ExecStart render the same daemon contract", async () => {
  const expected = renderDaemonPermissionFlags();
  const invocations = await productionInvocations();
  for (
    const name of [
      "deno.json compile",
      "deno.json compile:linux-amd64",
      "deno.json compile:linux-arm64",
      "turbopaneld.service.j2 js",
    ]
  ) {
    const found = invocations.find((entry) => entry.source === name);
    if (!found) throw new TypeError(`missing invocation ${name}`);
    const granted = found.flags.filter((f) =>
      f.startsWith("--allow-") || f.startsWith("--deny-")
    );
    assertEquals(granted, expected, name);
  }
});

test("run.sh's installer set matches renderInstallerPermissionFlags and every JS-fallback run uses it", async () => {
  const invocations = await productionInvocations();
  const installer = invocations.find((e) => e.source === "run.sh installer");
  if (!installer) throw new TypeError("missing run.sh installer set");
  assertEquals(installer.flags, renderInstallerPermissionFlags());
  const inline = invocations.filter((e) => e.source.startsWith("run.sh:"));
  assertEquals(inline.length >= 3, true, "expected three JS-fallback runs");
  for (const entry of inline) {
    assertEquals(
      entry.flags.includes("$TP_INSTALLER_DENO_PERMISSIONS"),
      true,
      entry.source,
    );
  }
});

test("the JS ExecStart moves DENO_DIR out of the root-owned install root", async () => {
  const template = await Deno.readTextFile(SERVICE_TEMPLATE);
  assertEquals(
    template.includes(
      "Environment=DENO_DIR={{ turbopanel_daemon_state_dir | default('/var/lib/turbopanel') }}/deno-cache",
    ),
    true,
  );
});

test("install-root writes are the daemon cache dirs plus the installer's orchestration runtime", () => {
  const allowed = [...DAEMON_WRITABLE_VENDOR_DIRS, ...INSTALLER_VENDOR_DIRS];
  for (const path of DAEMON_WRITE_PATHS) {
    if (path.startsWith("/opt/turbopanel")) {
      assertEquals(allowed.includes(path), true, path);
      assertEquals(path.startsWith(`${PROD_RUNTIME_DIR_DEFAULT}/`), true, path);
    }
  }
  // Never the install root or the vendor root themselves (ancestors of every
  // legitimate grant, so equality only) …
  for (const ancestor of ["/opt/turbopanel", PROD_RUNTIME_DIR_DEFAULT]) {
    assertEquals(DAEMON_WRITE_PATHS.includes(ancestor), false, ancestor);
  }
  // … and never the binary, the orchestration tree, or a runtime the daemon
  // is launched from / builds with, nor anything beneath them.
  for (
    const forbidden of [
      "/opt/turbopanel/bin",
      "/opt/turbopanel/share",
      "/opt/turbopanel/lib",
      `${PROD_RUNTIME_DIR_DEFAULT}/deno`,
      `${PROD_RUNTIME_DIR_DEFAULT}/node`,
      `${PROD_RUNTIME_DIR_DEFAULT}/buildkit`,
      `${PROD_RUNTIME_DIR_DEFAULT}/railpack`,
    ]
  ) {
    for (const path of DAEMON_WRITE_PATHS) {
      assertEquals(
        path === forbidden || path.startsWith(`${forbidden}/`),
        false,
        `${path} is under ${forbidden}`,
      );
    }
  }
});

/**
 * `deno compile` bakes one grant set and the compiled binary cannot widen it,
 * yet `run.sh` runs the root-only installer verbs through that binary on
 * native hosts. Every path the orchestration bootstrap writes must therefore
 * sit inside the daemon write grant — this is the check the first canary
 * install after the 2026-09-19 hardening failed (`Requires write access to
 * "/opt/turbopanel/vendor/uv/<version>"`).
 */
test("every orchestration bootstrap write target sits inside the compiled write grant", () => {
  const targets = [
    UV_INSTALL_DIR,
    UV_CURRENT_DIR,
    CACHE_DIR,
    PYTHON_RUNTIME_DIR,
    PYTHON_CURRENT_DIR,
    ANSIBLE_INSTALL_DIR,
    ANSIBLE_CURRENT_DIR,
    GALAXY_VENDOR_ROLES_DIR,
    GALAXY_COLLECTIONS_DIR,
    BOOTSTRAP_STAMP_FILE,
    GALAXY_DOCKER_STAMP_FILE,
    cloudflaredDir(),
  ];
  for (const target of targets) {
    // The module constants follow the active layout (a dev checkout under
    // test); re-root them on the production vendor dir the grant names.
    assertEquals(target.startsWith(`${RUNTIMES_DIR}/`), true, target);
    const production = join(
      PROD_RUNTIME_DIR_DEFAULT,
      target.slice(RUNTIMES_DIR.length + 1),
    );
    assertEquals(
      DAEMON_WRITE_PATHS.some((root) =>
        production === root || production.startsWith(`${root}/`)
      ),
      true,
      `${production} is outside the daemon write grant`,
    );
  }
});

/**
 * Deno refuses every write to a path in `--allow-run`, whatever
 * `--allow-write` grants, and says nothing about it at compile time. The two
 * lists overlap by design (the compiled binary installs the tools it runs),
 * so the overlap has to be enumerated and each entry materialised by
 * something other than a Deno file API — see
 * {@link RUN_TARGETS_INSIDE_WRITE_GRANT}.
 */
test("every run target inside a write grant is declared as subprocess-installed", async () => {
  const declared = new Set(RUN_TARGETS_INSIDE_WRITE_GRANT);
  const found = new Set<string>();
  for (const { source, flags } of await productionInvocations()) {
    if (source.startsWith("run.sh:")) continue; // variable reference only
    const runs = readGrant(flags, "--allow-run");
    const writes = readGrant(flags, "--allow-write");
    for (const program of runs) {
      if (!program.startsWith("/")) continue;
      const inWriteGrant = writes.some((root) =>
        program === root || program.startsWith(`${root}/`)
      );
      if (!inWriteGrant) continue;
      found.add(program);
      assertEquals(
        declared.has(program),
        true,
        `${source}: ${program} is both a run target and inside the write grant. ` +
          "Deno refuses Deno-side writes to it — install it with " +
          "installVendorExecutable (scoped-writes.ts) and add it " +
          "to RUN_TARGETS_INSIDE_WRITE_GRANT.",
      );
    }
  }
  // No stale entries: a path that left the run allowlist must leave this list.
  assertEquals(
    RUN_TARGETS_INSIDE_WRITE_GRANT.filter((p) => !found.has(p)),
    [],
    "these no longer overlap a write grant; drop them from RUN_TARGETS_INSIDE_WRITE_GRANT",
  );
});

test("the vendored binaries the installer writes go through installVendorExecutable", async () => {
  for (const name of ["uv.ts", "cloudflared.ts"]) {
    const text = await Deno.readTextFile(
      join(root, "src/orchestration", name),
    );
    assertEquals(
      text.includes("installVendorExecutable"),
      true,
      `${name} must install its vendored binary through installVendorExecutable`,
    );
    for (const api of ["Deno.copyFile(", "Deno.chmod("]) {
      assertEquals(
        text.includes(api),
        false,
        `${name} uses ${api}: Deno refuses that on a --allow-run path`,
      );
    }
  }
});

/** Split `--allow-x=a,b,c` out of a flag list; `[]` when the flag is absent. */
function readGrant(flags: string[], flag: string): string[] {
  const entry = flags.find((f) => f.startsWith(`${flag}=`));
  return entry ? entry.slice(flag.length + 1).split(",") : [];
}

// --- spawn allowlist derived from source --------------------------------

const SPAWN_RE =
  /(?:new\s+Deno\.Command|(?:\b(?:io|deps)\.)?\brun(?:Fn|Command|Host|Docker|Streamed|Logged)?|spawn(?:Command|Text|Host))\(\s*"([^"]+)"/g;

async function literalSpawnTargets(): Promise<Set<string>> {
  const targets = new Set<string>();
  for await (const entry of walk(join(root, "src"))) {
    if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
    if (entry.includes("/src/testing/")) continue;
    const text = await Deno.readTextFile(entry);
    for (const match of text.matchAll(SPAWN_RE)) {
      const name = match[1];
      if (name) targets.add(name);
    }
  }
  return targets;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

test("every literal program the daemon spawns is on the run allowlist", async () => {
  const granted = new Set(DAEMON_RUN_PROGRAMS);
  const missing = [...await literalSpawnTargets()]
    .filter((name) => !granted.has(name))
    .sort((a, b) => a.localeCompare(b));
  assertEquals(
    missing,
    [],
    "add these to DAEMON_RUN_PROGRAMS (src/daemon-permissions.ts) or stop spawning them",
  );
});

test("vendored tool grants carry the pinned versions, not `current`", () => {
  for (const tool of ["uv", "ansible", "cloudflared"]) {
    const entries = DAEMON_RUN_PROGRAMS.filter((p) =>
      p.startsWith(`${PROD_RUNTIME_DIR_DEFAULT}/${tool}/`)
    );
    assertEquals(entries.length > 0, true, tool);
    for (const entry of entries) {
      assertEquals(entry.includes("/current/"), false, entry);
    }
  }
});
