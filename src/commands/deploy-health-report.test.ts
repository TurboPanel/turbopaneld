import { assertEquals } from "@std/assert";
import {
  createNoopCommandOutputSink,
  type HealthStepReport,
} from "../logs/contracts.ts";
import { reportHealthGate, waitingLine } from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function recorder() {
  const steps: string[] = [];
  const lines: string[] = [];
  const health: HealthStepReport = {
    waiting: (text) => steps.push(`waiting ${text}`),
    done: (title, note) => steps.push(`done ${title} | ${note}`),
    failed: (title, note) => steps.push(`failed ${title} | ${note}`),
    ended: () => steps.length > 0,
  };
  const sink = {
    ...createNoopCommandOutputSink(),
    onLine: (_stream: string, message: string) => lines.push(message),
    health,
  };
  return { sink, steps, lines };
}

test("a pass where Docker said healthy ends the step as healthy with the time it took", () => {
  const { sink, steps, lines } = recorder();
  reportHealthGate(sink, {
    ok: true,
    services: ["db", "web"],
    elapsedMs: 12_400,
    unchecked: [],
  });
  assertEquals(steps, ["done Service Is Healthy | Healthy after 12 s"]);
  assertEquals(lines, ["db, web: Healthy after 12 s"]);
});

test("a pass without a health check says so and never claims healthy", () => {
  const { sink, steps } = recorder();
  reportHealthGate(sink, {
    ok: true,
    services: ["worker"],
    elapsedMs: 30_000,
    unchecked: ["worker"],
  });
  assertEquals(steps, [
    "done Service Is Running | worker stayed running for 30 s; no health check is configured, so that is all that was checked",
  ]);
});

test("a timeout ends the step with the last status", () => {
  const { sink, steps } = recorder();
  reportHealthGate(sink, {
    ok: false,
    reason: "timeout",
    detail: "did not become healthy within 120 s; last status: web is starting",
  });
  assertEquals(steps, [
    "failed Service Did Not Become Healthy | Did not become healthy within 120 s; last status: web is starting",
  ]);
});

test("the live line carries the attempt and the time waited", () => {
  assertEquals(
    waitingLine(
      { attempt: 4, elapsedMs: 6_000, pending: ["web is starting"] },
      120_000,
    ),
    "Attempt 4, 6 s of up to 120 s: web is starting",
  );
});
