import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { managedDir } from "./engine-paths.ts";
import {
  captureSwitchoverGtidBeforeStop,
  reactivatePrimaryAfterSwitchoverAbort,
} from "./lifecycle-switchover.ts";
import { readSwitchoverQuiescedMarker } from "./switchover-state-marker.ts";
import { switchoverPromoteErrorMessage } from "./engines/switchover-promote-error.ts";

const test = Deno.test.bind(Deno);

const RUNNING_MARIADB_PS = JSON.stringify([
  {
    ID: "maria1",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "mariadb",
    State: "running",
  },
]);

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

test("captureSwitchoverGtidBeforeStop is a no-op without captureSwitchoverGtid", async () => {
  const out = await captureSwitchoverGtidBeforeStop(
    { managedId: "abc", action: "stop" },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
  assertEquals(out, undefined);
});

test("reactivatePrimaryAfterSwitchoverAbort is a no-op without the abort flag", async () => {
  await reactivatePrimaryAfterSwitchoverAbort(
    { managedId: "abc", action: "start" },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
});

test("captureSwitchoverGtidBeforeStop is a no-op for start even with captureSwitchoverGtid", async () => {
  const out = await captureSwitchoverGtidBeforeStop(
    {
      managedId: "abc",
      action: "start",
      captureSwitchoverGtid: true,
    },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
  assertEquals(out, undefined);
});

test("captureSwitchoverGtidBeforeStop rejects engines without quiesce support", async () => {
  await assertRejects(
    () =>
      captureSwitchoverGtidBeforeStop(
        {
          managedId: "managed_switchover_pg",
          action: "stop",
          captureSwitchoverGtid: true,
          engine: "postgres",
        },
        (args) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(
              dockerOk(
                JSON.stringify([
                  {
                    ID: "pg1",
                    Name: "pg-1",
                    Service: "postgres",
                    State: "running",
                  },
                ]),
              ),
            );
          }
          return Promise.resolve(dockerOk());
        },
        { ensureDocker: () => Promise.resolve() },
      ),
    Error,
    "captureSwitchoverGtid is not supported",
  );
});

test("reactivatePrimaryAfterSwitchoverAbort refuses without abort-safe confirmation", async () => {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      const managedId = `managed_switchover_abort_${crypto.randomUUID()}`;
      const layout = {
        stateDir: fixture.dirs.stateDir,
      } as Parameters<typeof managedDir>[0];
      await Deno.mkdir(managedDir(layout, managedId), { recursive: true });
      await assertRejects(
        () =>
          reactivatePrimaryAfterSwitchoverAbort(
            {
              managedId,
              action: "start",
              reactivateAfterSwitchoverAbort: true,
              engine: "mariadb",
            },
            () => Promise.resolve(dockerOk()),
            { ensureDocker: () => Promise.resolve() },
          ),
        Error,
        "control plane did not confirm",
      );
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

test("reactivatePrimaryAfterSwitchoverAbort refuses after target promote_started", async () => {
  await assertRejects(
    () =>
      reactivatePrimaryAfterSwitchoverAbort(
        {
          managedId: "managed_switchover_maria",
          action: "start",
          reactivateAfterSwitchoverAbort: true,
          engine: "mariadb",
          switchoverAbortPromoteSafe: true,
          switchoverTargetPromoteError: switchoverPromoteErrorMessage(
            "promote_started",
            "writable check failed",
          ),
        },
        () => Promise.resolve(dockerOk()),
        { ensureDocker: () => Promise.resolve() },
      ),
    Error,
    "target promotion already started",
  );
});

test("reactivatePrimaryAfterSwitchoverAbort clears read_only on mariadb", async () => {
  let clearedReadOnly = false;
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      const managedId = `managed_switchover_maria_${crypto.randomUUID()}`;
      const layout = {
        stateDir: fixture.dirs.stateDir,
      } as Parameters<typeof managedDir>[0];
      const root = managedDir(layout, managedId);
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        `${root}/switchover-quiesced.json`,
        `${
          JSON.stringify({
            primaryExecutedGtidSet: "0-1-9",
            quiescedAt: "2026-01-01T00:00:00.000Z",
          })
        }\n`,
      );
      await reactivatePrimaryAfterSwitchoverAbort(
        {
          managedId,
          action: "start",
          reactivateAfterSwitchoverAbort: true,
          engine: "mariadb",
          switchoverAbortPromoteSafe: true,
        },
        (args, options) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk(RUNNING_MARIADB_PS));
          }
          if (args[0] === "exec") {
            const eIndex = args.indexOf("-e");
            const sql = eIndex >= 0 ? String(args[eIndex + 1] ?? "") : "";
            const batch = String(options?.input ?? "");
            if (
              batch.includes("read_only") && batch.includes("OFF")
            ) {
              clearedReadOnly = true;
            }
            if (sql.includes("@@GLOBAL.read_only")) {
              return Promise.resolve(dockerOk("1\n"));
            }
            if (sql.includes("SHOW REPLICA STATUS")) {
              return Promise.resolve(dockerOk(""));
            }
            if (args.includes("mariadb-admin")) {
              return Promise.resolve(dockerOk());
            }
            return Promise.resolve(dockerOk());
          }
          return Promise.resolve(dockerOk());
        },
        { ensureDocker: () => Promise.resolve() },
      );
      assertEquals(clearedReadOnly, true);
      assertEquals(
        await readSwitchoverQuiescedMarker(layout, managedId),
        null,
      );
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

type SwitchoverAbortDockerFlags = {
  onRemovedStandbySignal: () => void;
  reactivateBatch: boolean;
};

function postgresSwitchoverAbortDocker(
  flags: SwitchoverAbortDockerFlags,
): (
  args: string[],
  options?: { input?: string },
) => Promise<DockerCliResult> {
  return (args, options) => {
    if (args[0] === "compose" && args.includes("ps")) {
      return Promise.resolve(
        dockerOk(
          JSON.stringify([
            {
              ID: "pg1",
              Name: "pg-1",
              Service: "postgres",
              State: "running",
            },
          ]),
        ),
      );
    }
    if (args[0] === "run") {
      const script = args.at(-1) ?? "";
      if (script.includes("rm -f") && script.includes("standby.signal")) {
        flags.onRemovedStandbySignal();
      }
      return Promise.resolve(dockerOk("present\n"));
    }
    if (args[0] === "exec") {
      const batch = String(options?.input ?? "");
      if (batch.includes("pg_promote")) {
        flags.reactivateBatch = true;
        return Promise.resolve(dockerOk(""));
      }
      if (batch.includes("pg_is_in_recovery") || batch.includes("NOT pg")) {
        return Promise.resolve(dockerOk(flags.reactivateBatch ? "t\n" : "f\n"));
      }
      return Promise.resolve(dockerOk(""));
    }
    return Promise.resolve(dockerOk());
  };
}

const POSTGRES_COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:18",
  "    volumes:",
  "      - sw_data:/var/lib/postgresql",
  "volumes:",
  "  sw_data:",
  "    name: sw_data",
  "",
].join("\n");

test("reactivatePrimaryAfterSwitchoverAbort clears postgres standby.signal and promotes", async () => {
  let removedSignal = false;
  const flags: SwitchoverAbortDockerFlags = {
    onRemovedStandbySignal: () => {
      removedSignal = true;
    },
    reactivateBatch: false,
  };
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      const managedId = `managed_switchover_pg_${crypto.randomUUID()}`;
      const layout = {
        stateDir: fixture.dirs.stateDir,
      } as Parameters<typeof managedDir>[0];
      const root = managedDir(layout, managedId);
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(`${root}/docker-compose.yml`, POSTGRES_COMPOSE);
      await reactivatePrimaryAfterSwitchoverAbort(
        {
          managedId,
          action: "start",
          reactivateAfterSwitchoverAbort: true,
          engine: "postgres",
          switchoverAbortPromoteSafe: true,
        },
        postgresSwitchoverAbortDocker(flags),
        { ensureDocker: () => Promise.resolve() },
      );
      assertEquals(removedSignal, true);
      assertEquals(flags.reactivateBatch, true);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});
