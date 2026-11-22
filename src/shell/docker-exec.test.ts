import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  isPlatformContainer,
  PLATFORM_COMPONENTS,
  PLATFORM_ROLES,
} from "../../orchestration/roles/docker-gate/files/platform.ts";
import { LABEL_ROLE, LABEL_SYSTEM_COMPONENT } from "../deploy/labels.ts";
import {
  CONTAINER_ID,
  engine,
  EXEC_ID,
  TENANT,
  withFakeDocker,
} from "../testing/fake-docker-exec.ts";
import {
  DockerExecError,
  execTimeouts,
  hasTenantLabels,
  isPlatformLabelled,
  isValidContainerRef,
  isValidExecUser,
  openDockerExec,
  SHELL_EXEC_CMD,
  SHELL_EXEC_ENV,
  SHELL_TOKEN_VAR,
  shellKillScript,
} from "./docker-exec.ts";

const test = Deno.test.bind(Deno);
const enc = new TextEncoder();
const dec = new TextDecoder();

const OPEN = { containerId: "c1", user: "", cols: 100, rows: 30 };

test("the exec body is fixed: tty, fixed Cmd, TERM, never Privileged, user only when given", async () => {
  await withFakeDocker(engine(TENANT), async (socketPath, seen) => {
    const t = await openDockerExec({ ...OPEN, user: "app", socketPath });
    t.close();
    const create = seen.find((s) =>
      s.path === `/containers/${CONTAINER_ID}/exec`
    )!;
    const body = JSON.parse(create.body);
    const token = body.Env.find((e: string) => e.startsWith("TP_SHELL_TOKEN="));
    assert(token, "the exec carries its own token");
    assertEquals(body, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: "app",
      Env: [...SHELL_EXEC_ENV, token],
      Cmd: [...SHELL_EXEC_CMD],
    });
    assert(!("Privileged" in body));
  });
  await withFakeDocker(engine(TENANT), async (socketPath, seen) => {
    (await openDockerExec({ ...OPEN, socketPath })).close();
    const body = JSON.parse(seen.find((s) => s.path.endsWith("/exec"))!.body);
    assert(!("User" in body));
  });
});

test("the start is an HTTP/1.1 upgrade, answered 101, then a raw stream", async () => {
  await withFakeDocker(engine(TENANT), async (socketPath, seen) => {
    const t = await openDockerExec({ ...OPEN, socketPath });
    const start = seen.find((s) => s.path === `/exec/${EXEC_ID}/start`)!;
    assertEquals(start.method, "POST");
    assertEquals(start.headers.get("connection"), "Upgrade");
    assertEquals(start.headers.get("upgrade"), "tcp");
    assertEquals(JSON.parse(start.body), { Detach: false, Tty: true });
    // Bytes that arrived with the 101 are delivered first.
    assertEquals(dec.decode((await t.read())!), "ready$ ");
    await t.write(enc.encode("ls\n"));
    assertEquals(dec.decode((await t.read())!), "ls\n");
    t.close();
    assertEquals(await t.read(), null);
  });
});

test("the first resize uses the requested size; later resizes and the exit code go to the exec", async () => {
  await withFakeDocker(engine(TENANT), async (socketPath, seen) => {
    const t = await openDockerExec({ ...OPEN, socketPath });
    assert(seen.some((s) => s.path === `/exec/${EXEC_ID}/resize?h=30&w=100`));
    await t.resize(120, 40);
    assert(seen.some((s) => s.path === `/exec/${EXEC_ID}/resize?h=40&w=120`));
    assertEquals(await t.exitCode(), 7);
    t.close();
  });
});

test("a platform container, an unlabeled one and a stopped one are refused before any exec", async () => {
  const cases: [Record<string, string>, boolean, string][] = [
    [{ ...TENANT, [LABEL_ROLE]: "ingress" }, true, "container_not_owned"],
    [
      { ...TENANT, [LABEL_SYSTEM_COMPONENT]: "database" },
      true,
      "container_not_owned",
    ],
    [{ ...TENANT, "tp.managed.engine": "mysql" }, true, "container_not_owned"],
    [{}, true, "container_not_owned"],
    [{ "com.example.other": "x" }, true, "container_not_owned"],
    [TENANT, false, "container_not_found"],
  ];
  for (const [labels, running, code] of cases) {
    await withFakeDocker(
      engine(labels, {}, running),
      async (socketPath, seen) => {
        const err = await assertRejects(
          () => openDockerExec({ ...OPEN, socketPath }),
          DockerExecError,
        );
        assertEquals((err as DockerExecError).code, code);
        assert(!seen.some((s) => s.method === "POST"), "no exec was created");
      },
    );
  }
});

test("docker answers map to the error codes", async () => {
  let code = "";
  await withFakeDocker(
    engine(TENANT, { inspect: { status: 404, raw: "{}" } }),
    async (socketPath) => {
      const err = await assertRejects(
        () => openDockerExec({ ...OPEN, socketPath }),
        DockerExecError,
      );
      code = (err as DockerExecError).code;
    },
  );
  assertEquals(code, "container_not_found");
  await withFakeDocker(
    engine(TENANT, { create: { status: 403, raw: "{}" } }),
    async (socketPath) => {
      const err = await assertRejects(
        () => openDockerExec({ ...OPEN, socketPath }),
        DockerExecError,
      );
      assertEquals((err as DockerExecError).code, "gate_denied");
    },
  );
  await withFakeDocker(
    engine(TENANT, {
      start: { status: 400, raw: '{"message":"executable file not found"}' },
    }),
    async (socketPath) => {
      const err = await assertRejects(
        () => openDockerExec({ ...OPEN, socketPath }),
        DockerExecError,
      );
      assertEquals((err as DockerExecError).code, "no_shell");
    },
  );
  await withFakeDocker(
    engine(TENANT, { create: { status: 500, raw: "boom" } }),
    async (socketPath) => {
      const err = await assertRejects(
        () => openDockerExec({ ...OPEN, socketPath }),
        DockerExecError,
      );
      assertEquals((err as DockerExecError).code, "helper_unavailable");
    },
  );
});

test("a bad user or container reference never reaches the socket", async () => {
  const socketPath = "/nonexistent/docker.sock";
  for (const user of ["root; id", "-x", "a b", "0:0:0", "A".repeat(40)]) {
    await assertRejects(
      () => openDockerExec({ ...OPEN, user, socketPath }),
      DockerExecError,
    );
  }
  for (const containerId of ["", "../x", "a/b", "-rm"]) {
    await assertRejects(
      () => openDockerExec({ ...OPEN, containerId, socketPath }),
      DockerExecError,
    );
  }
  for (const user of ["", "app", "_x-1", "1000", "1000:1000"]) {
    assert(isValidExecUser(user), user);
  }
  assert(isValidContainerRef("abc_1.2-3"));
});

test("the platform refusal is at least as strict as the gate's classification", () => {
  const labelSets: Record<string, string>[] = [{ "tp.managed.engine": "x" }];
  for (const role of PLATFORM_ROLES) {
    for (const component of PLATFORM_COMPONENTS) {
      labelSets.push({
        [LABEL_ROLE]: role,
        [LABEL_SYSTEM_COMPONENT]: component,
      });
    }
  }
  for (const labels of labelSets) {
    assert(isPlatformContainer(labels));
    assert(isPlatformLabelled(labels), JSON.stringify(labels));
  }
  assert(!isPlatformLabelled(TENANT));
  assert(hasTenantLabels(TENANT));
  assert(!hasTenantLabels({ [LABEL_ROLE]: "web" }));
});

test("the exec is created on the inspected Id, not the requested name", async () => {
  await withFakeDocker(engine(TENANT), async (socketPath, seen) => {
    (await openDockerExec({ ...OPEN, socketPath })).close();
    const creates = seen.filter((s) => s.path.endsWith("/exec"));
    assert(creates.length > 0);
    for (const c of creates) {
      assertEquals(c.path, `/containers/${CONTAINER_ID}/exec`);
    }
    assert(!seen.some((s) => s.path === "/containers/c1/exec"));
  });
  // An inspect answer without an Id is not usable.
  await withFakeDocker(
    engine(TENANT, {
      inspect: {
        status: 200,
        body: { State: { Running: true }, Config: { Labels: TENANT } },
      },
    }),
    async (socketPath) => {
      const err = await assertRejects(
        () => openDockerExec({ ...OPEN, socketPath }),
        DockerExecError,
      );
      assertEquals((err as DockerExecError).code, "helper_unavailable");
    },
  );
});

function killScripts(seen: { method: string; path: string; body: string }[]) {
  return seen
    .filter((s) =>
      s.method === "POST" && s.path === `/containers/${CONTAINER_ID}/exec` &&
      s.body.includes('"Detach"') === false &&
      JSON.parse(s.body).AttachStdout === false
    )
    .map((s) => JSON.parse(s.body).Cmd[2] as string);
}

test("close ends the shell: a detached HUP exec keyed on the session token", async () => {
  await withFakeDocker(engine(TENANT), async (socketPath, seen) => {
    const t = await openDockerExec({ ...OPEN, user: "app", socketPath });
    const token = JSON.parse(
      seen.find((s) => s.path.endsWith("/exec"))!.body,
    ).Env.find((e: string) => e.startsWith("TP_SHELL_TOKEN="));
    t.close();
    await (t as unknown as { terminated: Promise<void> }).terminated;
    const scripts = killScripts(seen);
    assertEquals(scripts.length, 1, "the exec ended on HUP, no KILL needed");
    assert(scripts[0].includes("kill -HUP"));
    assert(scripts[0].includes(token));
    const kill = seen.filter((s) => s.path.endsWith("/exec")).at(-1)!;
    assertEquals(JSON.parse(kill.body).User, "app");
    assert(
      seen.some((s) =>
        s.path === `/exec/${EXEC_ID}/start` && s.body.includes('"Detach":true')
      ),
    );
  });
});

test("an exec that outlives the HUP gets a KILL", async () => {
  let polls = 0;
  const base = engine(TENANT);
  await withFakeDocker((req) => {
    if (req.method === "GET" && req.path === `/exec/${EXEC_ID}/json`) {
      polls += 1;
      return { status: 200, body: { Running: true } };
    }
    return base(req);
  }, async (socketPath, seen) => {
    const t = await openDockerExec({ ...OPEN, socketPath });
    t.close();
    await (t as unknown as { terminated: Promise<void> }).terminated;
    const scripts = killScripts(seen);
    assertEquals(scripts.length, 2);
    assert(scripts[0].includes("kill -HUP"));
    assert(scripts[1].includes("kill -KILL"));
    assert(polls > 0);
  });
});

test("a shell that exited on its own is not killed on close", async () => {
  await withFakeDocker(engine(TENANT), async (socketPath, seen, streams) => {
    const t = await openDockerExec({ ...OPEN, socketPath });
    await t.read();
    streams[0].close();
    assertEquals(await t.read(), null);
    t.close();
    await (t as unknown as { terminated: Promise<void> }).terminated;
    assertEquals(killScripts(seen).length, 0);
  });
});

test("a silent engine times out as helper_unavailable and leaves no connection open", async () => {
  const was = execTimeouts.call;
  execTimeouts.call = 80;
  try {
    for (const stall of ["/containers/", "/exec"] as const) {
      const base = engine(TENANT);
      await withFakeDocker((req) => {
        if (stall === "/containers/" && req.path.startsWith("/containers/")) {
          return { status: 0 };
        }
        if (stall === "/exec" && req.path.endsWith("/exec")) {
          return { status: 0 };
        }
        return base(req);
      }, async (socketPath) => {
        const err = await assertRejects(
          () => openDockerExec({ ...OPEN, socketPath }),
          DockerExecError,
        );
        assertEquals((err as DockerExecError).code, "helper_unavailable");
      });
    }
  } finally {
    execTimeouts.call = was;
  }
});

async function pidAlive(pid: number): Promise<boolean> {
  try {
    // A zombie is dead; it only waits to be reaped.
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

async function waitGone(pids: number[]): Promise<number[]> {
  for (let i = 0; i < 50; i++) {
    const alive: number[] = [];
    for (const pid of pids) if (await pidAlive(pid)) alive.push(pid);
    if (alive.length === 0) return alive;
    await new Promise((r) => setTimeout(r, 100));
  }
  const alive: number[] = [];
  for (const pid of pids) if (await pidAlive(pid)) alive.push(pid);
  return alive;
}

// Runs the real kill script against a real shell. Known limit, not fixed: a
// process started with `env -i` drops the token from its environment, so the
// script cannot find it and it survives the kill.
test("the kill script ends a real shell and its children", async () => {
  const token = crypto.randomUUID();
  const shell = new Deno.Command("/bin/sh", {
    args: [
      "-c",
      // A child and a grandchild; print their pids, then wait on them.
      "sleep 300 & echo $!; sh -c 'sleep 301 & echo $!; wait' & wait",
    ],
    env: { [SHELL_TOKEN_VAR]: token },
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const pids: number[] = [shell.pid];
  const reader = shell.stdout.getReader();
  let text = "";
  while (pids.length < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
    pids.length = 1;
    for (const line of text.split("\n")) {
      if (/^\d+$/.test(line)) pids.push(Number(line));
    }
  }
  try {
    assertEquals(pids.length, 3, "the shell reported both children");
    for (const pid of pids) assert(await pidAlive(pid), `${pid} runs`);
    for (const signal of ["HUP", "KILL"] as const) {
      const out = await new Deno.Command("/bin/sh", {
        args: ["-c", shellKillScript(token, signal)],
        stdout: "null",
        stderr: "null",
      }).output();
      assert(out.success);
      if ((await waitGone(pids)).length === 0) break;
    }
    assertEquals(
      await waitGone(pids),
      [],
      "the shell and its children are gone",
    );
  } finally {
    for (const pid of pids) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await reader.cancel().catch(() => undefined);
    await shell.status.catch(() => undefined);
  }
});
