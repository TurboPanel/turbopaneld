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
const OK: HealthGateResult = { ok: true, services: ["web"] };

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
  detail: "health gate timed out after 120s: web healthcheck is starting",
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
  const verbs = calls.filter((c) => !c.startsWith("phase") && c !== "gate");
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
  assert(err.reason.includes("timed out after 120s"));
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
