import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import type { LocalDeploymentManifest } from "../deploy/compose-files.ts";
import { createMutableTranscriptRedactor } from "./redactor.ts";
import { collectContainerLogs } from "./container-tail.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const OWNED_ID = "a1b2c3d4e5f6789012345678";
const FOREIGN_ID = "f1e2d3c4b5a6789012345678";
const PROJECT = "proj-compose";
const SERVICE = "web";

function ok(stdout: string): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function fail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

function ownedManifests(): LocalDeploymentManifest[] {
  return [{
    dir: "/var/lib/turbopanel/deployments/p/e",
    manifest: {
      version: 2,
      projectId: "project-1",
      environmentId: "env-1",
      serverId: "server-1",
      generation: 1,
      projectName: PROJECT,
      composeSha256: "abc",
      services: { [SERVICE]: { replicas: 1 } },
      serviceIds: { [SERVICE]: "service-uuid-1" },
    },
  }];
}

function inspectStdout(project = PROJECT, service = SERVICE): string {
  return `${project}\n${service}\n`;
}

test("collectContainerLogs rejects unsafe containerId", async () => {
  await assertRejects(
    () =>
      collectContainerLogs("../escape", { stateDir: "/var/lib/turbopanel" }, {
        runDocker: () => Promise.resolve(ok("")),
        listManifests: () => Promise.resolve([]),
      }),
    Error,
    "unsupported characters",
  );
});

test("collectContainerLogs rejects a container outside this host's deployment.json", async () => {
  await assertRejects(
    () =>
      collectContainerLogs(FOREIGN_ID, { stateDir: "/var/lib/turbopanel" }, {
        runDocker: (args) => {
          if (args[0] === "inspect") {
            return Promise.resolve(ok(inspectStdout("other-project", SERVICE)));
          }
          return Promise.resolve(ok("should-not-run\n"));
        },
        listManifests: () => Promise.resolve(ownedManifests()),
      }),
    Error,
    "not owned by this host",
  );
});

test("collectContainerLogs rejects when serviceIds does not name the compose service", async () => {
  await assertRejects(
    () =>
      collectContainerLogs(OWNED_ID, { stateDir: "/var/lib/turbopanel" }, {
        runDocker: (args) => {
          if (args[0] === "inspect") {
            return Promise.resolve(ok(inspectStdout(PROJECT, "db")));
          }
          return Promise.resolve(ok("should-not-run\n"));
        },
        listManifests: () => Promise.resolve(ownedManifests()),
      }),
    Error,
    "not owned by this host",
  );
});

test("collectContainerLogs clamps tail and redacts owned container output", async () => {
  const calls: string[][] = [];
  const redactor = createMutableTranscriptRedactor(["s3cret"]);

  const text = await collectContainerLogs(
    OWNED_ID,
    { stateDir: "/var/lib/turbopanel", tail: 9999 },
    {
      redactor,
      listManifests: () => Promise.resolve(ownedManifests()),
      runDocker: (args) => {
        calls.push([...args]);
        if (args[0] === "inspect") return Promise.resolve(ok(inspectStdout()));
        return Promise.resolve(ok("2026-01-01T00:00:00Z password=s3cret\n"));
      },
    },
  );

  assertEquals(text.includes("s3cret"), false);
  assertEquals(text.includes("***"), true);
  assertEquals(calls[1], [
    "container",
    "logs",
    "--tail",
    "2000",
    "--timestamps",
    OWNED_ID,
  ]);
});

test("collectContainerLogs throws when inspect fails", async () => {
  await assertRejects(
    () =>
      collectContainerLogs(OWNED_ID, { stateDir: "/var/lib/turbopanel" }, {
        runDocker: () => Promise.resolve(fail("no such container")),
        listManifests: () => Promise.resolve(ownedManifests()),
      }),
    Error,
    "no such container",
  );
});

test("collectContainerLogs includes stderr from a successful docker logs call", async () => {
  const text = await collectContainerLogs(
    OWNED_ID,
    { stateDir: "/var/lib/turbopanel" },
    {
      listManifests: () => Promise.resolve(ownedManifests()),
      runDocker: (args) => {
        if (args[0] === "inspect") return Promise.resolve(ok(inspectStdout()));
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "2026-01-01T00:00:00Z warn from stderr\n",
          code: 0,
        });
      },
    },
  );

  assertEquals(text.includes("warn from stderr"), true);
});

test("collectContainerLogs throws when docker logs fails", async () => {
  await assertRejects(
    () =>
      collectContainerLogs(OWNED_ID, { stateDir: "/var/lib/turbopanel" }, {
        listManifests: () => Promise.resolve(ownedManifests()),
        runDocker: (args) => {
          if (args[0] === "inspect") {
            return Promise.resolve(ok(inspectStdout()));
          }
          return Promise.resolve(fail("permission denied"));
        },
      }),
    Error,
    "permission denied",
  );
});

test("collectContainerLogs rejects empty compose labels as unowned", async () => {
  await assertRejects(
    () =>
      collectContainerLogs(OWNED_ID, { stateDir: "/var/lib/turbopanel" }, {
        listManifests: () => Promise.resolve(ownedManifests()),
        runDocker: (args) => {
          if (args[0] === "inspect") return Promise.resolve(ok("\n\n"));
          return Promise.resolve(ok("should-not-run\n"));
        },
      }),
    Error,
    "not owned by this host",
  );
});

test("collectContainerLogs truncates oversized UTF-8 tails by byte length", async () => {
  const euro = "€";
  const payload = `HEAD-DROP\n${euro.repeat(80_000)}\nTAIL-KEEP`;
  const text = await collectContainerLogs(
    OWNED_ID,
    { stateDir: "/var/lib/turbopanel" },
    {
      listManifests: () => Promise.resolve(ownedManifests()),
      runDocker: (args) => {
        if (args[0] === "inspect") return Promise.resolve(ok(inspectStdout()));
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: payload,
          code: 0,
        });
      },
    },
  );

  const encoded = new TextEncoder().encode(text);
  assertEquals(encoded.byteLength <= 200 * 1024, true);
  assertEquals(text.includes("TAIL-KEEP"), true);
  assertEquals(text.includes("HEAD-DROP"), false);
});
