import { assertEquals } from "@std/assert";
import { withTempLayout } from "../testing/temp-layout.ts";
import { commandLogSpoolDir } from "../paths/layout.ts";
import { sweepOrphanCommandLogs } from "./orphan-sweep.ts";
import { createCommandOutputSink } from "./sink.ts";
import { commandLogSpoolPath } from "./spool.ts";
import { DaemonApiClient } from "../instance/api-client.ts";
import {
  commandLogChunkResponse,
  createFakeInstanceApi,
  decodeCommandLogChunkBody,
  type DecodedCommandLogChunk,
} from "../testing/fake-instance-api.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function writeSpoolFile(
  dir: string,
  commandId: string,
  sequence: number,
): Promise<string> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${commandId}.log`;
  await Deno.writeTextFile(
    path,
    `${
      JSON.stringify({
        commandId,
        sequence,
        timestamp: "2026-08-21T00:00:00.000Z",
        stream: "stdout",
        phase: "compose-up",
        message: "leftover line",
      })
    }\n`,
  );
  return path;
}

test("sweep re-uploads a leftover spool file and deletes it", async () => {
  await withTempLayout(async (fixture) => {
    const dir = commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir });
    const path = await writeSpoolFile(dir, "cmd-orphan", 7);
    const sent: Array<{ commandId: string; seq: number }> = [];

    const result = await sweepOrphanCommandLogs({
      layout: { daemonStateDir: fixture.dirs.stateDir },
      send: (params) => {
        sent.push({ commandId: params.commandId, seq: params.seq });
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });

    assertEquals(result, { uploaded: 1, failed: 0, skipped: 0 });
    // A whole-file replay is always chunk 0: below the control plane's
    // nextSeq it is an idempotent no-op, above it would be a rejected gap.
    assertEquals(sent, [{ commandId: "cmd-orphan", seq: 0 }]);
    assertEquals(await Deno.stat(path).catch(() => null), null);
  });
});

test("sweep keeps the file when the upload fails", async () => {
  await withTempLayout(async (fixture) => {
    const dir = commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir });
    const path = await writeSpoolFile(dir, "cmd-keep", 1);
    const result = await sweepOrphanCommandLogs({
      layout: { daemonStateDir: fixture.dirs.stateDir },
      send: () => Promise.reject(new Error("offline")),
    });
    assertEquals(result.failed, 1);
    assertEquals((await Deno.stat(path)).isFile, true);
  });
});

test("sweep is a no-op when the spool dir does not exist", async () => {
  await withTempLayout(async (fixture) => {
    const result = await sweepOrphanCommandLogs({
      layout: { daemonStateDir: `${fixture.dirs.stateDir}/missing` },
      send: () => Promise.reject(new Error("must not be called")),
    });
    assertEquals(result, { uploaded: 0, failed: 0, skipped: 0 });
  });
});

test("sweep uploads through DaemonApiClient.sendCommandLogChunk", async () => {
  await withTempLayout(async (fixture) => {
    const dir = commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir });
    const spoolPath = await writeSpoolFile(dir, "cmd-api", 3);
    const spooled = await Deno.readTextFile(spoolPath);

    const bodies: DecodedCommandLogChunk[] = [];
    const api = createFakeInstanceApi();
    api.script("/log", async (init) => {
      bodies.push(await decodeCommandLogChunkBody(init));
      return commandLogChunkResponse({ nextSeq: 1 });
    });
    const restore = api.install();
    try {
      const client = new DaemonApiClient({
        config: { baseUrl: "https://instance.test" } as never,
        getToken: () => Promise.resolve("test-token"),
      });
      const result = await sweepOrphanCommandLogs({
        layout: { daemonStateDir: fixture.dirs.stateDir },
        send: (params) => client.sendCommandLogChunk(params),
      });
      assertEquals(result.uploaded, 1);
      assertEquals(bodies.length, 1);
      assertEquals(bodies[0]?.seq, 0);
      // The base64 payload must decode back to the spooled transcript bytes.
      assertEquals(bodies[0]?.text, spooled);
      assertEquals(
        bodies[0]?.byteLength,
        new TextEncoder().encode(spooled).byteLength,
      );
    } finally {
      restore();
    }
  });
});

test("sweep is a no-op when neither spoolDir nor layout is provided", async () => {
  const result = await sweepOrphanCommandLogs({
    send: () => Promise.reject(new Error("must not be called")),
  });
  assertEquals(result, { uploaded: 0, failed: 0, skipped: 0 });
});

test("sweep skips non-log entries, empty leftovers, and oversized transcripts", async () => {
  await withTempLayout(async (fixture) => {
    const dir = commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir });
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${dir}/notes.txt`, "not a spool\n");
    await Deno.mkdir(`${dir}/subdir`);
    const emptyPath = `${dir}/cmd-empty.log`;
    await Deno.writeTextFile(emptyPath, "");
    const hugePath = `${dir}/cmd-huge.log`;
    await Deno.writeTextFile(hugePath, "x".repeat(4 * 1024 * 1024 + 1));

    const sent: string[] = [];
    const result = await sweepOrphanCommandLogs({
      spoolDir: dir,
      send: (params) => {
        sent.push(params.commandId);
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });

    assertEquals(result, { uploaded: 0, failed: 0, skipped: 2 });
    assertEquals(sent, []);
    assertEquals(await Deno.stat(emptyPath).catch(() => null), null);
    assertEquals((await Deno.stat(hugePath)).isFile, true);
    assertEquals((await Deno.stat(`${dir}/notes.txt`)).isFile, true);
  });
});

test("sweep is a no-op when the spool directory cannot be listed", async () => {
  await withTempLayout(async (fixture) => {
    const dir = commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir });
    await writeSpoolFile(dir, "cmd-hidden", 1);
    const originalReadDir = Deno.readDir.bind(Deno);
    Deno.readDir = () => {
      throw new Error("EACCES");
    };
    try {
      const result = await sweepOrphanCommandLogs({
        spoolDir: dir,
        send: () => Promise.reject(new Error("must not be called")),
      });
      assertEquals(result, { uploaded: 0, failed: 0, skipped: 0 });
    } finally {
      Deno.readDir = originalReadDir;
    }
  });
});

test("sweep skips a spool file a live command sink still owns", async () => {
  await withTempLayout(async (fixture) => {
    const dir = commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir });
    // A crash leftover from a previous process, plus a command running now.
    const orphanPath = await writeSpoolFile(dir, "cmd-prev-crash", 1);
    const sent: string[] = [];
    const sink = createCommandOutputSink({
      commandId: "cmd-in-flight",
      phase: "compose-up",
      layout: { daemonStateDir: fixture.dirs.stateDir },
      // Large thresholds: the line stays spooled while the command runs.
      flushBytes: 1024 * 1024,
      flushIntervalMs: 60_000,
      send: (params) => {
        sent.push(params.commandId);
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });
    sink.onLine("stdout", "still deploying");
    const activePath = commandLogSpoolPath(dir, "cmd-in-flight");

    // Reconnect fires the sweep mid-command.
    const result = await sweepOrphanCommandLogs({
      layout: { daemonStateDir: fixture.dirs.stateDir },
      send: (params) => {
        sent.push(params.commandId);
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });

    assertEquals(result, { uploaded: 1, failed: 0, skipped: 1 });
    assertEquals(sent, ["cmd-prev-crash"]);
    assertEquals(await Deno.stat(orphanPath).catch(() => null), null);
    // The live transcript is untouched and still owned by the sink.
    assertEquals((await Deno.stat(activePath)).isFile, true);
    assertEquals(
      (await Deno.readTextFile(activePath)).includes("still deploying"),
      true,
    );

    await sink.finalize();
    assertEquals(sent, ["cmd-prev-crash", "cmd-in-flight"]);
    // Finalized (and acked) → no longer active, spool removed.
    assertEquals(await Deno.stat(activePath).catch(() => null), null);
  });
});
