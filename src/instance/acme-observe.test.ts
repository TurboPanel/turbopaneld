import { assertEquals } from "@std/assert";
import { createFakeClock, flushMicrotasks } from "../testing/fake-clock.ts";
import {
  type AcmeIssuanceEventMessage,
  AcmeIssuanceObserver,
} from "./acme-observe.ts";
import type { AcmeProbeResult } from "../deploy/acme-probe.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("AcmeIssuanceObserver.attach schedules poll and detach clears the timer", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  const clock = createFakeClock();
  const observer = new AcmeIssuanceObserver({
    intervalMs: 20,
    now: () => new Date(clock.now()).toISOString(),
    send: (message) => {
      sent.push(message);
    },
    listHostnames: () => Promise.resolve(["a.example.com"]),
    probe: () =>
      Promise.resolve(
        { hostname: "a.example.com", ok: false, errorMessage: "boom" },
      ),
  });

  observer.attach();
  await new Promise((resolve) => setTimeout(resolve, 65));
  await flushMicrotasks();
  observer.detach();
  const afterDetach = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 65));
  await flushMicrotasks();

  assertEquals(afterDetach >= 1, true);
  assertEquals(sent.length, afterDetach);
});

test("does not report a failure until the debounce threshold is reached", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(["a.example.com"]),
    probe: () =>
      Promise.resolve(
        { hostname: "a.example.com", ok: false, errorMessage: "boom" },
      ),
  });

  await observer.poll();
  assertEquals(sent.length, 0, "first bad poll alone must not fire an event");

  await observer.poll();
  assertEquals(sent.length, 1, "second consecutive bad poll fires the event");
  assertEquals(sent[0]?.type, "acme-issuance-event");
  assertEquals(sent[0]?.hostname, "a.example.com");
  assertEquals(sent[0]?.ok, false);
  assertEquals(sent[0]?.errorMessage, "boom");

  await observer.poll();
  assertEquals(
    sent.length,
    1,
    "a third consecutive bad poll must not re-fire the already-reported failure",
  );
});

test("reports a recovery once, immediately, with no debounce", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  let ok = false;
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(["a.example.com"]),
    probe: (): Promise<AcmeProbeResult> =>
      Promise.resolve(
        ok
          ? { hostname: "a.example.com", ok: true }
          : { hostname: "a.example.com", ok: false, errorMessage: "boom" },
      ),
  });

  await observer.poll();
  await observer.poll();
  assertEquals(sent.length, 1);
  assertEquals(sent[0]?.ok, false);

  ok = true;
  await observer.poll();
  assertEquals(sent.length, 2, "the very next good poll reports recovery");
  assertEquals(sent[1]?.ok, true);
  assertEquals(sent[1]?.errorMessage, undefined);

  await observer.poll();
  assertEquals(sent.length, 2, "a second good poll in a row does not re-fire");
});

test("resets the failure streak after an intermittent success", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  const outcomes: boolean[] = [false, true, false, false];
  let i = 0;
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(["a.example.com"]),
    probe: (): Promise<AcmeProbeResult> => {
      const isOk = outcomes[i++] ?? true;
      return Promise.resolve(
        isOk
          ? { hostname: "a.example.com", ok: true }
          : { hostname: "a.example.com", ok: false, errorMessage: "boom" },
      );
    },
  });

  await observer.poll(); // fail (1st)
  await observer.poll(); // ok — resets streak, first good sighting is reported
  await observer.poll(); // fail (1st again)
  await observer.poll(); // fail (2nd) — now reports
  assertEquals(sent.map((m) => m.ok), [true, false]);
});

test("stops tracking a hostname once it leaves the acme-mode set (no phantom failures)", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  let hostnames = ["a.example.com"];
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(hostnames),
    probe: (hostname): Promise<AcmeProbeResult> =>
      Promise.resolve({ hostname, ok: false, errorMessage: "boom" }),
  });

  await observer.poll(); // 1st failure, no report yet
  hostnames = []; // environment moved off acme-mode / was removed
  await observer.poll(); // nothing left to poll
  hostnames = ["a.example.com"]; // hostname reappears (a fresh deploy)
  await observer.poll(); // must start the streak over, not continue at 2
  assertEquals(
    sent.length,
    0,
    "the stale streak must not carry over across a manifest gap",
  );
});

test("swallows listHostnames/probe failures without throwing", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  const observer = new AcmeIssuanceObserver({
    send: (message) => sent.push(message),
    listHostnames: () => Promise.reject(new Error("disk read failed")),
    probe: () => {
      throw new TypeError("must not be called");
    },
  });
  await observer.poll();
  assertEquals(sent.length, 0);
});

test("tracks multiple hostnames independently", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(["a.example.com", "b.example.com"]),
    probe: (hostname): Promise<AcmeProbeResult> =>
      Promise.resolve(
        hostname === "a.example.com"
          ? { hostname, ok: false, errorMessage: "boom" }
          : { hostname, ok: true },
      ),
  });

  await observer.poll();
  await observer.poll();
  const failed = sent.filter((m) => !m.ok);
  assertEquals(failed.length, 1);
  assertEquals(failed[0]?.hostname, "a.example.com");
  const good = sent.filter((m) => m.ok);
  assertEquals(good.length, 1, "b is reported good once, on first sighting");
  assertEquals(good[0]?.hostname, "b.example.com");
});

test("reports the first good sighting with its notAfter, then stays quiet", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(["a.example.com"]),
    probe: (hostname): Promise<AcmeProbeResult> =>
      Promise.resolve({
        hostname,
        ok: true,
        notAfter: "2026-12-01T00:00:00.000Z",
      }),
  });

  await observer.poll();
  await observer.poll();
  assertEquals(sent.length, 1);
  assertEquals(sent[0]?.ok, true);
  assertEquals(sent[0]?.notAfter, "2026-12-01T00:00:00.000Z");
});

test("re-reports a good hostname when a renewal changes notAfter", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  let notAfter: string | undefined = "2026-12-01T00:00:00.000Z";
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(["a.example.com"]),
    probe: (hostname): Promise<AcmeProbeResult> =>
      Promise.resolve({
        hostname,
        ok: true,
        ...(notAfter ? { notAfter } : {}),
      }),
  });

  await observer.poll();
  notAfter = undefined; // an unreadable expiry is not a renewal
  await observer.poll();
  notAfter = "2027-03-01T00:00:00.000Z";
  await observer.poll();
  await observer.poll();
  assertEquals(sent.map((m) => m.notAfter), [
    "2026-12-01T00:00:00.000Z",
    "2027-03-01T00:00:00.000Z",
  ]);
});

test("a recovery carries notAfter, a failure never does", async () => {
  const sent: AcmeIssuanceEventMessage[] = [];
  let ok = false;
  const observer = new AcmeIssuanceObserver({
    now: () => "2026-09-16T00:00:00.000Z",
    send: (message) => sent.push(message),
    listHostnames: () => Promise.resolve(["a.example.com"]),
    probe: (hostname): Promise<AcmeProbeResult> =>
      Promise.resolve(
        ok
          ? { hostname, ok: true, notAfter: "2026-12-01T00:00:00.000Z" }
          : { hostname, ok: false, errorMessage: "boom" },
      ),
  });

  await observer.poll();
  await observer.poll();
  ok = true;
  await observer.poll();
  assertEquals(sent.map((m) => [m.ok, m.notAfter]), [
    [false, undefined],
    [true, "2026-12-01T00:00:00.000Z"],
  ]);
});
