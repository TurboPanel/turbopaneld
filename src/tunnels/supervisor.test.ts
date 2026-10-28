import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { RunResult } from "../deploy/ensure-principal.ts";
import type { ConnectorIo } from "./connector-service.ts";
import {
  CONNECTOR_UPDATES_PAUSED_FILE,
  migrateLegacyTokenFiles,
  runConnectorUpdates,
  setTunnelsTestHooks,
  startTunnels,
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
    version: "2026.5.2",
    ensureBinary: opts.ensureBinary ??
      (() =>
        Promise.resolve("/opt/turbopanel/vendor/cloudflared/x/cloudflared")),
    probe: () => Promise.resolve({ kind: "unreachable" }),
    run: (command, args): Promise<RunResult> => {
      calls.push([command, ...args].join(" "));
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  };
  setTunnelsTestHooks({ io, tunnelsDir: dir });
  try {
    await fn(dir, io, calls);
  } finally {
    setTunnelsTestHooks(null);
    await Deno.remove(dir, { recursive: true });
  }
}

test("a host that never had a token file does nothing, not even a download", async () => {
  await withTunnelsDir(async (_dir, io, calls) => {
    assertEquals(await migrateLegacyTokenFiles(io), []);
    assertEquals(calls, []);
  }, {
    ensureBinary: () => {
      throw new TypeError("the connector program must not be fetched");
    },
  });
});

test("a missing tunnels folder is not an error", async () => {
  await withTunnelsDir(async (dir, io) => {
    assertEquals(await migrateLegacyTokenFiles(io, join(dir, "missing")), []);
  });
});

test("legacy token files for the instance, the installer and a tunnel id become services", async () => {
  await withTunnelsDir(async (dir, io, calls) => {
    for (const name of ["instance", "default", UUID]) {
      await Deno.writeTextFile(join(dir, `${name}.token`), `${TOKEN}\n`);
    }
    const migrated = await migrateLegacyTokenFiles(io);
    assertEquals(migrated, ["default", "instance", UUID].sort());
    assert(
      calls.some((c) => c.includes(`enable turbopanel-tunnel-${UUID}.service`)),
    );
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) =>
      n.endsWith(".token")
    );
    assertEquals(left, []);
    assert(calls.every((c) => !c.includes(TOKEN)));
  });
});

test("a file not named for a tunnel id, an empty one and a bad one stay where they are", async () => {
  await withTunnelsDir(async (dir, io, calls) => {
    await Deno.writeTextFile(join(dir, "my tunnel.token"), TOKEN);
    await Deno.writeTextFile(join(dir, "..token"), TOKEN);
    await Deno.writeTextFile(join(dir, "instance.token"), "  \n");
    await Deno.writeTextFile(
      join(dir, `${UUID}.token`),
      "has space and 'quote",
    );
    await Deno.writeTextFile(join(dir, "notes.txt"), "x");
    assertEquals(await migrateLegacyTokenFiles(io), []);
    assertEquals(calls, []);
    assertEquals([...Deno.readDirSync(dir)].length, 5);
  });
});

test("a file whose service cannot be installed stays for the next start, the others migrate", async () => {
  await withTunnelsDir(async (dir, io) => {
    await Deno.writeTextFile(join(dir, "default.token"), TOKEN);
    await Deno.writeTextFile(join(dir, "instance.token"), TOKEN);
    const run = io.run;
    io.run = (command, args) =>
      args.includes("default")
        ? Promise.resolve({ success: false, stdout: "", stderr: "no" })
        : run(command, args);
    // `tunnel-env-install default` is refused; instance is fine.
    const migrated = await migrateLegacyTokenFiles(io);
    assertEquals(migrated, ["instance"]);
    assertEquals(
      (await Deno.stat(join(dir, "default.token"))).isFile,
      true,
    );
  });
});

test("startTunnels returns at once and never throws", async () => {
  await withTunnelsDir(async () => {
    await startTunnels(new AbortController().signal);
  }, {
    ensureBinary: () => Promise.reject(new Error("download failed")),
  });
});

test("the instance token becomes the instance service and an empty one removes it", async () => {
  await withTunnelsDir(async (dir, _io, calls) => {
    await Deno.writeTextFile(join(dir, "instance.token"), TOKEN);
    await writeInstanceTunnelToken(`  ${TOKEN} \n`);
    assert(
      calls.some((c) =>
        c.includes("enable turbopanel-tunnel-instance.service")
      ),
    );
    // The old file must not be migrated back on the next start.
    assertEquals(
      await Deno.stat(join(dir, "instance.token")).catch(() => null),
      null,
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

test("a file whose service fails to start stays in place for the next start", async () => {
  await withTunnelsDir(async (dir, io) => {
    await Deno.writeTextFile(join(dir, "instance.token"), TOKEN);
    const run = io.run;
    io.run = (command, args) =>
      args.includes("restart")
        ? Promise.resolve({ success: false, stdout: "", stderr: "no" })
        : run(command, args);
    assertEquals(await migrateLegacyTokenFiles(io), []);
    assertEquals((await Deno.stat(join(dir, "instance.token"))).isFile, true);
  });
});

test("a stale file never overwrites a service that already exists", async () => {
  await withTunnelsDir(async (dir, io, calls) => {
    await writeInstanceTunnelToken(TOKEN);
    await Deno.writeTextFile(join(dir, "instance.token"), `${TOKEN}AA`);
    calls.length = 0;
    assertEquals(await migrateLegacyTokenFiles(io), []);
    assertEquals(calls, []);
    assertEquals(
      await Deno.stat(join(dir, "instance.token")).catch(() => null),
      null,
    );
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
    io.unitExists = () => Promise.resolve(false);
    io.sleep = () => Promise.resolve();
    const results = await runConnectorUpdates(io);
    assertEquals(results?.map((r) => [r.id, r.outcome.kind]), [
      [UUID, "updated"],
    ]);
    assert(calls.some((c) => c.includes(`start turbopanel-tunnel-${UUID}-b`)));
  });
});

test("a paused server keeps the connector versions it runs", async () => {
  await withTunnelsDir(async (dir, io, calls) => {
    await writeOldRecord(dir);
    await Deno.writeTextFile(join(dir, CONNECTOR_UPDATES_PAUSED_FILE), "");
    assertEquals(await runConnectorUpdates(io), null);
    assertEquals(calls, []);
  });
});
