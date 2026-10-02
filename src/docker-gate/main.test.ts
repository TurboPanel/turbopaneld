import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_GATE_SOCKET,
  DEFAULT_SUMMARY_SECONDS,
  DEFAULT_UPSTREAM_SOCKET,
  GATE_ENV_KEYS,
  jsonLogger,
  loadConfig,
  startGate,
} from "../../orchestration/roles/docker-gate/files/main.ts";
import { DEFAULT_POLICY_CONFIG } from "../../orchestration/roles/docker-gate/files/policy.ts";
import {
  MAX_SYMLINK_HOPS,
  type PathProbe,
  resolveBindPath,
} from "../../orchestration/roles/docker-gate/files/resolve.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("loadConfig defaults to observe mode on the documented sockets", () => {
  const config = loadConfig({});
  assertEquals(config.socket, DEFAULT_GATE_SOCKET);
  assertEquals(config.upstream, DEFAULT_UPSTREAM_SOCKET);
  assertEquals(config.summarySeconds, DEFAULT_SUMMARY_SECONDS);
  assertEquals(config.socketGid, undefined);
  assertEquals(config.policy, { ...DEFAULT_POLICY_CONFIG, capAllowlist: [] });
});

test("loadConfig reads the platform trees and the approval key path", () => {
  const config = loadConfig({
    TP_DOCKER_GATE_PLATFORM_RO_ROOTS: "/etc/x/a:/etc/x/b/",
    TP_DOCKER_GATE_PLATFORM_RW_ROOTS: "/var/x",
    TP_DOCKER_GATE_APPROVAL_PUBKEY:
      "/opt/turbopanel/lib/docker-gate/approval.pub",
  });
  assertEquals(config.policy.platform, {
    readOnly: ["/etc/x/a", "/etc/x/b"],
    writable: ["/var/x"],
  });
  assertEquals(
    config.approvalKeyFile,
    "/opt/turbopanel/lib/docker-gate/approval.pub",
  );
  assertEquals(loadConfig({}).approvalKeyFile, undefined);
});

test("loadConfig takes every setting from the environment", () => {
  const config = loadConfig({
    TP_DOCKER_GATE_MODE: "observe",
    TP_DOCKER_GATE_SOCKET: "/run/x/docker.sock",
    TP_DOCKER_GATE_UPSTREAM: "/run/docker.sock",
    TP_DOCKER_GATE_SOCKET_GID: "9999",
    TP_DOCKER_GATE_BIND_ROOTS: "/srv/users/:/data/volumes::relative:/mnt/x",
    TP_DOCKER_GATE_DENY_PREFIXES: "/opt/turbopanel:/etc/turbopanel/",
    TP_DOCKER_GATE_CAP_ALLOW: "cap_net_bind_service, SYS_PTRACE,",
    TP_DOCKER_GATE_SUMMARY_SEC: "60",
  });
  assertEquals(config.socket, "/run/x/docker.sock");
  assertEquals(config.upstream, "/run/docker.sock");
  assertEquals(config.socketGid, 9999);
  assertEquals(config.summarySeconds, 60);
  assertEquals(config.policy.bindRoots, [
    "/srv/users",
    "/data/volumes",
    "/mnt/x",
  ]);
  assertEquals(config.policy.denyPrefixes.slice(-2), [
    "/opt/turbopanel",
    "/etc/turbopanel",
  ]);
  assertEquals(config.policy.capAllowlist, ["NET_BIND_SERVICE", "SYS_PTRACE"]);
});

test("loadConfig falls back on unusable numbers", () => {
  const config = loadConfig({
    TP_DOCKER_GATE_SOCKET_GID: "abc",
    TP_DOCKER_GATE_SUMMARY_SEC: "-5",
  });
  assertEquals(config.socketGid, undefined);
  assertEquals(config.summarySeconds, DEFAULT_SUMMARY_SECONDS);
});

test("loadConfig refuses every mode but observe: this build cannot enforce", () => {
  for (const mode of ["enforce", "off", "", "OBSERVE"]) {
    assertThrows(
      () => loadConfig({ TP_DOCKER_GATE_MODE: mode }),
      Error,
      "only observes",
    );
  }
});

test("GATE_ENV_KEYS lists every TP_DOCKER_GATE_ variable loadConfig reads", async () => {
  const source = await Deno.readTextFile(
    new URL(
      "../../orchestration/roles/docker-gate/files/main.ts",
      import.meta.url,
    ),
  );
  const used = new Set(source.match(/TP_DOCKER_GATE_[A-Z_]+/g));
  assertEquals(new Set(GATE_ENV_KEYS), used);
});

test("jsonLogger writes one JSON line per record with a timestamp", () => {
  const lines: string[] = [];
  jsonLogger((line) => lines.push(line))({ level: "info", event: "x", n: 1 });
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.event, "x");
  assertEquals(parsed.n, 1);
  assert(!Number.isNaN(Date.parse(parsed.time)));
});

/** An in-memory filesystem: path -> `true` (exists) or a link target. */
function fakeProbe(entries: Record<string, true | string>): PathProbe {
  return {
    kind: (path) => {
      const entry = entries[path];
      if (entry === undefined) return Promise.resolve(undefined);
      return Promise.resolve(entry === true ? "other" : "link");
    },
    readLink: (path) => Promise.resolve(entries[path] as string),
  };
}

test("resolveBindPath: plain existing, missing and dotted paths", async () => {
  const probe = fakeProbe({
    "/srv": true,
    "/srv/users": true,
    "/srv/users/a": true,
  });
  assertEquals(await resolveBindPath("/srv/users/a", probe), "/srv/users/a");
  assertEquals(
    await resolveBindPath("/srv/users/a/new/dir", probe),
    "/srv/users/a/new/dir",
  );
  assertEquals(
    await resolveBindPath("/srv/users/./a/../a", probe),
    "/srv/users/a",
  );
  assertEquals(await resolveBindPath("/", probe), "/");
});

test("resolveBindPath: absolute and relative links, including ones inside the path", async () => {
  const probe = fakeProbe({
    "/srv": true,
    "/srv/users": true,
    "/srv/users/a": true,
    "/srv/users/a/abs": "/etc",
    "/etc": true,
    "/srv/users/a/rel": "../b/inner",
    "/srv/users/b": true,
    "/srv/users/b/inner": true,
    "/srv/users/a/up": "../../..",
  });
  assertEquals(await resolveBindPath("/srv/users/a/abs", probe), "/etc");
  assertEquals(
    await resolveBindPath("/srv/users/a/abs/turbopanel", probe),
    "/etc/turbopanel",
  );
  assertEquals(
    await resolveBindPath("/srv/users/a/rel", probe),
    "/srv/users/b/inner",
  );
  assertEquals(await resolveBindPath("/srv/users/a/up", probe), "/");
});

test("resolveBindPath: a dangling link is followed to where Docker would create the target", async () => {
  const probe = fakeProbe({
    "/srv": true,
    "/srv/users": true,
    "/srv/users/a": true,
    "/srv/users/a/dangling": "/etc/turbopanel/new",
    "/etc": true,
  });
  assertEquals(
    await resolveBindPath("/srv/users/a/dangling", probe),
    "/etc/turbopanel/new",
  );
});

test("resolveBindPath: a link loop is an error, not a hang", async () => {
  const probe = fakeProbe({ "/a": "/b", "/b": "/a" });
  await assertRejects(
    () => resolveBindPath("/a", probe),
    Error,
    "too many symbolic links",
  );
  assert(MAX_SYMLINK_HOPS > 0);
});

test("resolveBindPath on a real tree: symlinks, dangling links and missing tails", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-resolve-" }),
  );
  try {
    await Deno.mkdir(join(root, "users/a"), { recursive: true });
    await Deno.mkdir(join(root, "outside"));
    await Deno.symlink(join(root, "outside"), join(root, "users/a/escape"));
    await Deno.symlink(
      join(root, "missing/target"),
      join(root, "users/a/dangling"),
    );
    assertEquals(
      await resolveBindPath(join(root, "users/a/escape"), undefined),
      join(root, "outside"),
    );
    assertEquals(
      await resolveBindPath(
        join(root, "users/a/escape/deeper/still"),
        undefined,
      ),
      join(root, "outside/deeper/still"),
    );
    assertEquals(
      await resolveBindPath(join(root, "users/a/dangling"), undefined),
      join(root, "missing/target"),
    );
    assertEquals(
      await resolveBindPath(join(root, "users/a/not-yet"), undefined),
      join(root, "users/a/not-yet"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test({
  name:
    "startGate replaces a stale socket, refuses a directory, and stops cleanly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-gate-main-" });
    try {
      const socket = join(dir, "gate.sock");
      const config = loadConfig({
        TP_DOCKER_GATE_SOCKET: socket,
        TP_DOCKER_GATE_UPSTREAM: join(dir, "none.sock"),
        TP_DOCKER_GATE_SUMMARY_SEC: "3600",
      });
      await Deno.writeTextFile(socket, "stale");
      const logs: Array<Record<string, unknown>> = [];
      const gate = await startGate(config, (record) => logs.push(record));
      assertEquals(logs[0].event, "docker-gate.started");
      assertEquals(logs[0].mode, "observe");
      assertEquals((await Deno.stat(socket)).mode! & 0o777, 0o660);
      await gate.stop();
      assertEquals(logs.at(-1)?.event, "docker-gate.summary");
      assertEquals(logs.at(-1)?.final, true);
      await assertRejects(() => Deno.lstat(socket), Deno.errors.NotFound);

      await Deno.mkdir(socket);
      await assertRejects(
        () => startGate(config, () => {}),
        Error,
        "is a directory",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// Review fix F3: with Traefik's switch on, a read-only listener that cannot
// open must fail the gate's start (Restart=always retries), not just log.

async function roUnavailableStart(switchOn: boolean) {
  const dir = await Deno.makeTempDir({ prefix: "tp-gate-ro-" });
  const socket = join(dir, "gate.sock");
  const switchFile = join(dir, "ingress-socket.on");
  if (switchOn) await Deno.writeTextFile(switchFile, "on\n");
  const config = loadConfig({
    TP_DOCKER_GATE_SOCKET: socket,
    // Its directory does not exist, so listen() fails.
    TP_DOCKER_GATE_RO_SOCKET: join(dir, "missing", "docker.sock"),
    TP_DOCKER_GATE_INGRESS_SWITCH: switchFile,
    TP_DOCKER_GATE_UPSTREAM: join(dir, "none.sock"),
    TP_DOCKER_GATE_SUMMARY_SEC: "3600",
  });
  const logs: Array<Record<string, unknown>> = [];
  return {
    dir,
    socket,
    config,
    logs,
    log: (r: Record<string, unknown>) => logs.push(r),
  };
}

test("loadConfig reads the Traefik switch file path", () => {
  assertEquals(loadConfig({}).ingressSwitchFile, undefined);
  assertEquals(
    loadConfig({ TP_DOCKER_GATE_INGRESS_SWITCH: "/opt/x/ingress-socket.on" })
      .ingressSwitchFile,
    "/opt/x/ingress-socket.on",
  );
});

test({
  name:
    "F3: switch on + read-only listener unavailable = the gate refuses to start and leaves no socket",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const run = await roUnavailableStart(true);
    try {
      await assertRejects(
        () => startGate(run.config, run.log),
        Error,
        "read-only socket",
      );
      const loud = run.logs.find((r) =>
        r.event === "docker-gate.ro-socket-unavailable"
      );
      assertEquals(loud?.level, "error");
      assertEquals(loud?.fatal, true);
      await assertRejects(() => Deno.lstat(run.socket), Deno.errors.NotFound);
    } finally {
      await Deno.remove(run.dir, { recursive: true });
    }
  },
});

test({
  name:
    "F3: switch off + read-only listener unavailable = logged loudly, the main socket keeps serving",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const run = await roUnavailableStart(false);
    try {
      const gate = await startGate(run.config, run.log);
      const loud = run.logs.find((r) =>
        r.event === "docker-gate.ro-socket-unavailable"
      );
      assertEquals(loud?.level, "error");
      assertEquals(loud?.fatal, false);
      const started = run.logs.find((r) => r.event === "docker-gate.started");
      assertEquals(started?.roSocket, null);
      assert((await Deno.lstat(run.socket)).isSocket);
      await gate.stop();
    } finally {
      await Deno.remove(run.dir, { recursive: true });
    }
  },
});
