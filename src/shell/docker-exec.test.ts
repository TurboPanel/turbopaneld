import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  isPlatformContainer,
  PLATFORM_COMPONENTS,
  PLATFORM_ROLES,
} from "../../orchestration/roles/docker-gate/files/platform.ts";
import { LABEL_ROLE, LABEL_SYSTEM_COMPONENT } from "../deploy/labels.ts";
import {
  engine,
  EXEC_ID,
  TENANT,
  withFakeDocker,
} from "../testing/fake-docker-exec.ts";
import {
  DockerExecError,
  hasTenantLabels,
  isPlatformLabelled,
  isValidContainerRef,
  isValidExecUser,
  openDockerExec,
  SHELL_EXEC_CMD,
  SHELL_EXEC_ENV,
} from "./docker-exec.ts";

const test = Deno.test.bind(Deno);
const enc = new TextEncoder();
const dec = new TextDecoder();

const OPEN = { containerId: "c1", user: "", cols: 100, rows: 30 };

test("the exec body is fixed: tty, fixed Cmd, TERM, never Privileged, user only when given", async () => {
  await withFakeDocker(engine(TENANT), async (socketPath, seen) => {
    const t = await openDockerExec({ ...OPEN, user: "app", socketPath });
    t.close();
    const create = seen.find((s) => s.path === "/containers/c1/exec")!;
    const body = JSON.parse(create.body);
    assertEquals(body, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: "app",
      Env: [...SHELL_EXEC_ENV],
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
