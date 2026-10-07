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
      peerBootHoldSupport: () => true,
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

test("a control plane that cannot answer gets nothing and the hold is released locally", async () => {
  await withTempLayout(async ({ env }) => {
    const sent: BootHoldEventMessage[] = [];
    const docker = dockerOk();
    const reporter = new BootHoldReporter({
      layout: resolveLayout(env),
      run: docker.run,
      listHolds: () => Promise.resolve([HOLD]),
      peerBootHoldSupport: () => false,
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    await reporter.tick();
    assertEquals(sent, []);
    assertEquals(docker.calls, [["compose", "-p", HOLD.managedId, "start"]]);
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
      peerBootHoldSupport: () => true,
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
      peerBootHoldSupport: () => true,
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

test("a control plane whose feature list has not arrived yet is never read as 'cannot answer'", async () => {
  await withTempLayout(async ({ env }) => {
    const sent: BootHoldEventMessage[] = [];
    const docker = dockerOk();
    let support: boolean | undefined = undefined;
    const reporter = new BootHoldReporter({
      layout: resolveLayout(env),
      run: docker.run,
      listHolds: () => Promise.resolve([HOLD]),
      peerBootHoldSupport: () => support,
      send: (message) => {
        sent.push(message);
        return true;
      },
      // Long enough that only the explicit ticks below run.
      recheckMs: 3_600_000,
    });
    // The socket just attached: the attach frame has not arrived.
    await reporter.tick();
    await reporter.tick();
    assertEquals(sent.length + docker.calls.length, 0);
    // The frame arrives and lists the feature: now it reports, and starts nothing.
    support = true;
    await reporter.tick();
    assertEquals(sent.length, 1);
    assertEquals(docker.calls, []);
  });
});

test("while the feature list is unknown the reporter looks again soon, then reports", async () => {
  await withTempLayout(async ({ env }) => {
    const sent: BootHoldEventMessage[] = [];
    const docker = dockerOk();
    let support: boolean | undefined = undefined;
    const reporter = new BootHoldReporter({
      layout: resolveLayout(env),
      run: docker.run,
      listHolds: () => Promise.resolve([HOLD]),
      peerBootHoldSupport: () => support,
      send: (message) => {
        sent.push(message);
        return true;
      },
      intervalMs: 3_600_000,
      recheckMs: 5,
    });
    reporter.attach();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(sent.length, 0);
    support = true;
    await new Promise((resolve) => setTimeout(resolve, 60));
    reporter.detach();
    assertEquals(sent.length >= 1, true);
    assertEquals(docker.calls, []);
  });
});

test("detach cancels the quick re-look", async () => {
  await withTempLayout(async ({ env }) => {
    let looks = 0;
    const reporter = new BootHoldReporter({
      layout: resolveLayout(env),
      run: dockerOk().run,
      listHolds: () => {
        looks += 1;
        return Promise.resolve([HOLD]);
      },
      peerBootHoldSupport: () => undefined,
      send: () => true,
      intervalMs: 3_600_000,
      recheckMs: 5,
    });
    reporter.attach();
    await new Promise((resolve) => setTimeout(resolve, 20));
    reporter.detach();
    const seen = looks;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEquals(looks, seen);
  });
});

test("the client only reports support once the attach frame arrived, and forgets it per socket", async () => {
  const source = await Deno.readTextFile(
    new URL("./client.ts", import.meta.url),
  );
  // The observers attach right after the socket opens, BEFORE `ws.onmessage` is
  // set and so before the frame that carries the feature list is handled.
  const attach = source.indexOf("this.#bootHoldReporter?.attach()");
  const onmessage = source.indexOf("ws.onmessage = ");
  assertEquals(attach > 0 && onmessage > attach, true);
  assertEquals(
    source.includes(
      "this.#peerFeaturesKnown\n          ? this.instanceSupports(MANAGED_HA_BOOT_HOLD_FEATURE)\n          : undefined",
    ),
    true,
  );
  // Known only after the frame, and reset on connect and on close.
  const noted = source.slice(
    source.indexOf("#notePeerFeatures(features: unknown)"),
  );
  assertEquals(
    noted.slice(0, 160).includes("this.#peerFeaturesKnown = true"),
    true,
  );
  assertEquals(
    source.split("this.#peerFeaturesKnown = false").length - 1 >= 2,
    true,
  );
});
