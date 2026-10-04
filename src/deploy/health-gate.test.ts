import { assertEquals } from "@std/assert";
import {
  composePsForGate,
  type HealthGateOptions,
  judgeContainer,
  waitForHealthGate,
} from "./health-gate.ts";
import type { DockerCliResult } from "./docker-cli.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Row = {
  ID?: string;
  Service: string;
  State: string;
  Health?: string;
  ExitCode?: number;
};

function ps(...rows: Row[]): string {
  return JSON.stringify(rows.map((r) => ({ ID: r.Service + "-id", ...r })));
}

/** A fake clock whose `sleep` advances time and feeds the next `ps` snapshot. */
function harness(
  snapshots: (string | null)[],
  extra?: Partial<HealthGateOptions>,
) {
  let t = 0;
  let i = 0;
  const progress: string[] = [];
  const options: HealthGateOptions = {
    ps: () => {
      const snap = snapshots[Math.min(i, snapshots.length - 1)] ?? null;
      i++;
      return Promise.resolve(snap);
    },
    timeoutMs: 10_000,
    stableMs: 3_000,
    pollMs: 1_000,
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    onProgress: (m) => progress.push(m),
    ...extra,
  };
  return { options, progress, polls: () => i };
}

test("passes when every service with a healthcheck is healthy", async () => {
  const { options } = harness([
    ps(
      { Service: "web", State: "running", Health: "starting" },
      { Service: "db", State: "running", Health: "healthy" },
    ),
    ps(
      { Service: "web", State: "running", Health: "healthy" },
      { Service: "db", State: "running", Health: "healthy" },
    ),
  ]);
  const result = await waitForHealthGate(options);
  assertEquals(result, { ok: true, services: ["db", "web"] });
});

test("fails immediately on an unhealthy container", async () => {
  const { options, polls } = harness([
    ps({ Service: "web", State: "running", Health: "unhealthy" }),
  ]);
  const result = await waitForHealthGate(options);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, "unhealthy");
    assertEquals(result.service, "web");
  }
  assertEquals(polls(), 1);
});

test("a service without a healthcheck must stay running for the stable window", async () => {
  const running = ps({ Service: "worker", State: "running", Health: "" });
  const { options, polls } = harness([running]);
  const result = await waitForHealthGate(options);
  assertEquals(result.ok, true);
  // Seen at t=0, passes at t=3000: polls at 0,1000,2000,3000.
  assertEquals(polls(), 4);
});

test("mode none trusts a running container on the first poll", async () => {
  const { options, polls } = harness(
    [ps({ Service: "worker", State: "running" })],
    { mode: "none" },
  );
  assertEquals((await waitForHealthGate(options)).ok, true);
  assertEquals(polls(), 1);
});

test("a container that stops running resets its stable window", async () => {
  const up = ps({ Service: "w", State: "running" });
  const starting = ps({ Service: "w", State: "created" });
  const { options, polls } = harness([up, up, starting, up, up, up, up]);
  const result = await waitForHealthGate(options);
  assertEquals(result.ok, true);
  // Window restarts at the 4th poll (t=3000) and passes at t=6000.
  assertEquals(polls(), 7);
});

test("a non-zero exit fails; exit code 0 counts as a finished one-shot", async () => {
  const failed = await waitForHealthGate(
    harness([ps({ Service: "migrate", State: "exited", ExitCode: 1 })]).options,
  );
  assertEquals(failed.ok === false && failed.reason, "exited");

  const done = await waitForHealthGate(
    harness([
      ps(
        { Service: "migrate", State: "exited", ExitCode: 0 },
        { Service: "web", State: "running", Health: "healthy" },
      ),
    ]).options,
  );
  assertEquals(done.ok, true);
});

test("a crash loop fails as restarting", async () => {
  const result = await waitForHealthGate(
    harness([ps({ Service: "web", State: "restarting" })]).options,
  );
  assertEquals(result.ok === false && result.reason, "restarting");
});

test("times out and names what was still pending", async () => {
  const { options } = harness([
    ps({ Service: "web", State: "running", Health: "starting" }),
  ]);
  const result = await waitForHealthGate(options);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, "timeout");
    assertEquals(result.detail.includes("web"), true);
    assertEquals(result.detail.includes("10s"), true);
  }
});

test("no containers ever reported fails as no-containers", async () => {
  const result = await waitForHealthGate(harness(["[]"]).options);
  assertEquals(result.ok === false && result.reason, "no-containers");
});

test("a failing ps is retried, and reported as ps-failed on timeout", async () => {
  const recovered = await waitForHealthGate(
    harness([
      null,
      ps({ Service: "web", State: "running", Health: "healthy" }),
    ]).options,
  );
  assertEquals(recovered.ok, true);

  const never = await waitForHealthGate(harness([null]).options);
  assertEquals(never.ok === false && never.reason, "ps-failed");
});

test("accepts NDJSON output and replicas: every replica must pass", async () => {
  const lines = [
    { ID: "a", Service: "web", State: "running", Health: "healthy" },
    { ID: "b", Service: "web", State: "running", Health: "starting" },
  ].map((r) => JSON.stringify(r)).join("\n");
  const stuck = await waitForHealthGate(harness([lines]).options);
  assertEquals(stuck.ok === false && stuck.reason, "timeout");
});

test("reports progress while waiting", async () => {
  const { options, progress } = harness([
    ps({ Service: "web", State: "running", Health: "starting" }),
    ps({ Service: "web", State: "running", Health: "healthy" }),
  ]);
  await waitForHealthGate(options);
  assertEquals(progress.length, 1);
});

test("judgeContainer: states that are not started yet keep waiting", () => {
  const verdict = judgeContainer(
    { id: "abc", service: "web", state: "created", health: "", exitCode: 0 },
    0,
    1000,
  );
  assertEquals(verdict.kind, "wait");
});

test("composePsForGate runs `compose ps -a --format json` and nulls on failure", async () => {
  const calls: string[][] = [];
  const ok = (stdout: string): DockerCliResult => ({
    success: true,
    code: 0,
    stdout,
    stderr: "",
  } as DockerCliResult);
  const fail = {
    success: false,
    code: 1,
    stdout: "",
    stderr: "boom",
  } as DockerCliResult;
  const good = composePsForGate(
    (args) => {
      calls.push(args);
      return Promise.resolve(ok("[]"));
    },
    "proj",
    ["/d/compose.yaml"],
  );
  assertEquals(await good(), "[]");
  assertEquals(calls[0], [
    "compose",
    "-p",
    "proj",
    "-f",
    "/d/compose.yaml",
    "ps",
    "-a",
    "--format",
    "json",
  ]);
  const bad = composePsForGate(() => Promise.resolve(fail), "p", ["/c.yaml"]);
  assertEquals(await bad(), null);
});
