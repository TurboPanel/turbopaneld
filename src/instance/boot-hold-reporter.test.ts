import { assertEquals } from "@std/assert";
import type { BootHoldRecord } from "../managed/boot-hold.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  type BootHoldEventMessage,
  BootHoldReporter,
} from "./boot-hold-reporter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HOLD: BootHoldRecord = {
  managedId: "00000000-0000-4000-8000-000000000001",
  memberId: "00000000-0000-4000-8000-0000000000a1",
  engine: "postgres",
  heldAt: "2026-10-06T10:00:00.000Z",
  engineStopped: true,
};

function dockerOk() {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    },
  };
}

test("reports each held primary as a boot-hold event, never as a failover", async () => {
  await withTempLayout(async ({ env }) => {
    const sent: BootHoldEventMessage[] = [];
    const docker = dockerOk();
    const reporter = new BootHoldReporter({
      layout: resolveLayout(env),
      run: docker.run,
      listHolds: () => Promise.resolve([HOLD]),
      send: (message) => {
        sent.push(message);
        return true;
      },
      now: () => "2026-10-06T10:01:00.000Z",
    });
    await reporter.tick();
    assertEquals(sent, [
      {
        type: "managed-ha-event",
        managedId: HOLD.managedId,
        sourceMemberId: HOLD.memberId,
        detector: "boot-hold",
        evidence: {
          reason: "unclean-boot",
          heldAt: HOLD.heldAt,
          engineStopped: true,
        },
        at: "2026-10-06T10:01:00.000Z",
      },
    ]);
    // Reporting never touches the engine when it is already stopped.
    assertEquals(docker.calls, []);
  });
});

test("no holds means no events and no docker calls", async () => {
  await withTempLayout(async ({ env }) => {
    const sent: BootHoldEventMessage[] = [];
    const docker = dockerOk();
    const reporter = new BootHoldReporter({
      layout: resolveLayout(env),
      run: docker.run,
      listHolds: () => Promise.resolve([]),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    await reporter.tick();
    assertEquals(sent.length + docker.calls.length, 0);
  });
});

test("a hold whose first stop failed is stopped before it is reported", async () => {
  await withTempLayout(async ({ env }) => {
    const sent: BootHoldEventMessage[] = [];
    const docker = dockerOk();
    const reporter = new BootHoldReporter({
      layout: resolveLayout(env),
      run: docker.run,
      listHolds: () => Promise.resolve([{ ...HOLD, engineStopped: false }]),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    await reporter.tick();
    assertEquals(docker.calls, [["compose", "-p", HOLD.managedId, "stop"]]);
    assertEquals(sent[0]?.evidence.engineStopped, true);
  });
});
