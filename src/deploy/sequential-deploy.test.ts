import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  runSequentialDeploy,
  SequentialDeployError,
  type SequentialDeployInput,
  type SequentialDeploySteps,
} from "./sequential-deploy.ts";
import type { HealthGateResult } from "./health-gate.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests (see health-gate.test.ts). */
const test = Deno.test.bind(Deno);

const LIVE = ["/d/compose.yaml"];
const PREV = ["/d/previous/compose.yaml"];
const OK: HealthGateResult = {
  ok: true,
  services: ["web"],
  elapsedMs: 0,
  unchecked: [],
  reported: ["web"],
};

type Script = {
  /** Gate verdicts in order; the last repeats. */
  gates?: HealthGateResult[];
  upFails?: boolean[];
  stopFails?: boolean;
  hooksFail?: boolean;
  prepareFails?: boolean;
  restore?: string[] | null | "throw";
};

function harness(script: Script = {}) {
  const calls: string[] = [];
  let gateIndex = 0;
  let upIndex = 0;
  const gates = script.gates ?? [OK];
  const steps: SequentialDeploySteps = {
    prepare: () => {
      calls.push("prepare");
      if (script.prepareFails) return Promise.reject(new Error("build broke"));
      return Promise.resolve();
    },
    run: (args) => {
      calls.push(`run ${args.join(" ")}`);
      return Promise.resolve({
        success: true,
        stderr: "",
        stdout: "web\ndb\nworker\n",
      });
    },
    runStreamed: (args) => {
      const verb = args.find((a) => a === "stop" || a === "up") ?? "?";
      calls.push(`streamed ${args.slice(args.indexOf(verb)).join(" ")}`);
      if (verb === "stop") {
        return Promise.resolve({
          success: !script.stopFails,
          stderr: script.stopFails ? "stop broke" : "",
        });
      }
      const fails = script.upFails ?? [];
      const failed = fails[upIndex] === true;
      upIndex++;
      return Promise.resolve({
        success: !failed,
        stderr: failed ? "up broke" : "",
      });
    },
    runPreDeployHooks: () => {
      calls.push("hooks");
      if (script.hooksFail) return Promise.reject(new Error("migrate broke"));
      return Promise.resolve();
    },
    gate: () => {
      calls.push("gate");
      const verdict = gates[Math.min(gateIndex, gates.length - 1)];
      gateIndex++;
      return Promise.resolve(verdict);
    },
    restorePrevious: () => {
      calls.push("restore");
      if (script.restore === "throw") return Promise.reject(new Error("io"));
      return Promise.resolve(
        script.restore === undefined ? LIVE : script.restore,
      );
    },
    composeArgs: (paths) => ["compose", "-p", "p", "-f", paths[0]],
    redact: (text) => text.replaceAll("s3cret", "[redacted]"),
    log: () => {},
    setPhase: (phase) => {
      calls.push(`phase ${phase}`);
    },
  };
  return { steps, calls };
}

function input(
  steps: SequentialDeploySteps,
  over: Partial<SequentialDeployInput> = {},
): SequentialDeployInput {
  return {
    composePaths: LIVE,
    previousComposePaths: PREV,
    keepRunning: [],
    hasHooks: false,
    hooksMigrate: false,
    breakingMigration: false,
    steps,
    ...over,
  };
}

const UNHEALTHY: HealthGateResult = {
  ok: false,
  reason: "unhealthy",
  service: "web",
  detail: "web (abc) failed its healthcheck",
};
const TIMEOUT: HealthGateResult = {
  ok: false,
  reason: "timeout",
  detail:
    "did not become healthy within 120 s; last status: web health check is starting",
};

async function outcomeOf(
  promise: Promise<void>,
): Promise<SequentialDeployError> {
  const err = await assertRejects(() => promise, SequentialDeployError);
  assert(err instanceof SequentialDeployError);
  return err;
}

test("success: prepare, stop previous, up, gate, in that order", async () => {
  const { steps, calls } = harness();
  await runSequentialDeploy(input(steps));
  const verbs = calls.filter((c) =>
    !c.startsWith("phase") && c !== "gate" && !c.endsWith("--hash *")
  );
  assertEquals(verbs[0], "prepare");
  assertEquals(
    verbs[1],
    "run compose -p p -f /d/previous/compose.yaml config --services",
  );
  assertEquals(verbs[2], "streamed stop web db worker");
  assertEquals(verbs[3], "streamed up -d --remove-orphans");
  assertEquals(calls.at(-1), "gate");
  assertEquals(calls.includes("restore"), false);
});

test("success: migrations run between stop and up", async () => {
  const { steps, calls } = harness();
  await runSequentialDeploy(
    input(steps, { hasHooks: true, hooksMigrate: true }),
  );
  const order = calls.filter((c) =>
    c.startsWith("streamed stop") || c === "hooks" ||
    c.startsWith("streamed up")
  );
  assertEquals(order, [
    "streamed stop web db worker",
    "hooks",
    "streamed up -d --remove-orphans",
  ]);
});

test("keepRunning services are not stopped", async () => {
  const { steps, calls } = harness();
  await runSequentialDeploy(input(steps, { keepRunning: ["db"] }));
  assert(calls.includes("streamed stop web worker"));
});

test("health failure before any migration rolls back to previous/", async () => {
  const { steps, calls } = harness({ gates: [UNHEALTHY, OK] });
  const err = await outcomeOf(runSequentialDeploy(input(steps)));
  assertEquals(err.outcome, "rolled_back");
  assert(err.message.startsWith("rolled_back: "));
  assert(err.reason.includes("failed its healthcheck"));
  assert(err.reason.includes("previous version is running again"));
  assertEquals(calls.filter((c) => c === "restore").length, 1);
  assertEquals(calls.filter((c) => c.startsWith("streamed up")).length, 2);
  assertEquals(calls.filter((c) => c === "gate").length, 2);
});

test("failed up before any migration also rolls back", async () => {
  const { steps } = harness({ upFails: [true, false] });
  const err = await outcomeOf(runSequentialDeploy(input(steps)));
  assertEquals(err.outcome, "rolled_back");
  assert(err.reason.includes("up broke"));
});

test("health timeout rolls back and names what was pending", async () => {
  const { steps } = harness({ gates: [TIMEOUT, OK] });
  const err = await outcomeOf(runSequentialDeploy(input(steps)));
  assertEquals(err.outcome, "rolled_back");
  assert(err.reason.includes("did not become healthy within 120 s"));
});

test("failure after a migration ran stops: needs_attention, no restore, no second up", async () => {
  const { steps, calls } = harness({ gates: [UNHEALTHY] });
  const err = await outcomeOf(
    runSequentialDeploy(input(steps, { hasHooks: true, hooksMigrate: true })),
  );
  assertEquals(err.outcome, "needs_attention");
  assert(err.reason.includes("a migration already ran"));
  assertEquals(calls.includes("restore"), false);
  assertEquals(calls.filter((c) => c.startsWith("streamed up")).length, 1);
});

test("a failing migration hook is needs_attention and never starts anything", async () => {
  const { steps, calls } = harness({ hooksFail: true });
  const err = await outcomeOf(
    runSequentialDeploy(input(steps, { hasHooks: true, hooksMigrate: true })),
  );
  assertEquals(err.outcome, "needs_attention");
  assert(err.reason.includes("migrate broke"));
  assertEquals(calls.some((c) => c.startsWith("streamed up")), false);
  assertEquals(calls.includes("restore"), false);
});

test("a failing build-only hook (no pre-deploy command) still rolls back", async () => {
  const { steps } = harness({ hooksFail: true });
  const err = await outcomeOf(
    runSequentialDeploy(input(steps, { hasHooks: true, hooksMigrate: false })),
  );
  assertEquals(err.outcome, "rolled_back");
});

test("a declared breaking migration is past the point of no return too", async () => {
  const { steps, calls } = harness({ gates: [UNHEALTHY] });
  const err = await outcomeOf(
    runSequentialDeploy(input(steps, { breakingMigration: true })),
  );
  assertEquals(err.outcome, "needs_attention");
  assertEquals(calls.includes("restore"), false);
});

test("previous/ missing on rollback is needs_attention", async () => {
  const { steps, calls } = harness({ gates: [UNHEALTHY], restore: null });
  const err = await outcomeOf(runSequentialDeploy(input(steps)));
  assertEquals(err.outcome, "needs_attention");
  assert(err.reason.includes("files are missing"));
  assertEquals(calls.filter((c) => c.startsWith("streamed up")).length, 1);
});

test("a restore that throws is needs_attention", async () => {
  const { steps } = harness({ gates: [UNHEALTHY], restore: "throw" });
  const err = await outcomeOf(runSequentialDeploy(input(steps)));
  assertEquals(err.outcome, "needs_attention");
  assert(err.reason.includes("restoring the previous version failed"));
});

test("rollback that does not come back healthy is needs_attention", async () => {
  const { steps } = harness({ gates: [UNHEALTHY, TIMEOUT] });
  const err = await outcomeOf(runSequentialDeploy(input(steps)));
  assertEquals(err.outcome, "needs_attention");
  assert(err.reason.includes("did not come back healthy"));
});

test("first deploy (no previous) fails plainly with nothing to roll back to", async () => {
  const { steps, calls } = harness({ gates: [UNHEALTHY] });
  const err = await assertRejects(() =>
    runSequentialDeploy(input(steps, { previousComposePaths: null }))
  );
  assertEquals(err instanceof SequentialDeployError, false);
  assert((err as Error).message.includes("nothing to roll back to"));
  assertEquals(calls.some((c) => c.includes("stop")), false);
  assertEquals(calls.includes("restore"), false);
});

test("a prepare failure throws plainly before anything is stopped", async () => {
  const { steps, calls } = harness({ prepareFails: true });
  const err = await assertRejects(() => runSequentialDeploy(input(steps)));
  assertEquals(err instanceof SequentialDeployError, false);
  assertEquals(calls.some((c) => c.includes("stop")), false);
});

test("a failed stop rolls back (restores the previous files and starts them)", async () => {
  const { steps, calls } = harness({ stopFails: true });
  const err = await outcomeOf(runSequentialDeploy(input(steps)));
  assertEquals(err.outcome, "rolled_back");
  assert(calls.includes("restore"));
});

test("secrets in docker output are redacted before they reach the reason", async () => {
  const { steps } = harness({ upFails: [true, false] });
  steps.runStreamed = (args) =>
    Promise.resolve({
      success: !args.includes("up") ? true : false,
      stderr: "token=s3cret",
    });
  const err = await assertRejects(
    () => runSequentialDeploy(input(steps)),
    SequentialDeployError,
  );
  assert(!(err as Error).message.includes("s3cret"));
});

/** Docker answers for the unchanged-service check. */
type Docker = {
  /** Hash the new chain computes per service. */
  liveHashes: Record<string, string>;
  /** Hash stamped on the running containers, when not the live one. */
  stamped?: Record<string, string>;
  /** Services whose container runs an image the tag no longer resolves to. */
  staleImage?: string[];
  /** When each service's container started (ISO); defaults to 2026-01-01. */
  startedAt?: Record<string, string>;
  hashBroken?: boolean;
  psFails?: boolean;
  noContainers?: boolean;
  imageInspectFails?: boolean;
};

function dockerHarness(docker: Docker) {
  const base = harness();
  const stops: string[][] = [];
  const ok = (stdout: string) =>
    Promise.resolve({ success: true, stderr: "", stdout });
  const fail = () =>
    Promise.resolve({ success: false, stderr: "x", stdout: "" });
  const steps: SequentialDeploySteps = {
    ...base.steps,
    run: (args) => {
      if (args.includes("--services")) return ok("web\ndb\nworker\n");
      if (args.includes("--hash")) {
        if (docker.hashBroken) return fail();
        return ok(
          Object.entries(docker.liveHashes).map(([n, h]) => `${n} ${h}\n`)
            .join(""),
        );
      }
      if (args.includes("ps")) {
        if (docker.psFails) return fail();
        return ok(docker.noContainers ? "" : `c-${args.at(-1)}\n`);
      }
      if (args[0] === "inspect") {
        const service = args.at(-1)!.slice(2);
        const hash = docker.stamped?.[service] ?? docker.liveHashes[service];
        const id = docker.staleImage?.includes(service) ? "old" : "img";
        const started = docker.startedAt?.[service] ?? "2026-01-01T00:00:00Z";
        return ok(`${hash} ${id} ${service}:1 ${started}\n`);
      }
      if (args[0] === "image") {
        return docker.imageInspectFails ? fail() : ok("img\n");
      }
      return ok("");
    },
    runStreamed: (args) => {
      const at = args.indexOf("stop");
      if (at >= 0) stops.push(args.slice(at + 1));
      return Promise.resolve({ success: true, stderr: "" });
    },
  };
  return { steps, stops };
}

const SAME = { web: "h1", db: "h2", worker: "h3" };
const ALL = [["web", "db", "worker"]];

test("sequential: a service whose config hash is unchanged is not stopped", async () => {
  const { steps, stops } = dockerHarness({
    liveHashes: SAME,
    stamped: { worker: "old-hash" },
  });
  await runSequentialDeploy(input(steps));
  assertEquals(stops, [["worker"]]);
});

test("sequential: nothing stops when every service is unchanged", async () => {
  const { steps, stops } = dockerHarness({ liveHashes: SAME });
  await runSequentialDeploy(input(steps));
  assertEquals(stops, []);
});

test("sequential: a changed env value or tag (a different stamped hash) stops the service", async () => {
  const { steps, stops } = dockerHarness({
    liveHashes: SAME,
    stamped: { web: "x", db: "y" },
  });
  await runSequentialDeploy(input(steps));
  assertEquals(stops, [["web", "db"]]);
});

test("sequential: a re-pulled image stops a service whose config is unchanged", async () => {
  const { steps, stops } = dockerHarness({
    liveHashes: SAME,
    staleImage: ["web"],
  });
  await runSequentialDeploy(input(steps));
  assertEquals(stops, [["web"]]);
});

test("sequential: a file written after the container started stops it, even when an earlier attempt wrote it", async () => {
  const { steps, stops } = dockerHarness({ liveHashes: SAME });
  // The earlier failed attempt wrote db's secret at 2026-02-01, after db
  // started (2026-01-01); this retry rewrites identical content.
  await runSequentialDeploy(
    input(steps, {
      fileTimes: new Map([
        ["db", Date.parse("2026-02-01T00:00:00Z")],
        ["web", Date.parse("2025-12-01T00:00:00Z")],
      ]),
    }),
  );
  assertEquals(stops, [["db"]]);
});

test("sequential: a container restarted after its files changed is left running", async () => {
  const { steps, stops } = dockerHarness({
    liveHashes: SAME,
    startedAt: { db: "2026-03-01T00:00:00Z" },
  });
  await runSequentialDeploy(
    input(steps, {
      fileTimes: new Map([["db", Date.parse("2026-02-01T00:00:00Z")]]),
    }),
  );
  assertEquals(stops, []);
});

for (
  const [name, docker] of [
    ["hashes unreadable", { hashBroken: true }],
    ["ps failing", { psFails: true }],
    ["no containers found", { noContainers: true }],
    ["image inspect failing", { imageInspectFails: true }],
  ] as const
) {
  test(`sequential: ${name} stops every service`, async () => {
    const { steps, stops } = dockerHarness({ liveHashes: SAME, ...docker });
    await runSequentialDeploy(input(steps));
    assertEquals(stops, ALL);
  });
}

test("sequential: a migrating deploy stops every service as before", async () => {
  for (
    const over of [{ hooksMigrate: true, hasHooks: true }, {
      breakingMigration: true,
    }]
  ) {
    const { steps, stops } = dockerHarness({ liveHashes: SAME });
    await runSequentialDeploy(input(steps, over));
    assertEquals(stops, ALL);
  }
});
