import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { FIREWALL_V4_FILENAME, FIREWALL_V6_FILENAME } from "./apply.ts";
import { confirmPendingFirewall } from "./confirm.ts";
import {
  FIREWALL_GUARD_SERVICE,
  FIREWALL_GUARD_TIMER,
  FIREWALL_PENDING_V4_FILENAME,
  FIREWALL_PENDING_V6_FILENAME,
  type FirewallRollbackRecord,
  type PendingFirewallMarker,
  pendingMarkerPath,
  readPendingMarker,
  rollbackRecordPath,
} from "./pending.ts";
import type { FirewallRunFn } from "./run.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);
const NOW = new Date("2026-10-01T12:00:30.000Z");

function recordingRun(): { run: FirewallRunFn; calls: string[] } {
  const calls: string[] = [];
  const run: FirewallRunFn = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
  };
  return { run, calls };
}

type Layout = ReturnType<typeof resolveLayout>;

async function withLayout<T>(fn: (layout: Layout) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-fwc-" });
  try {
    const layout = resolveLayout({
      TURBOPANEL_CONFIG_DIR: join(root, "etc"),
      TURBOPANEL_STATE_DIR: join(root, "state"),
      TURBOPANEL_DAEMON_STATE_DIR: join(root, "state"),
      TURBOPANEL_RUN_DIR: join(root, "run"),
    });
    await Deno.mkdir(layout.configDir, { recursive: true });
    await Deno.mkdir(layout.stateDir, { recursive: true });
    await Deno.mkdir(layout.runDir, { recursive: true });
    return await fn(layout);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function stage(
  layout: Layout,
  overrides: Partial<PendingFirewallMarker> = {},
  documents: { v4?: string; v6?: string } = { v4: "pending v4\n" },
): Promise<void> {
  const marker: PendingFirewallMarker = {
    version: 1,
    digest: DIGEST,
    generation: 7,
    armedAt: "2026-10-01T12:00:00.000Z",
    deadlineAt: "2026-10-01T12:02:00.000Z",
    windowSeconds: 120,
    v6: "keep",
    ...overrides,
  };
  await Deno.writeTextFile(pendingMarkerPath(layout), JSON.stringify(marker));
  if (documents.v4 !== undefined) {
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_PENDING_V4_FILENAME),
      documents.v4,
    );
  }
  if (documents.v6 !== undefined) {
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_PENDING_V6_FILENAME),
      documents.v6,
    );
  }
}

const read = (layout: Layout, name: string) =>
  Deno.readTextFile(join(layout.configDir, name));

test("confirm promotes the pending v4 document, clears the stage and stops the guard", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_V6_FILENAME),
      "old v6\n",
    );
    const host = recordingRun();
    const outcome = await confirmPendingFirewall(DIGEST, {
      run: host.run,
      layout,
      now: () => NOW,
    });
    assertEquals(outcome.state, "confirmed");
    assertEquals(outcome.digest, DIGEST);
    assertEquals(await read(layout, FIREWALL_V4_FILENAME), "pending v4\n");
    assertEquals(
      await read(layout, FIREWALL_V6_FILENAME),
      "old v6\n",
      "v6 intent `keep` leaves the durable v6 document alone",
    );
    assertEquals(await readPendingMarker(layout), null);
    await assertRejects(
      () => read(layout, FIREWALL_PENDING_V4_FILENAME),
      Deno.errors.NotFound,
    );
    assertEquals(host.calls, [`systemctl stop ${FIREWALL_GUARD_TIMER}`]);
  });
});

test("confirm applies the recorded IPv6 intent: replace writes it, forget removes it", async () => {
  await withLayout(async (layout) => {
    await stage(layout, { v6: "replace" }, { v4: "v4\n", v6: "new v6\n" });
    await confirmPendingFirewall(DIGEST, {
      run: recordingRun().run,
      layout,
      now: () => NOW,
    });
    assertEquals(await read(layout, FIREWALL_V6_FILENAME), "new v6\n");

    await stage(layout, { v6: "forget" }, { v4: "v4 again\n" });
    await confirmPendingFirewall(DIGEST, {
      run: recordingRun().run,
      layout,
      now: () => NOW,
    });
    assertEquals(await read(layout, FIREWALL_V4_FILENAME), "v4 again\n");
    await assertRejects(
      () => read(layout, FIREWALL_V6_FILENAME),
      Deno.errors.NotFound,
    );
  });
});

test("a second confirm is idempotent: nothing is pending", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const options = { run: recordingRun().run, layout, now: () => NOW };
    assertEquals(
      (await confirmPendingFirewall(DIGEST, options)).state,
      "confirmed",
    );
    const again = await confirmPendingFirewall(DIGEST, options);
    assertEquals(again.state, "nothing_pending");
    assertEquals(await read(layout, FIREWALL_V4_FILENAME), "pending v4\n");
  });
});

test("a different digest is refused and leaves the pending ruleset (and its guard) alone", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    const outcome = await confirmPendingFirewall(OTHER, {
      run: host.run,
      layout,
      now: () => NOW,
    });
    assertEquals(outcome.state, "digest_mismatch");
    assertEquals(outcome.pendingDigest, DIGEST);
    assertEquals((await readPendingMarker(layout))?.digest, DIGEST);
    assertEquals(host.calls, []);
    await assertRejects(
      () => read(layout, FIREWALL_V4_FILENAME),
      Deno.errors.NotFound,
    );
  });
});

test("a confirm after the deadline is never honoured and asks the guard to roll back now", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    const outcome = await confirmPendingFirewall(DIGEST, {
      run: host.run,
      layout,
      now: () => new Date("2026-10-01T12:02:00.000Z"),
    });
    assertEquals(outcome.state, "expired");
    assertEquals(host.calls, [
      `systemctl start --no-block ${FIREWALL_GUARD_SERVICE}`,
    ]);
    await assertRejects(
      () => read(layout, FIREWALL_V4_FILENAME),
      Deno.errors.NotFound,
    );
    assert(
      (await readPendingMarker(layout)) !== null,
      "the marker is the guard's to remove, not the confirm's",
    );
  });
});

test("after the guard rolled the ruleset back, a late confirm says so", async () => {
  await withLayout(async (layout) => {
    const record: FirewallRollbackRecord = {
      digest: DIGEST,
      at: "2026-10-01T12:02:05Z",
      restored: "durable",
    };
    await Deno.writeTextFile(
      rollbackRecordPath(layout),
      JSON.stringify(record),
    );
    const late = await confirmPendingFirewall(DIGEST, {
      run: recordingRun().run,
      layout,
      now: () => NOW,
    });
    assertEquals(late.state, "rolled_back");
    const other = await confirmPendingFirewall(OTHER, {
      run: recordingRun().run,
      layout,
      now: () => NOW,
    });
    assertEquals(
      other.state,
      "nothing_pending",
      "a rollback of another ruleset is not this one's story",
    );
  });
});

test("missing pending documents throw and leave everything for the guard to roll back", async () => {
  await withLayout(async (layout) => {
    await stage(layout, {}, {});
    await assertRejects(
      () =>
        confirmPendingFirewall(DIGEST, {
          run: recordingRun().run,
          layout,
          now: () => NOW,
        }),
      Error,
      "pending IPv4 document is missing",
    );
    assert((await readPendingMarker(layout)) !== null);
    await assertRejects(
      () => read(layout, FIREWALL_V4_FILENAME),
      Deno.errors.NotFound,
    );

    await stage(layout, { v6: "replace" }, { v4: "v4\n" });
    await assertRejects(
      () =>
        confirmPendingFirewall(DIGEST, {
          run: recordingRun().run,
          layout,
          now: () => NOW,
        }),
      Error,
      "pending IPv6 document is missing",
    );
  });
});

test("a corrupt marker is treated as nothing pending", async () => {
  await withLayout(async (layout) => {
    await Deno.writeTextFile(pendingMarkerPath(layout), "{not json");
    const outcome = await confirmPendingFirewall(DIGEST, {
      run: recordingRun().run,
      layout,
      now: () => NOW,
    });
    assertEquals(outcome.state, "nothing_pending");
  });
});
