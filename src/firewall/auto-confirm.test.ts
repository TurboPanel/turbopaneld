import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { FIREWALL_V4_FILENAME } from "./apply.ts";
import { autoConfirmFirewall } from "./auto-confirm.ts";
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

const FAST = { settleMs: 0, timeoutMs: 50, now: () => NOW };

test("auto-confirm: the check passes, the daemon confirms itself and the rollback timer is stopped", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    let checks = 0;
    const result = await autoConfirmFirewall(DIGEST, {
      ...FAST,
      run: host.run,
      layout,
      verifyControlPlane: () => {
        checks++;
        return Promise.resolve();
      },
    });
    assertEquals(result.confirmed, true);
    assertEquals(checks, 1);
    assertEquals(await readPendingMarker(layout), null);
    assert(host.calls.includes(`systemctl stop ${FIREWALL_GUARD_TIMER}`));
    assertEquals(
      await Deno.readTextFile(join(layout.configDir, FIREWALL_V4_FILENAME)),
      "pending v4\n",
    );
  });
});

test("auto-confirm: the check fails, nothing is confirmed and the guard stays armed", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    const result = await autoConfirmFirewall(DIGEST, {
      ...FAST,
      run: host.run,
      layout,
      verifyControlPlane: () => Promise.reject(new Error("HTTP 503")),
    });
    assertEquals(result.confirmed, false);
    assert(result.reason.includes("HTTP 503"));
    assertEquals((await readPendingMarker(layout))?.digest, DIGEST);
    assertEquals(host.calls, [], "no systemctl stop: the timer keeps running");
    assertEquals(
      await Deno.stat(join(layout.configDir, FIREWALL_V4_FILENAME)).catch(() =>
        null
      ),
      null,
      "nothing was made durable",
    );
  });
});

test("auto-confirm: a control plane that never answers times out and confirms nothing", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    const result = await autoConfirmFirewall(DIGEST, {
      ...FAST,
      run: host.run,
      layout,
      verifyControlPlane: () => new Promise<void>(() => {}),
    });
    assertEquals(result.confirmed, false);
    assert(result.reason.includes("no answer within"));
    assertEquals((await readPendingMarker(layout))?.digest, DIGEST);
    assertEquals(host.calls, []);
  });
});

test("auto-confirm: no control-plane client means no check and no confirm", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    const result = await autoConfirmFirewall(DIGEST, {
      ...FAST,
      run: host.run,
      layout,
    });
    assertEquals(result.confirmed, false);
    assertEquals((await readPendingMarker(layout))?.digest, DIGEST);
    assertEquals(host.calls, []);
  });
});

test("auto-confirm: a second confirm, by the daemon or by the command, is a harmless nothing_pending", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    const options = {
      ...FAST,
      run: host.run,
      layout,
      verifyControlPlane: () => Promise.resolve(),
    };
    assertEquals((await autoConfirmFirewall(DIGEST, options)).confirmed, true);
    const again = await autoConfirmFirewall(DIGEST, options);
    assertEquals(again.confirmed, false);
    assert(again.reason.includes("nothing_pending"));
    const manual = await confirmPendingFirewall(DIGEST, {
      run: host.run,
      layout,
      now: () => NOW,
    });
    assertEquals(manual.state, "nothing_pending");
  });
});

test("auto-confirm: rollback still fires - after a failed check the confirm window ends in expired and the guard is started", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    const host = recordingRun();
    await autoConfirmFirewall(DIGEST, {
      ...FAST,
      run: host.run,
      layout,
      verifyControlPlane: () => Promise.reject(new Error("unreachable")),
    });
    // The deadline passes with the marker untouched: a late confirm is refused
    // and the guard service is started rather than promoting the ruleset.
    const late = await autoConfirmFirewall(DIGEST, {
      ...FAST,
      now: () => new Date("2026-10-01T12:02:01.000Z"),
      run: host.run,
      layout,
      verifyControlPlane: () => Promise.resolve(),
    });
    assertEquals(late.confirmed, false);
    assert(late.reason.includes("expired"));
    assert(
      host.calls.includes(
        `systemctl start --no-block ${FIREWALL_GUARD_SERVICE}`,
      ),
    );
    // Once the guard has rolled back, the record says so and a confirm reports it.
    const record: FirewallRollbackRecord = {
      digest: DIGEST,
      at: "2026-10-01T12:02:02.000Z",
      restored: "none",
    };
    await Deno.remove(pendingMarkerPath(layout));
    await Deno.writeTextFile(
      rollbackRecordPath(layout),
      JSON.stringify(record),
    );
    const after = await confirmPendingFirewall(DIGEST, {
      run: host.run,
      layout,
      now: () => NOW,
    });
    assertEquals(after.state, "rolled_back");
  });
});

test("a confirmed ruleset clears an earlier rollback record", async () => {
  await withLayout(async (layout) => {
    await stage(layout);
    await Deno.writeTextFile(
      rollbackRecordPath(layout),
      JSON.stringify({
        digest: "b".repeat(64),
        at: "2026-10-01T11:00:00.000Z",
        restored: "none",
      }),
    );
    await confirmPendingFirewall(DIGEST, {
      run: recordingRun().run,
      layout,
      now: () => NOW,
    });
    assertEquals(
      await Deno.stat(rollbackRecordPath(layout)).catch(() => null),
      null,
    );
  });
});
