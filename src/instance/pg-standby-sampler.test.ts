import { assertEquals } from "@std/assert";
import type { ManagedHaMemberRecord } from "../managed/ha-member.ts";
import type { ManagedReplicationObservedHealth } from "../managed/engines/types.ts";
import { StandbyStreamingTracker } from "../managed/standby-streaming.ts";
import { isSampledStandby, PgStandbySampler } from "./pg-standby-sampler.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` and would report Deno suites as empty.
 */
const test = Deno.test.bind(Deno);

const AT = "2026-10-03T00:00:00.000Z";

function member(
  memberId: string,
  role: "primary" | "replica",
  engine: ManagedHaMemberRecord["engine"] = "postgres",
): ManagedHaMemberRecord {
  return {
    managedId: "managed_1",
    memberId,
    engine,
    role,
    containerName: `c-${memberId}`,
    replicaPeerCount: 1,
    updatedAt: AT,
  };
}

test("only Postgres replicas are sampled", () => {
  assertEquals(isSampledStandby(member("a", "replica")), true);
  assertEquals(isSampledStandby(member("b", "primary")), false);
  assertEquals(isSampledStandby(member("c", "replica", "mysql")), false);
});

test("poll records streaming standbys, stamped before the read", async () => {
  const tracker = new StandbyStreamingTracker();
  let mono = 1_000;
  const read: string[] = [];
  const sampler = new PgStandbySampler({
    tracker,
    monoMs: () => mono,
    globallyEnabled: () => true,
    listMembers: () =>
      Promise.resolve([
        member("r1", "replica"),
        member("r2", "replica"),
        member("p", "primary"),
      ]),
    readStandby: (name): Promise<ManagedReplicationObservedHealth> => {
      read.push(name);
      mono = 1_500; // the read takes time; the stamp must not move with it
      return Promise.resolve({
        state: name === "c-r1" ? "streaming" : "stopped",
        observedAt: AT,
        lagBytes: 4,
        receiptAgeSeconds: 0,
      });
    },
  });
  await sampler.poll();
  assertEquals(read.sort(), ["c-r1", "c-r2"]);
  assertEquals(tracker.lastStreaming("r1", 2_000), {
    at: AT,
    ageMs: 1_000,
    lagBytes: 4,
  });
  assertEquals(tracker.lastStreaming("r2", 2_000), undefined);
});

test("poll does nothing when the Postgres probe switch is off", async () => {
  const tracker = new StandbyStreamingTracker();
  let listed = false;
  const sampler = new PgStandbySampler({
    tracker,
    globallyEnabled: () => false,
    listMembers: () => {
      listed = true;
      return Promise.resolve([member("r1", "replica")]);
    },
    readStandby: () => Promise.reject(new Error("must not read")),
  });
  await sampler.poll();
  assertEquals(listed, false);
});

test("a failed read records nothing and never throws", async () => {
  const tracker = new StandbyStreamingTracker();
  const sampler = new PgStandbySampler({
    tracker,
    globallyEnabled: () => true,
    listMembers: () => Promise.resolve([member("r1", "replica")]),
    readStandby: () => Promise.reject(new Error("psql failed")),
  });
  await sampler.poll();
  assertEquals(tracker.lastStreaming("r1", 0), undefined);
});

test("a read past its deadline records nothing and is not doubled while it hangs", async () => {
  const tracker = new StandbyStreamingTracker();
  let reads = 0;
  let release: (() => void) | undefined;
  const sampler = new PgStandbySampler({
    tracker,
    timeoutMs: 10,
    globallyEnabled: () => true,
    listMembers: () => Promise.resolve([member("r1", "replica")]),
    readStandby: () => {
      reads += 1;
      return new Promise((resolve) => {
        release = () =>
          resolve({ state: "streaming", observedAt: AT, receiptAgeSeconds: 0 });
      });
    },
  });
  await sampler.poll(); // times out
  await sampler.poll(); // previous docker exec still running: skipped
  assertEquals(reads, 1);
  assertEquals(tracker.lastStreaming("r1", 0), undefined);
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await sampler.poll(); // the hung read ended: sampling resumes
  assertEquals(reads, 2);
  release?.();
});
