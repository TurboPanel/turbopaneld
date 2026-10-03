import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";
import { DOCKER_GATE_SOCKET_DIR } from "../permissions/daemon-permissions.ts";
import { PROD_RUN_DIR_DEFAULT } from "../paths/layout.ts";
import { GATE_ENV_KEYS } from "../../orchestration/roles/docker-gate/files/main.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The Docker gate's install (`orchestration/roles/docker-gate`), stage 1:
 * observe mode. The unit is root-owned, runs the vendored Deno with a scoped
 * permission set, and must stay inert (nothing routes through it, nothing is
 * refused). These pin the properties that keep it that way, and run the real
 * gate under the exact flags the unit renders.
 */
const ORCHESTRATION = join(DAEMON_ROOT, "orchestration");
const ROLE = join(ORCHESTRATION, "roles/docker-gate");
const read = (path: string) => Deno.readTextFile(join(ROLE, path));

const RENDER_PY = String.raw`
import json, sys
import jinja2

def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("yes", "on", "1", "true", "y", "t")

req = json.load(sys.stdin)
env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(req["dir"]),
    trim_blocks=True,
    lstrip_blocks=False,
    keep_trailing_newline=True,
    undefined=jinja2.StrictUndefined,
)
env.filters["bool"] = to_bool
json.dump(env.get_template(req["template"]).render(**req["vars"]), sys.stdout)
`;

async function hasJinja(python: string): Promise<boolean> {
  try {
    const { success } = await new Deno.Command(python, {
      args: ["-c", "import jinja2"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

async function findJinjaPython(): Promise<string | undefined> {
  const candidates = [
    Deno.env.get("TURBOPANEL_JINJA_PYTHON"),
    "/opt/turbopanel/vendor/ansible/current/bin/python3",
    "python3",
    "python",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const candidate of candidates) {
    if (await hasJinja(candidate)) return candidate;
  }
  return undefined;
}

const JINJA_PYTHON = await findJinjaPython();
// CI installs the Ansible toolchain (and Jinja2) before the tests run: there a
// missing renderer is a broken gate, not a reason to skip.
const RENDER_REQUIRED = Deno.env.get("CI") === "true";

type UnitVars = {
  docker_gate_platform_ro_roots: string[];
  docker_gate_platform_rw_roots: string[];
  docker_gate_approval_pubkeys: string;
  docker_gate_approval_pubkey_file: string;
  docker_gate_gid: string;
  docker_gate_dir: string;
  docker_gate_deno_bin: string;
  docker_gate_run_dir: string;
  docker_gate_socket: string;
  docker_gate_ro_run_dir: string;
  docker_gate_ro_socket: string;
  docker_gate_ingress_switch_file: string;
  docker_gate_upstream_socket: string;
  docker_gate_cache_dir: string;
  docker_gate_group: string;
  docker_gate_service_name: string;
  docker_gate_summary_seconds: number;
  docker_gate_bind_roots: string[];
  docker_gate_deny_prefixes_extra: string[];
  docker_gate_build_run_dir: string;
  docker_gate_build_socket: string;
  docker_gate_build_uid: string;
};

const DEFAULT_VARS: UnitVars = {
  docker_gate_gid: "9999",
  docker_gate_dir: "/opt/turbopanel/lib/docker-gate",
  docker_gate_deno_bin: "/opt/turbopanel/vendor/deno/current/deno",
  docker_gate_run_dir: "/run/turbopanel-gate",
  docker_gate_socket: "/run/turbopanel-gate/docker.sock",
  docker_gate_ro_run_dir: "/run/turbopanel-gate/ro",
  docker_gate_ro_socket: "/run/turbopanel-gate/ro/docker.sock",
  docker_gate_ingress_switch_file:
    "/opt/turbopanel/lib/docker-gate/ingress-socket.on",
  docker_gate_upstream_socket: "/var/run/docker.sock",
  docker_gate_cache_dir: "/var/cache/turbopanel-docker-gate",
  docker_gate_group: "tp",
  docker_gate_service_name: "turbopanel-docker-gate",
  docker_gate_summary_seconds: 300,
  docker_gate_bind_roots: ["/srv/users", "/var/lib/turbopanel/storage"],
  docker_gate_deny_prefixes_extra: ["/opt/turbopanel"],
  docker_gate_platform_ro_roots: [
    "/etc/turbopanel/proxysql",
    "/etc/turbopanel/orchestrator",
  ],
  docker_gate_platform_rw_roots: [
    "/var/lib/turbopanel/proxysql",
    "/var/lib/turbopanel/orchestrator",
    "/var/lib/turbopanel/managed",
  ],
  docker_gate_approval_pubkeys: "",
  docker_gate_approval_pubkey_file:
    "/opt/turbopanel/lib/docker-gate/approval.pub",
  docker_gate_build_run_dir: "/run/turbopanel-gate/build",
  docker_gate_build_socket: "/run/turbopanel-gate/build/docker.sock",
  docker_gate_build_uid: "999",
};

async function renderUnit(overrides: Partial<UnitVars> = {}): Promise<string> {
  assert(JINJA_PYTHON, "no Python with jinja2 found to render the unit");
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", RENDER_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({
        dir: join(ROLE, "templates"),
        template: "turbopanel-docker-gate.service.j2",
        vars: { ...DEFAULT_VARS, ...overrides },
      }),
    ),
  );
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, `render failed: ${new TextDecoder().decode(stderr)}`);
  return JSON.parse(new TextDecoder().decode(stdout));
}

function directives(unit: string, section: string): string[] {
  const found: string[] = [];
  let current = "";
  for (const line of unit.split("\n")) {
    const header = /^\[(\w+)\]\s*$/.exec(line);
    if (header) current = header[1];
    else if (current === section && /^\w+=/.test(line)) found.push(line);
  }
  return found;
}

const jinjaTest = (name: string, fn: () => Promise<void>) =>
  test({
    name,
    ignore: JINJA_PYTHON === undefined && !RENDER_REQUIRED,
    fn,
  });

jinjaTest(
  "the unit is observe-only, root-owned and pinned to the gate's own socket",
  async () => {
    const unit = await renderUnit();
    const service = directives(unit, "Service");
    assert(service.includes("User=root"));
    assert(service.includes("Environment=TP_DOCKER_GATE_MODE=observe"));
    assertFalse(
      /enforce/i.test(unit),
      "this stage has no enforce mode anywhere",
    );
    assert(
      service.includes(
        "Environment=TP_DOCKER_GATE_SOCKET=/run/turbopanel-gate/docker.sock",
      ),
    );
    assert(service.includes("Environment=TP_DOCKER_GATE_SOCKET_GID=9999"));
    assert(service.includes("Restart=always"));
    assertEquals(directives(unit, "Install"), ["WantedBy=multi-user.target"]);
  },
);

jinjaTest(
  "stage 4: the build listener lives in a root:tp directory of its own, for the daemon uid",
  async () => {
    const service = directives(await renderUnit(), "Service");
    assert(
      service.includes(
        "Environment=TP_DOCKER_GATE_BUILD_SOCKET=/run/turbopanel-gate/build/docker.sock",
      ),
    );
    assert(
      service.includes(
        "ExecStartPre=+/usr/bin/install -d -m 0750 -o root -g tp /run/turbopanel-gate/build",
      ),
    );
    assert(service.includes("Environment=TP_DOCKER_GATE_BUILD_UID=999"));
    const defaults = await read("defaults/main.yml");
    assertStringIncludes(
      defaults,
      'docker_gate_build_run_dir: "{{ docker_gate_run_dir }}/build"',
    );
    assertStringIncludes(defaults, "docker_gate_build_user: tp");
    const tasks = await read("tasks/install.yml");
    assertStringIncludes(
      tasks,
      "d {{ docker_gate_build_run_dir }} 0750 root {{ docker_gate_group }} -",
    );
    const noUid = directives(
      await renderUnit({ docker_gate_build_uid: "" }),
      "Service",
    );
    assertFalse(noUid.some((d) => d.includes("BUILD_UID")), "root-only token");
  },
);

jinjaTest(
  "signed approvals are off by default and their key is root-owned, outside daemon-writable trees",
  async () => {
    const off = directives(await renderUnit(), "Service");
    assertFalse(off.some((d) => d.includes("APPROVAL")), "inert by default");
    const on = directives(
      await renderUnit({ docker_gate_approval_pubkeys: "AAAA" }),
      "Service",
    );
    const line = on.find((d) => d.includes("TP_DOCKER_GATE_APPROVAL_PUBKEY="));
    assertEquals(
      line,
      "Environment=TP_DOCKER_GATE_APPROVAL_PUBKEY=/opt/turbopanel/lib/docker-gate/approval.pub",
    );
    const defaults = await read("defaults/main.yml");
    assertStringIncludes(
      defaults,
      'docker_gate_approval_pubkey_file: "{{ docker_gate_dir }}/approval.pub"',
    );
    const install = await read("tasks/install.yml");
    const task = install.slice(
      install.indexOf("Install the approval public key"),
      install.indexOf("Remove a stale approval"),
    );
    assertStringIncludes(task, "owner: root");
    assertStringIncludes(task, 'mode: "0640"');
    assertFalse(task.includes("/etc/turbopanel"));
  },
);

jinjaTest(
  "the socket directory is root-owned and outside the daemon-writable /run/turbopanel",
  async () => {
    const unit = await renderUnit();
    const gateDir: string = DOCKER_GATE_SOCKET_DIR;
    const tpRunDir: string = PROD_RUN_DIR_DEFAULT;
    assert(
      !gateDir.startsWith(`${tpRunDir}/`) && gateDir !== tpRunDir,
      "tp owns /run/turbopanel and could swap a socket directory under it",
    );
    assertEquals(DOCKER_GATE_SOCKET_DIR, DEFAULT_VARS.docker_gate_run_dir);
    assertStringIncludes(
      unit,
      `ExecStartPre=+/usr/bin/install -d -m 0750 -o root -g tp ${DOCKER_GATE_SOCKET_DIR}`,
    );
    const defaults = await read("defaults/main.yml");
    assertStringIncludes(
      defaults,
      `docker_gate_run_dir: ${DOCKER_GATE_SOCKET_DIR}`,
    );
    const tasks = await read("tasks/install.yml");
    assertStringIncludes(
      tasks,
      "d {{ docker_gate_run_dir }} 0750 root {{ docker_gate_group }} -",
    );
  },
);

jinjaTest(
  "stage 3: the read-only listener lives in a root-only directory of its own inside the gate's",
  async () => {
    const unit = await renderUnit();
    const service = directives(unit, "Service");
    assert(
      service.includes(
        "Environment=TP_DOCKER_GATE_RO_SOCKET=/run/turbopanel-gate/ro/docker.sock",
      ),
    );
    assert(
      service.includes(
        "ExecStartPre=+/usr/bin/install -d -m 0750 -o root -g root /run/turbopanel-gate/ro",
      ),
    );
    const defaults = await read("defaults/main.yml");
    assertStringIncludes(
      defaults,
      'docker_gate_ro_run_dir: "{{ docker_gate_run_dir }}/ro"',
    );
    assertStringIncludes(defaults, 'docker_gate_ingress_socket: ""');
    const tasks = await read("tasks/install.yml");
    assertStringIncludes(
      tasks,
      "d {{ docker_gate_ro_run_dir }} 0750 root root -",
    );
  },
);

test("stage 3: Traefik's switch is root-owned, sticky, and off unless turned on", async () => {
  const install = await read("tasks/install.yml");
  const on = install.slice(
    install.indexOf("Turn on Traefik's read-only gate socket"),
    install.indexOf("Turn off Traefik's read-only gate socket"),
  );
  assertStringIncludes(on, 'dest: "{{ docker_gate_ingress_switch_file }}"');
  assertStringIncludes(on, "owner: root");
  assertStringIncludes(on, 'mode: "0640"');
  // An empty variable (every update converge) neither writes nor removes it.
  for (const task of [on, install.slice(install.indexOf("Turn off Traefik"))]) {
    assertStringIncludes(
      task,
      "(docker_gate_ingress_socket | string | length) > 0",
    );
  }
  const defaults = await read("defaults/main.yml");
  assertStringIncludes(
    defaults,
    'docker_gate_ingress_switch_file: "{{ docker_gate_dir }}/ingress-socket.on"',
  );
  assertStringIncludes(
    await Deno.readTextFile(join(DAEMON_ROOT, "src/deploy/ingress.ts")),
    "/lib/docker-gate/ingress-socket.on",
  );
});

jinjaTest(
  "the gate runs with scoped Deno permissions and no way to spawn or reach the network",
  async () => {
    const unit = await renderUnit();
    const exec = directives(unit, "Service").find((d) =>
      d.startsWith("ExecStart=")
    );
    assert(exec !== undefined);
    const argv = exec.slice("ExecStart=".length).split(" ");
    assertEquals(argv[0], DEFAULT_VARS.docker_gate_deno_bin);
    assertEquals(argv[1], "run");
    for (
      const flag of ["--no-prompt", "--no-remote", "--no-config", "--no-lock"]
    ) {
      assert(argv.includes(flag), flag);
    }
    assert(argv.includes("--allow-read"), "symlink resolution reads anywhere");
    assert(
      argv.includes(
        "--allow-write=/run/turbopanel-gate,/var/run/docker.sock",
      ),
    );
    assert(
      argv.includes(
        "--allow-net=unix:/run/turbopanel-gate/docker.sock,unix:/run/turbopanel-gate/ro/docker.sock,unix:/run/turbopanel-gate/build/docker.sock,unix:/var/run/docker.sock",
      ),
    );
    assert(argv.includes("--allow-env=TP_DOCKER_GATE_*"));
    assertEquals(argv.at(-1), "/opt/turbopanel/lib/docker-gate/main.ts");
    for (const arg of argv) {
      assert(
        !/^(-A|--allow-all|--allow-run|--allow-ffi|--allow-sys)/.test(arg),
        arg,
      );
      assert(!/^--allow-(write|net|env)$/.test(arg), `${arg} must be scoped`);
    }
  },
);

jinjaTest(
  "every TP_DOCKER_GATE_* the unit sets is one the gate reads",
  async () => {
    const unit = await renderUnit();
    const set = directives(unit, "Service")
      .filter((d) => d.startsWith("Environment=TP_DOCKER_GATE_"))
      .map((d) => d.slice("Environment=".length).split("=")[0]);
    for (const name of set) {
      assert((GATE_ENV_KEYS as readonly string[]).includes(name), name);
    }
    assert(set.includes("TP_DOCKER_GATE_MODE"));
    for (
      const d of directives(unit, "Service").filter((x) =>
        x.includes("TP_DOCKER_GATE_MODE")
      )
    ) {
      assertFalse(
        d.endsWith("="),
        "an empty mode would stop the gate from starting",
      );
    }
  },
);

jinjaTest(
  "a host with no daemon group renders without a gid, and the lists join with colons",
  async () => {
    const unit = await renderUnit({
      docker_gate_gid: "",
      docker_gate_bind_roots: ["/srv/users", "/data/volumes"],
      docker_gate_deny_prefixes_extra: ["/opt/turbopanel", "/mnt/secrets"],
    });
    assertFalse(unit.includes("TP_DOCKER_GATE_SOCKET_GID"));
    assertStringIncludes(
      unit,
      "TP_DOCKER_GATE_BIND_ROOTS=/srv/users:/data/volumes\n",
    );
    assertStringIncludes(
      unit,
      "TP_DOCKER_GATE_DENY_PREFIXES=/opt/turbopanel:/mnt/secrets\n",
    );
  },
);

jinjaTest(
  "the unit sandboxes the gate and does not depend on Docker being up",
  async () => {
    const unit = await renderUnit();
    const service = directives(unit, "Service");
    for (
      const wanted of [
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "ProtectHome=read-only",
        "PrivateTmp=yes",
        "PrivateDevices=yes",
        "RestrictAddressFamilies=AF_UNIX",
        "CapabilityBoundingSet=CAP_CHOWN CAP_DAC_READ_SEARCH",
        "ReadWritePaths=-/run/turbopanel-gate",
        "CacheDirectory=turbopanel-docker-gate",
      ]
    ) {
      assert(service.includes(wanted), wanted);
    }
    assertEquals(
      directives(unit, "Unit").filter((d) =>
        /^(Requires|BindsTo|PartOf)=/.test(d)
      ),
      [],
      "a Docker restart or stop must not take the gate down with it",
    );
    assert(
      directives(unit, "Unit").includes("After=docker.service docker.socket"),
    );
    assert(
      service.includes(
        "Environment=DENO_DIR=/var/cache/turbopanel-docker-gate",
      ),
    );
  },
);

jinjaTest(
  "the real gate starts and relays under exactly the unit's flags",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-gate-unit-" });
    const engineSocket = join(dir, "engine.sock");
    const runDir = join(dir, "run");
    await Deno.mkdir(runDir);
    const socket = join(runDir, "docker.sock");
    await Deno.mkdir(join(runDir, "ro"));
    const roSocket = join(runDir, "ro", "docker.sock");
    await Deno.mkdir(join(runDir, "build"));
    const buildSocket = join(runDir, "build", "docker.sock");
    const unit = await renderUnit({
      docker_gate_ro_run_dir: join(runDir, "ro"),
      docker_gate_ro_socket: roSocket,
      docker_gate_build_run_dir: join(runDir, "build"),
      docker_gate_build_socket: buildSocket,
      docker_gate_build_uid: String(Deno.uid()),
      docker_gate_gid: "",
      docker_gate_dir: join(ROLE, "files"),
      docker_gate_deno_bin: Deno.execPath(),
      docker_gate_run_dir: runDir,
      docker_gate_socket: socket,
      docker_gate_upstream_socket: engineSocket,
      docker_gate_cache_dir: join(dir, "cache"),
      docker_gate_summary_seconds: 3600,
    });
    const service = directives(unit, "Service");
    const argv = service.find((d) => d.startsWith("ExecStart="))!.slice(10)
      .split(" ");
    const env: Record<string, string> = {};
    for (const line of service.filter((d) => d.startsWith("Environment="))) {
      const [key, ...rest] = line.slice("Environment=".length).split("=");
      env[key] = rest.join("=");
    }
    const engine = Deno.listen({ transport: "unix", path: engineSocket });
    const serving = (async () => {
      for await (const conn of engine) {
        const buf = new Uint8Array(4096);
        await conn.read(buf);
        await conn.write(
          new TextEncoder().encode(
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npong",
          ),
        );
        conn.close();
      }
    })();
    const child = new Deno.Command(argv[0], {
      args: argv.slice(1),
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    try {
      let client: Deno.UnixConn | undefined;
      for (let attempt = 0; attempt < 100 && !client; attempt++) {
        try {
          client = await Deno.connect({ transport: "unix", path: socket });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert(client, "the gate never started listening");
      await client.write(
        new TextEncoder().encode(
          "GET /_ping HTTP/1.1\r\nHost: d\r\nConnection: close\r\n\r\n",
        ),
      );
      const chunks: Uint8Array[] = [];
      const buf = new Uint8Array(4096);
      while (true) {
        const n = await client.read(buf);
        if (n === null) break;
        chunks.push(buf.slice(0, n));
      }
      const got = new TextDecoder().decode(
        new Uint8Array(chunks.flatMap((c) => [...c])),
      );
      assert(got.endsWith("\r\n\r\npong"), got);
      assertEquals((await Deno.stat(socket)).mode! & 0o777, 0o660);
      const ro = await Deno.connect({ transport: "unix", path: roSocket });
      await ro.write(
        new TextEncoder().encode(
          "POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: 0\r\n\r\n",
        ),
      );
      const refused = new Uint8Array(4096);
      const n = await ro.read(refused);
      ro.close();
      assertStringIncludes(
        new TextDecoder().decode(refused.slice(0, n ?? 0)),
        "403 Forbidden",
      );
      const build = await Deno.stat(buildSocket);
      assertEquals(build.mode! & 0o777, 0o600);
      assertEquals(build.uid, Deno.uid());
    } finally {
      child.kill("SIGTERM");
      const out = await child.output();
      const log = new TextDecoder().decode(out.stdout);
      assertStringIncludes(log, "docker-gate.started");
      assertStringIncludes(log, "docker-gate.summary");
      assertFalse(new TextDecoder().decode(out.stderr).includes("NotCapable"));
      engine.close();
      await serving;
      await Deno.remove(dir, { recursive: true });
    }
  },
);

test("the role copies exactly the gate files that exist, with root ownership", async () => {
  const defaults = await read("defaults/main.yml");
  const listed = [...defaults.matchAll(/^ {2}- ([\w.]+\.ts)$/gm)].map((m) =>
    m[1]
  );
  const onDisk: string[] = [];
  for await (const entry of Deno.readDir(join(ROLE, "files"))) {
    onDisk.push(entry.name);
  }
  assertEquals(listed.toSorted(), onDisk.toSorted());
  const install = await read("tasks/install.yml");
  assertStringIncludes(install, 'loop: "{{ docker_gate_files }}"');
  const copyTask = install.slice(
    install.indexOf("Install the gate source"),
    install.indexOf("# The socket directory"),
  );
  assertStringIncludes(copyTask, "owner: root");
  assertStringIncludes(copyTask, 'mode: "0640"');
  assertFalse(copyTask.includes("owner: tp"));
});

test("the gate is never fatal in stage 1, never installed for dev, and is wired into Docker and converge", async () => {
  const main = await read("tasks/main.yml");
  assertStringIncludes(main, "rescue:");
  assertStringIncludes(
    main,
    "(turbopanel_dev_user | default('')) | length == 0",
  );
  assertStringIncludes(main, "_docker_gate_docker_bin.stat.exists");
  const docker = await Deno.readTextFile(
    join(ORCHESTRATION, "roles/docker/tasks/main.yml"),
  );
  assertStringIncludes(docker, "name: docker-gate");
  const converge = await Deno.readTextFile(
    join(ORCHESTRATION, "playbooks/daemon-converge.yml"),
  );
  assertStringIncludes(converge, "role: docker-gate");
});

test("nothing routes through the gate yet: no DOCKER_HOST or socket override is set anywhere", async () => {
  const roleFiles: string[] = [];
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) await walk(path);
      else if (!entry.name.endsWith(".md")) roleFiles.push(path);
    }
  }
  await walk(ROLE);
  for (const path of roleFiles) {
    const body = await Deno.readTextFile(path);
    assertFalse(
      /DOCKER_HOST/.test(body),
      `${path} must not export DOCKER_HOST`,
    );
    assertFalse(/TURBOPANEL_DOCKER_SOCKET/.test(body), path);
  }
  for (const unit of ["turbopaneld.service.j2"]) {
    const body = await Deno.readTextFile(
      join(ORCHESTRATION, "roles/daemon-launch/templates", unit),
    );
    assertFalse(/DOCKER_HOST|TURBOPANEL_DOCKER_SOCKET/.test(body), unit);
  }
});

// Review fix F3: the gate knows the switch, a switch change restarts it, and
// a converge with the switch on fails unless the read-only socket answers.

jinjaTest(
  "F3: the unit tells the gate where Traefik's switch file is",
  async () => {
    const service = directives(await renderUnit(), "Service");
    assert(
      service.includes(
        "Environment=TP_DOCKER_GATE_INGRESS_SWITCH=/opt/turbopanel/lib/docker-gate/ingress-socket.on",
      ),
    );
  },
);

test("F3: flipping the switch restarts the gate, and a converge with it on proves the read-only socket answers", async () => {
  const install = await read("tasks/install.yml");
  const task = (name: string) => {
    const start = install.indexOf(`- name: ${name}`);
    assert(start >= 0, name);
    const next = install.indexOf("\n- name:", start + 1);
    return install.slice(start, next < 0 ? undefined : next);
  };
  for (
    const name of [
      "Turn on Traefik's read-only gate socket",
      "Turn off Traefik's read-only gate socket",
    ]
  ) {
    assertStringIncludes(task(name), "notify: Restart Docker gate");
  }
  // The value check runs outside the rescued block: a typo fails loudly.
  const main = await read("tasks/main.yml");
  const guardAt = main.indexOf(
    "- name: Refuse a switch value that is not a clear yes or no",
  );
  assert(guardAt >= 0 && guardAt < main.indexOf("block:"), "guard first");
  assertStringIncludes(main.slice(guardAt), "docker_gate_ingress_socket");
  // A failure while the switch is on is not rescued into a warning.
  const rescue = main.slice(main.indexOf("rescue:"));
  assertStringIncludes(rescue, "{{ docker_gate_ingress_switch_file }}");
  assertStringIncludes(rescue, "ansible.builtin.fail");
  const probe = task(
    "Prove the read-only socket answers while Traefik's switch is on",
  );
  assertStringIncludes(probe, 'unix_socket: "{{ docker_gate_ro_socket }}"');
  assertStringIncludes(probe, "/_ping");
  assertStringIncludes(probe, "retries:");
  assert(
    install.indexOf("Prove the read-only socket answers") >
      install.indexOf("Enable and start the Docker gate"),
    "probed after the gate is started",
  );
});

test("atomic deploy: staged load check, snapshot, probes, and a rollback that ends in a failure", async () => {
  const deploy = await read("tasks/deploy.yml");
  const at = (needle: string) => {
    const i = deploy.indexOf(needle);
    assert(i >= 0, needle);
    return i;
  };
  // Order: stage, load-check, probe before, snapshot, then the swap.
  const order = [
    "Stage the new gate source",
    "Load-check the staged gate",
    "Look for a running gate before the swap",
    "Snapshot them",
    "Swap in the staged gate",
  ].map(at);
  assertEquals(order, order.toSorted((a, b) => a - b));
  assertStringIncludes(deploy, 'TP_DOCKER_GATE_LOAD_CHECK: "1"');
  // Nothing in the pre-flight is conditioned on the Traefik switch.
  assertFalse(
    deploy.slice(0, at("Swap in the staged gate")).includes(
      "docker_gate_ingress",
    ),
  );
  const rescue = deploy.slice(at("rescue:"));
  assertStringIncludes(rescue, "rollback.yml");
  assertStringIncludes(rescue, "ansible.builtin.fail");
  const rollback = await read("tasks/rollback.yml");
  assertStringIncludes(rollback, "Prove the restored gate answers");
  assertStringIncludes(rollback, "state: absent");
  // The swap itself moves only checked files, and a failure under the switch
  // (or a converge turning it on) still fails the converge.
  const install = await read("tasks/install.yml");
  assertStringIncludes(install, "remote_src: true");
  assertStringIncludes(install, "Prove the main gate socket answers");
  assertStringIncludes(
    await read("tasks/main.yml"),
    "(docker_gate_ingress_socket | string | length) > 0",
  );
  const defaults = await read("defaults/main.yml");
  for (const key of ["docker_gate_stage_dir", "docker_gate_prev_dir"]) {
    assertStringIncludes(defaults, `${key}: "{{ docker_gate_dir }}/.`);
  }
});

test("the gate's load check exits 0 on good source and fails on bad configuration", async () => {
  const main = join(ROLE, "files/main.ts");
  const run = async (env: Record<string, string>) => {
    const { code } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        "--no-remote",
        "--no-config",
        "--no-lock",
        "--allow-read",
        "--allow-env=TP_DOCKER_GATE_*",
        main,
      ],
      env: { NO_COLOR: "1", ...env },
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output();
    return code;
  };
  assertEquals(await run({ TP_DOCKER_GATE_LOAD_CHECK: "1" }), 0);
  assert(
    await run({
      TP_DOCKER_GATE_LOAD_CHECK: "1",
      TP_DOCKER_GATE_MODE: "refuse-all",
    }) !== 0,
  );
});
