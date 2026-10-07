import { assertEquals } from "@std/assert";
import type { DaemonMessage } from "../contracts/cell-messages.ts";
import type { ManagedHaMemberRecord } from "../managed/ha-member.ts";
import type { ManagedHealthProbeResult } from "../managed/health.ts";
import {
  MANAGED_HEALTH_REPORT_MAX_MEMBERS,
  ManagedHealthReporter,
} from "./managed-health-reporter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` and would report Deno suites as empty.
 */
const test = Deno.test.bind(Deno);

const AT = "2026-10-06T12:00:00.000Z";

function member(
  memberId: string,
  role: "primary" | "replica" = "replica",
): ManagedHaMemberRecord {
  return {
    managedId: "managed_1",
    memberId,
    engine: "postgres",
    role,
    containerName: `c-${memberId}`,
    replicaPeerCount: 1,
    updatedAt: AT,
  };
}

function streaming(memberId: string): ManagedHealthProbeResult {
  return {
    ok: true,
    member: {
      memberId,
      role: "replica",
      status: "ready",
      replication: { state: "streaming", observedAt: AT, lagBytes: 0 },
    },
  };
}

function setup(options: {
  members: ManagedHaMemberRecord[];
  probe: (record: ManagedHaMemberRecord) => Promise<ManagedHealthProbeResult>;
  supported?: boolean;
}) {
  const sent: DaemonMessage[] = [];
  const reporter = new ManagedHealthReporter({
    send: (message) => {
      sent.push(message);
      return true;
    },
    peerSupportsReport: () => options.supported ?? true,
    now: () => AT,
    listMembers: () => Promise.resolve(options.members),
    probe: options.probe,
  });
  return { reporter, sent };
}

test("reports every replica in one frame and skips the primary", async () => {
  const probed: string[] = [];
  const { reporter, sent } = setup({
    members: [member("p", "primary"), member("r1"), member("r2")],
    probe: (record) => {
      probed.push(record.memberId);
      return Promise.resolve(streaming(record.memberId));
    },
  });
  await reporter.poll();
  assertEquals(probed.sort(), ["r1", "r2"]);
  assertEquals(sent.length, 1);
  const frame = sent[0];
  assertEquals(frame.type, "managed-health-report");
  if (frame.type !== "managed-health-report") return;
  assertEquals(frame.at, AT);
  assertEquals(frame.members.map((entry) => entry.memberId), ["r1", "r2"]);
  assertEquals(frame.members[0].replication?.state, "streaming");
});

test("a replica whose engine is not running is reported down, not left out", async () => {
  const { reporter, sent } = setup({
    members: [member("r1")],
    probe: () =>
      Promise.resolve({
        ok: false,
        error:
          "replication health unavailable (engine not running or not answering)",
      }),
  });
  await reporter.poll();
  const frame = sent[0];
  if (frame?.type !== "managed-health-report") throw new Error("no frame");
  assertEquals(frame.members, [
    { managedId: "managed_1", memberId: "r1", down: true },
  ]);
});

test("an unrelated probe error says nothing about the replica, so nothing is sent for it", async () => {
  const { reporter, sent } = setup({
    members: [member("r1"), member("r2")],
    probe: (record) =>
      Promise.resolve(
        record.memberId === "r1"
          ? { ok: false, error: "memberId is not a valid id" }
          : streaming("r2"),
      ),
  });
  await reporter.poll();
  const frame = sent[0];
  if (frame?.type !== "managed-health-report") throw new Error("no frame");
  assertEquals(frame.members.map((entry) => entry.memberId), ["r2"]);
});

test("sends nothing to a control plane that does not advertise the feature", async () => {
  let probes = 0;
  const { reporter, sent } = setup({
    members: [member("r1")],
    supported: false,
    probe: () => {
      probes += 1;
      return Promise.resolve(streaming("r1"));
    },
  });
  await reporter.poll();
  assertEquals(sent.length, 0);
  assertEquals(probes, 0);
});

test("sends nothing when this host runs no replica", async () => {
  const { reporter, sent } = setup({
    members: [member("p", "primary")],
    probe: () => Promise.resolve(streaming("p")),
  });
  await reporter.poll();
  assertEquals(sent.length, 0);
});

test("a frame never lists more members than the control plane accepts", async () => {
  const many = Array.from(
    { length: MANAGED_HEALTH_REPORT_MAX_MEMBERS + 5 },
    (_, index) => member(`r${index}`),
  );
  const { reporter, sent } = setup({
    members: many,
    probe: (record) => Promise.resolve(streaming(record.memberId)),
  });
  await reporter.poll();
  const frame = sent[0];
  if (frame?.type !== "managed-health-report") throw new Error("no frame");
  assertEquals(frame.members.length, MANAGED_HEALTH_REPORT_MAX_MEMBERS);
});

test("a poll that overlaps a slow one does nothing", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let probes = 0;
  const { reporter, sent } = setup({
    members: [member("r1")],
    probe: async () => {
      probes += 1;
      await gate;
      return streaming("r1");
    },
  });
  const first = reporter.poll();
  await reporter.poll();
  release();
  await first;
  assertEquals(probes, 1);
  assertEquals(sent.length, 1);
});
