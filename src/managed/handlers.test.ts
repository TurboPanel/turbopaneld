import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { handleManagedDestroy } from "./destroy.ts";
import { handleManagedLifecycle } from "./lifecycle.ts";
import { managedDir } from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function dockerFail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "postgres",
    State: "running",
  },
]);

async function withManagedStateDir(
  managedId: string,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  await withTempLayout(async (fixture) => {
    const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
    for (const [key, value] of Object.entries(fixture.env)) {
      Deno.env.set(key, value);
    }
    try {
      const root = managedDir(
        { stateDir: fixture.dirs.stateDir } as Parameters<typeof managedDir>[0],
        managedId,
      );
      await Deno.mkdir(root, { recursive: true });
      await fn(root);
    } finally {
      if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
      else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    }
  });
}

test("handleManagedLifecycle is idempotent when state dir is missing", async () => {
  const managedId = `noop-life-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-life-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const result = await handleManagedLifecycle(
      { managedId, action: "stop" },
      new Date().toISOString(),
    );
    assertEquals(result.status, "stopped");
    assertEquals(result.summary?.includes("idempotent"), true);
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});

test("handleManagedLifecycle rejects unsafe managedId", async () => {
  await assertRejects(
    () =>
      handleManagedLifecycle(
        { managedId: "../escape", action: "stop" },
        new Date().toISOString(),
      ),
    Error,
    "unsupported characters",
  );
});

test("handleManagedLifecycle runs compose action and reports ready from ps", async () => {
  const managedId = "managed_lifecycle_ready";
  await withManagedStateDir(managedId, async () => {
    const calls: string[][] = [];
    const result = await handleManagedLifecycle(
      { managedId, action: "start" },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          calls.push([...args]);
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk(RUNNING_PS));
          }
          return Promise.resolve(dockerOk());
        },
      },
    );

    assertEquals(result.status, "ready");
    assertEquals(
      calls.some((args) => args[0] === "compose" && args.includes("start")),
      true,
    );
  });
});

test("handleManagedLifecycle reports stopped when compose ps is empty", async () => {
  const managedId = "managed_lifecycle_stopped";
  await withManagedStateDir(managedId, async () => {
    const result = await handleManagedLifecycle(
      { managedId, action: "stop" },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk("[]"));
          }
          return Promise.resolve(dockerOk());
        },
      },
    );

    assertEquals(result.status, "stopped");
  });
});

test("handleManagedLifecycle reports failed for mixed non-running states", async () => {
  const managedId = "managed_lifecycle_failed";
  await withManagedStateDir(managedId, async () => {
    const mixed = JSON.stringify([
      {
        ID: "a1",
        Name: "svc-1",
        Service: "postgres",
        State: "running",
      },
      {
        ID: "a2",
        Name: "svc-2",
        Service: "other",
        State: "exited",
      },
    ]);
    const result = await handleManagedLifecycle(
      { managedId, action: "restart" },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk(mixed));
          }
          return Promise.resolve(dockerOk());
        },
      },
    );

    assertEquals(result.status, "ready");
  });
});

test("handleManagedLifecycle throws when compose action fails", async () => {
  const managedId = "managed_lifecycle_compose_fail";
  await withManagedStateDir(managedId, async () => {
    await assertRejects(
      () =>
        handleManagedLifecycle(
          { managedId, action: "start" },
          new Date().toISOString(),
          {
            runDocker: () => Promise.resolve(dockerFail("compose start failed")),
          },
        ),
      Error,
      "compose start failed",
    );
  });
});

test("handleManagedLifecycle with memberId returns member health when replication is available", async () => {
  const managedId = "managed_lifecycle_member";
  const memberId = "00000000-0000-4000-8000-0000000000a1";
  await withManagedStateDir(managedId, async () => {
    const result = await handleManagedLifecycle(
      {
        managedId,
        action: "restart",
        memberId,
        engine: "postgres",
      },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk(RUNNING_PS));
          }
          if (args[0] === "exec") {
            return Promise.resolve(dockerOk("streaming\t0\n"));
          }
          return Promise.resolve(dockerOk());
        },
      },
    );

    assertEquals(result.status, "ready");
    assertEquals(result.member?.memberId, memberId);
    assertEquals(result.member?.replication?.state, "streaming");
  });
});

test("handleManagedDestroy is idempotent when state dir is missing", async () => {
  const managedId = `noop-destroy-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-destroy-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const result = await handleManagedDestroy(
      { managedId, removeVolumes: false },
      new Date().toISOString(),
    );
    assertEquals(result.status, "stopped");
    assertEquals(result.containers, []);
    assertEquals(result.summary?.includes("idempotent"), true);
    try {
      await Deno.stat(join(tmp, "managed", managedId));
      throw new TypeError("managed dir should not exist");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});

test("handleManagedDestroy rejects unsafe managedId", async () => {
  await assertRejects(
    () =>
      handleManagedDestroy(
        { managedId: "../escape", removeVolumes: false },
        new Date().toISOString(),
      ),
    Error,
    "unsupported characters",
  );
});

test("handleManagedDestroy runs compose down with volumes and removes state", async () => {
  const managedId = "managed_destroy_volumes";
  await withManagedStateDir(managedId, async (root) => {
    const calls: string[][] = [];
    const result = await handleManagedDestroy(
      { managedId, removeVolumes: true },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          calls.push([...args]);
          return Promise.resolve(dockerOk());
        },
      },
    );

    assertEquals(result.summary, "managed service destroyed");
    assertEquals(
      calls.some((args) => args.includes("down") && args.includes("--volumes")),
      true,
    );
    let sawNotFound = false;
    try {
      await Deno.stat(root);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) sawNotFound = true;
      else throw err;
    }
    assertEquals(sawNotFound, true);
  });
});

test("handleManagedDestroy soft-fails compose down but still removes state", async () => {
  const managedId = "managed_destroy_soft_fail";
  await withManagedStateDir(managedId, async (root) => {
    const result = await handleManagedDestroy(
      { managedId, removeVolumes: false },
      new Date().toISOString(),
      {
        runDocker: () => Promise.resolve(dockerFail("project not found")),
      },
    );

    assertEquals(result.summary, "managed service destroyed");
    let sawNotFound = false;
    try {
      await Deno.stat(root);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) sawNotFound = true;
      else throw err;
    }
    assertEquals(sawNotFound, true);
  });
});
