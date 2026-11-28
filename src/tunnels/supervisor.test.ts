import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "../testing/wait-for.ts";
import type { RunResult } from "../deploy/ensure-principal.ts";
import type { ConnectorIo } from "./connector-service.ts";
import {
  CONNECTOR_UPDATES_PAUSED_FILE,
  runConnectorUpdates,
  setTunnelsTestHooks,
  startTunnels,
  startUpdateLoop,
  writeInstanceTunnelToken,
} from "./supervisor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = "dGVzdA".repeat(8);

async function withTunnelsDir(
  fn: (dir: string, io: ConnectorIo, calls: string[]) => Promise<void>,
  opts: { ensureBinary?: () => Promise<string> } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tunnels-test-" });
  const calls: string[] = [];
  const io: ConnectorIo = {
    layout: { configDir: join(dir, "etc") },
    workDir: dir,
    version: "2026.11.2",
    ensureBinary: opts.ensureBinary ??
      (() =>
        Promise.resolve("/opt/turbopanel/vendor/cloudflared/x/cloudflared")),
    probe: () => Promise.resolve({ kind: "unreachable" }),
    run: (command, args): Promise<RunResult> => {
      calls.push([command, ...args].join(" "));
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  };
  setTunnelsTestHooks({ io });
  try {
    await fn(dir, io, calls);
  } finally {
    setTunnelsTestHooks(null);
    await Deno.remove(dir, { recursive: true });
  }
}

test("startTunnels returns at once and never throws", async () => {
  await withTunnelsDir(async () => {
    await startTunnels(new AbortController().signal);
  }, {
    ensureBinary: () => Promise.reject(new Error("download failed")),
  });
});

test("the instance token becomes the instance service and an empty one removes it", async () => {
  await withTunnelsDir(async (_dir, _io, calls) => {
    await writeInstanceTunnelToken(`  ${TOKEN} \n`);
    assert(
      calls.some((c) =>
        c.includes("enable turbopanel-tunnel-instance.service")
      ),
    );
    calls.length = 0;
    await writeInstanceTunnelToken("");
    assert(
      calls.some((c) =>
        c.includes("disable --now turbopanel-tunnel-instance.service")
      ),
    );
    assert(calls.some((c) => c.includes("tunnel-env-remove instance")));
  });
});

async function writeOldRecord(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, `${UUID}.json`),
    JSON.stringify({
      id: UUID,
      port: 20300,
      version: "2026.5.0",
      tokenDigest: "ab",
      slot: "a",
    }),
  );
}

test("a host with no tunnels is left alone by the update run, not even a download", async () => {
  await withTunnelsDir(async (_dir, io, calls) => {
    assertEquals(await runConnectorUpdates(io), []);
    assertEquals(calls, []);
  }, {
    ensureBinary: () => {
      throw new TypeError("the connector program must not be fetched");
    },
  });
});

test("the update run moves an older tunnel to the pinned version", async () => {
  await withTunnelsDir(async (dir, io, calls) => {
    await writeOldRecord(dir);
    io.probe = () => Promise.resolve({ kind: "ready", connections: 4 });
    io.portFree = () => Promise.resolve(true);
    io.unitExists = () => Promise.resolve(false);
    const run = io.run;
    io.run = (command, args) =>
      args.includes("is-active")
        ? Promise.resolve({ success: true, stdout: "active", stderr: "" })
        : run(command, args);
    io.sleep = () => Promise.resolve();
    const results = await runConnectorUpdates(io);
    assertEquals(results?.map((r) => [r.id, r.outcome.kind]), [
      [UUID, "updated"],
    ]);
    assert(calls.some((c) => c.includes(`start turbopanel-tunnel-${UUID}-b`)));
    // The metrics port lock is reloaded first, once per round.
    assert(calls[0].endsWith(" tunnel-loopback-sync"), calls.join("\n"));
    assertEquals(
      calls.filter((c) => c.endsWith(" tunnel-loopback-sync")).length,
      1,
    );
  });
});

test("a daemon start with a changed pin runs the whole rolling update in order", async () => {
  await withTunnelsDir(async (dir, io, calls) => {
    await writeOldRecord(dir);
    const steps: string[] = [];
    // The pinned program is downloaded and verified before any unit is made.
    io.ensureBinary = () => {
      steps.push("download-and-verify");
      return Promise.resolve(
        "/opt/turbopanel/vendor/cloudflared/2026.11.2/cloudflared",
      );
    };
    io.probe = () => {
      steps.push("ready");
      return Promise.resolve({ kind: "ready", connections: 4 });
    };
    io.portFree = () => Promise.resolve(true);
    io.unitExists = () => Promise.resolve(false);
    io.sleep = () => Promise.resolve();
    io.unitTexts = () => Promise.resolve([]);
    let prunedDone = false;
    io.pruneVersions = (keep) => {
      steps.push(`prune keep=${[...keep].join(",")}`);
      prunedDone = true;
      return Promise.resolve();
    };
    const run = io.run;
    io.run = (command, args) => {
      const text = [command, ...args].join(" ");
      if (text.includes("start turbopanel-tunnel-")) steps.push("start-new");
      if (text.includes("disable --now turbopanel-tunnel-")) {
        steps.push("stop-old");
      }
      return args.includes("is-active")
        ? Promise.resolve({ success: true, stdout: "active", stderr: "" })
        : run(command, args);
    };
    await startTunnels(new AbortController().signal);
    await waitFor("the old versions to be pruned", () => prunedDone, {
      timeoutMs: 60_000,
    });
    const order = ["download-and-verify", "start-new", "ready", "stop-old"];
    const seen = steps.filter((s) => order.includes(s));
    assertEquals([...new Set(seen)], order, steps.join("\n"));
    assertEquals(steps.at(-1), "prune keep=2026.11.2");
    assert(calls.some((c) => c.includes(`start turbopanel-tunnel-${UUID}-b`)));
    const record = JSON.parse(
      await Deno.readTextFile(join(dir, `${UUID}.json`)),
    );
    assertEquals([record.slot, record.version], ["b", "2026.11.2"]);
  });
});

test("a paused server keeps the connector versions it runs", async () => {
  await withTunnelsDir(async (dir, io, calls) => {
    await writeOldRecord(dir);
    await Deno.writeTextFile(join(dir, CONNECTOR_UPDATES_PAUSED_FILE), "");
    assertEquals(await runConnectorUpdates(io), null);
    // Only the metrics port lock is reloaded; no connector is touched.
    assertEquals(calls.length, 1, calls.join("\n"));
    assert(calls[0].endsWith(" tunnel-loopback-sync"), calls[0]);
  });
});

test("the update loop runs again later and never overlaps itself", async () => {
  let started = 0;
  let active = 0;
  let overlapped = false;
  const stop = startUpdateLoop(async () => {
    started++;
    active++;
    if (active > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 25));
    active--;
  }, 5);
  await new Promise((r) => setTimeout(r, 120));
  stop();
  const after = started;
  await new Promise((r) => setTimeout(r, 40));
  assert(after >= 2, `ran ${after} times`);
  assertEquals(overlapped, false);
  assertEquals(started, after);
});

test("a failing round does not stop the loop", async () => {
  let started = 0;
  const stop = startUpdateLoop(() => {
    started++;
    return Promise.reject(new Error("offline"));
  }, 5);
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert(started >= 2, `ran ${started} times`);
});
