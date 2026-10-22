import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type {
  ManagedApplyPayload,
  ManagedLifecyclePayload,
} from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { managedDir } from "./engine-paths.ts";
import {
  clearManagedDemotionArtifacts,
  writeManagedDemotedMarker,
} from "./demoted-marker.ts";
import {
  assertSwitchoverReseedAllowed,
  captureFinalPositionAfterStop,
  clearSwitchoverFinalPositionRecord,
  readSwitchoverFinalPositionRecord,
  writeSwitchoverFinalPositionRecord,
} from "./switchover-final-position.ts";

const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const TARGET_ID = "00000000-0000-4000-8000-0000000000b2";
const RECOVERY_ID = "00000000-0000-4000-8000-0000000000c3";
const OTHER_RECOVERY_ID = "00000000-0000-4000-8000-0000000000c4";

const COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:18",
  "    volumes:",
  "      - pg_data:/var/lib/postgresql",
  "volumes:",
  "  pg_data:",
  "    name: pg_data",
  "",
].join("\n");

const CONTROL_DATA = [
  "Database cluster state:               shut down",
  "Latest checkpoint location:           0/7257FC0",
  "Latest checkpoint's REDO location:    0/7257FC0",
  "Latest checkpoint's TimeLineID:       1",
  "Database block size:                  8192",
  "Bytes per WAL segment:                16777216",
].join("\n");
const WALDUMP =
  "rmgr: XLOG        len (rec/tot):    114/   114, tx:          0, lsn: 0/07257FC0, prev 0/07257F98, desc: CHECKPOINT_SHUTDOWN redo 0/7257FC0; tli 1";

function stopPayload(
  extra: Partial<ManagedLifecyclePayload> = {},
): ManagedLifecyclePayload {
  return {
    managedId: MANAGED_ID,
    action: "stop",
    engine: "postgres",
    switchoverRecoveryId: RECOVERY_ID,
    primaryEpoch: 4,
    ...extra,
  };
}

function docker(stdout: string, success = true) {
  const calls: string[][] = [];
  const run = (argv: string[]): Promise<DockerCliResult> => {
    calls.push(argv);
    return Promise.resolve({
      success,
      stdout,
      stderr: "",
      code: success ? 0 : 1,
    });
  };
  return { run, calls };
}

async function withLayout(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<void>,
): Promise<void> {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const root = managedDir(layout, MANAGED_ID);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(join(root, "docker-compose.yml"), COMPOSE);
    await fn(layout);
  });
}

function reseedPayload(
  extra: Partial<ManagedApplyPayload> = {},
): ManagedApplyPayload {
  return {
    managedId: MANAGED_ID,
    memberId: MEMBER_ID,
    forceResync: true,
    switchoverReseed: {
      recoveryId: RECOVERY_ID,
      sourceMemberId: MEMBER_ID,
      targetMemberId: TARGET_ID,
      epoch: 5,
    },
    ...extra,
  } as ManagedApplyPayload;
}

async function recordStop(layout: ReturnType<typeof resolveLayout>) {
  await writeSwitchoverFinalPositionRecord(layout, MANAGED_ID, {
    recoveryId: RECOVERY_ID,
    epoch: 4,
    lsn: "0/7258050",
    timeline: 1,
    recordedAt: "2026-10-22T00:00:00.000Z",
  });
  await writeManagedDemotedMarker(
    layout,
    MANAGED_ID,
    MEMBER_ID,
    "2026-10-22T00:00:00.000Z",
    "postgres",
  );
}

test("a clean stop reports the final position and records which switchover it was for", async () => {
  await withLayout(async (layout) => {
    const fake = docker(`${CONTROL_DATA}\n@@@\n${WALDUMP}\n`);
    const report = await captureFinalPositionAfterStop(
      stopPayload(),
      layout,
      fake.run,
      () => "2026-10-22T00:00:00.000Z",
    );
    assertEquals(report, {
      oldPrimaryFinalLsn: "0/7258050",
      oldPrimaryFinalTimeline: 1,
    });
    assertEquals(await readSwitchoverFinalPositionRecord(layout, MANAGED_ID), {
      recoveryId: RECOVERY_ID,
      epoch: 4,
      lsn: "0/7258050",
      timeline: 1,
      recordedAt: "2026-10-22T00:00:00.000Z",
    });
    assertEquals(fake.calls.length, 1);
    assert(fake.calls[0].includes("pg_data:/var/lib/postgresql"));
    assert(fake.calls[0].includes("LC_ALL=C"));
  });
});

test("nothing is reported without the switchover fields, for a start, or for another engine", async () => {
  await withLayout(async (layout) => {
    const fake = docker(`${CONTROL_DATA}\n@@@\n${WALDUMP}\n`);
    const plain = { managedId: MANAGED_ID, action: "stop" } as const;
    assertEquals(
      await captureFinalPositionAfterStop(plain, layout, fake.run),
      undefined,
    );
    assertEquals(
      await captureFinalPositionAfterStop(
        stopPayload({ action: "start" }),
        layout,
        fake.run,
      ),
      undefined,
    );
    assertEquals(
      await captureFinalPositionAfterStop(
        stopPayload({ engine: "mysql" }),
        layout,
        fake.run,
      ),
      undefined,
    );
    assertEquals(fake.calls.length, 0);
    assertEquals(
      await readSwitchoverFinalPositionRecord(layout, MANAGED_ID),
      null,
    );
  });
});

test("an unclean engine, a failed read or a missing compose file reports nothing and never throws", async () => {
  await withLayout(async (layout) => {
    const unclean = docker(
      `${
        CONTROL_DATA.replace("shut down", "in production")
      }\n@@@\n${WALDUMP}\n`,
    );
    assertEquals(
      await captureFinalPositionAfterStop(stopPayload(), layout, unclean.run),
      undefined,
    );
    const failed = docker("", false);
    assertEquals(
      await captureFinalPositionAfterStop(stopPayload(), layout, failed.run),
      undefined,
    );
    assertEquals(
      await readSwitchoverFinalPositionRecord(layout, MANAGED_ID),
      null,
    );
    await Deno.remove(
      join(managedDir(layout, MANAGED_ID), "docker-compose.yml"),
    );
    assertEquals(
      await captureFinalPositionAfterStop(stopPayload(), layout, failed.run),
      undefined,
    );
  });
});

test("the re-seed of the fenced switchover primary is allowed", async () => {
  await withLayout(async (layout) => {
    await recordStop(layout);
    await assertSwitchoverReseedAllowed(layout, reseedPayload());
  });
});

test("a re-seed from another switchover is refused before anything is touched", async () => {
  await withLayout(async (layout) => {
    await recordStop(layout);
    const payload = reseedPayload();
    payload.switchoverReseed!.recoveryId = OTHER_RECOVERY_ID;
    await assertRejects(
      () => assertSwitchoverReseedAllowed(layout, payload),
      Error,
      "stale recovery",
    );
  });
});

test("a re-seed queued for an older or newer primary epoch is refused", async () => {
  await withLayout(async (layout) => {
    await recordStop(layout);
    for (const epoch of [4, 6, 0]) {
      const payload = reseedPayload();
      payload.switchoverReseed!.epoch = epoch;
      await assertRejects(
        () => assertSwitchoverReseedAllowed(layout, payload),
        Error,
        "stale epoch",
      );
    }
  });
});

test("a re-seed with no record, for another member, or after the member stopped being fenced is refused", async () => {
  await withLayout(async (layout) => {
    await assertRejects(
      () => assertSwitchoverReseedAllowed(layout, reseedPayload()),
      Error,
      "no final position",
    );
    await recordStop(layout);
    await assertRejects(
      () =>
        assertSwitchoverReseedAllowed(
          layout,
          reseedPayload({ memberId: TARGET_ID }),
        ),
      Error,
      "another member",
    );
    await clearManagedDemotionArtifacts(layout, MANAGED_ID, {
      engine: "postgres",
      run: () =>
        Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
    });
    await assertRejects(
      () => assertSwitchoverReseedAllowed(layout, reseedPayload()),
      Error,
      "no longer a fenced",
    );
  });
});

test("an operator Resync without the guard is never checked", async () => {
  await withLayout(async (layout) => {
    const operator = reseedPayload();
    delete operator.switchoverReseed;
    await assertSwitchoverReseedAllowed(layout, operator);
    await assertSwitchoverReseedAllowed(
      layout,
      reseedPayload({ forceResync: false }),
    );
  });
});

test("the record can be cleared and clearing twice is harmless", async () => {
  await withLayout(async (layout) => {
    await recordStop(layout);
    await clearSwitchoverFinalPositionRecord(layout, MANAGED_ID);
    await clearSwitchoverFinalPositionRecord(layout, MANAGED_ID);
    assertEquals(
      await readSwitchoverFinalPositionRecord(layout, MANAGED_ID),
      null,
    );
  });
});
