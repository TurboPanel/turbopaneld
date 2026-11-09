import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { createNoopCommandOutputSink } from "../logs/contracts.ts";
import { parseEnvironmentStopPayload } from "../contracts/commands-contracts.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";
import {
  removeStopVolumes,
  volumeSummary,
} from "./stop-environment-volumes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const KEEP = "0195a5a0-0000-7000-8000-000000000001";
const GONE = "0195a5a0-0000-7000-8000-000000000002";
const USED = "0195a5a0-0000-7000-8000-000000000003";
const BROKEN = "0195a5a0-0000-7000-8000-000000000004";

function ok(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function fail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

/** A fake Docker that knows four volumes and records every call. */
function fakeDocker() {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    const name = args.at(-1) ?? "";
    if (args[0] === "volume" && args[1] === "inspect") {
      return Promise.resolve(
        name === GONE ? fail(`Error: No such volume: ${name}`) : ok(name),
      );
    }
    if (args[0] === "ps") {
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      return Promise.resolve(
        filter === `volume=${USED}` ? ok("other-env-web-1\n") : ok(""),
      );
    }
    if (args[0] === "volume" && args[1] === "rm") {
      return Promise.resolve(
        name === BROKEN ? fail("Error: volume is busy\nmore") : ok(name),
      );
    }
    return Promise.resolve(ok());
  };
  return { calls, run };
}

test("removeStopVolumes removes, skips a volume in use and reports each", async () => {
  const docker = fakeDocker();
  const lines: string[] = [];
  const sink = {
    ...createNoopCommandOutputSink(),
    onLine: (_stream: string, line: string) => lines.push(line),
  };
  const states = await removeStopVolumes(
    [{ storageId: KEEP }, { storageId: GONE }, { storageId: USED }, {
      storageId: BROKEN,
    }],
    {
      environmentId: "env-1",
      dockerPresent: true,
      run: docker.run,
      logSink: sink,
    },
  );
  assertEquals(states, [
    { storageId: KEEP, state: "removed" },
    { storageId: GONE, state: "absent" },
    { storageId: USED, state: "kept", reason: "still used by other-env-web-1" },
    { storageId: BROKEN, state: "failed", reason: "Error: volume is busy" },
  ]);
  // Never forced: a volume in use is left to Docker's own refusal too.
  const removals = docker.calls.filter((args) => args[1] === "rm");
  assertEquals(removals, [["volume", "rm", KEEP], ["volume", "rm", BROKEN]]);
  assertEquals(lines.length, 4);
  assertEquals(
    volumeSummary(states),
    "data volumes removed: 2, kept: 1, failed: 1",
  );
  assertEquals(volumeSummary([]), null);
});

test("removeStopVolumes keeps every volume when Docker is not installed", async () => {
  const docker = fakeDocker();
  const states = await removeStopVolumes([{ storageId: KEEP }], {
    environmentId: "env-1",
    dockerPresent: false,
    run: docker.run,
    logSink: createNoopCommandOutputSink(),
  });
  assertEquals(states, [{
    storageId: KEEP,
    state: "kept",
    reason: "Docker is not installed on this server",
  }]);
  assertEquals(docker.calls, []);
});

test("removeStopVolumes reports a Docker error instead of throwing", async () => {
  const states = await removeStopVolumes([{ storageId: KEEP }], {
    environmentId: "env-1",
    dockerPresent: true,
    run: () => Promise.reject(new Error("docker exploded")),
    logSink: createNoopCommandOutputSink(),
  });
  assertEquals(states, [{
    storageId: KEEP,
    state: "failed",
    reason: "docker exploded",
  }]);
});

test("removeStopVolumes keeps a volume when the container list cannot be read", async () => {
  const states = await removeStopVolumes([{ storageId: KEEP }], {
    environmentId: "env-1",
    dockerPresent: true,
    run: (args) =>
      Promise.resolve(args[0] === "ps" ? fail("daemon down") : ok(KEEP)),
    logSink: createNoopCommandOutputSink(),
  });
  assertEquals(states[0]?.state, "kept");
});

test("parseEnvironmentStopPayload accepts only storage ids in removeVolumes", () => {
  const base = { environmentId: "e", projectId: "p", projectName: "tp-x" };
  assertEquals(
    parseEnvironmentStopPayload({
      ...base,
      removeVolumes: [{ storageId: KEEP }, { storageId: KEEP }],
    }).removeVolumes,
    [{ storageId: KEEP }],
  );
  assertEquals(parseEnvironmentStopPayload(base).removeVolumes, undefined);
  for (
    const bad of [
      "managed_x_data",
      "../x",
      KEEP.toUpperCase(),
      "",
    ]
  ) {
    let threw = false;
    try {
      parseEnvironmentStopPayload({
        ...base,
        removeVolumes: [{ storageId: bad }],
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, bad);
  }
  let notArray = false;
  try {
    parseEnvironmentStopPayload({ ...base, removeVolumes: KEEP });
  } catch {
    notArray = true;
  }
  assertEquals(notArray, true);
});

test({
  name:
    "handleEnvironmentStop removes named volumes on an already stopped environment and reports them",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-volumes-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    const docker = fakeDocker();
    try {
      const result = await handleEnvironmentStop(
        {
          environmentId: "envvol01",
          projectId: "proj-1",
          projectName: "tp-demo-envvol01",
          removeVolumes: [{ storageId: KEEP }, { storageId: USED }],
        },
        new Date().toISOString(),
        {
          runDocker: docker.run,
          runPrivileged: () =>
            Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
        },
      );
      assertEquals(result.containers, []);
      assertEquals(result.volumes, [
        { storageId: KEEP, state: "removed" },
        {
          storageId: USED,
          state: "kept",
          reason: "still used by other-env-web-1",
        },
      ]);
      assertEquals(
        result.summary.includes("data volumes removed: 1, kept: 1"),
        true,
      );

      const plain = await handleEnvironmentStop(
        {
          environmentId: "envvol01",
          projectId: "proj-1",
          projectName: "tp-demo-envvol01",
        },
        new Date().toISOString(),
        { runDocker: docker.run },
      );
      assertEquals("volumes" in plain, false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});
