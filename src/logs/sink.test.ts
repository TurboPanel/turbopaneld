import { assertEquals, assertStringIncludes } from "@std/assert";
import { withTempLayout } from "../testing/temp-layout.ts";
import { commandLogSpoolDir } from "../paths/layout.ts";
import { commandLogSpoolPath } from "./spool.ts";
import { createCommandOutputSink } from "./sink.ts";
import { TRUNCATION_MARKER } from "./uploader.ts";
import { COMMAND_LOG_PHASES } from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type SentChunk = { commandId: string; seq: number; bytes: string };

function parseEvents(chunks: SentChunk[]) {
  return chunks
    .flatMap((chunk) => chunk.bytes.trim().split("\n"))
    .filter((line) => line.startsWith("{"))
    .map((line) =>
      JSON.parse(line) as { phase: string; message: string; stream: string }
    );
}

test("sink redacts before spooling and uploads on finalize", async () => {
  await withTempLayout(async (fixture) => {
    const sent: SentChunk[] = [];
    const sink = createCommandOutputSink({
      commandId: "cmd-sink-1",
      phase: COMMAND_LOG_PHASES.PREPARE,
      layout: { daemonStateDir: fixture.dirs.stateDir },
      secrets: ["hunter2"],
      send: (params) => {
        sent.push(params);
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });

    const spoolPath = commandLogSpoolPath(
      commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir }),
      "cmd-sink-1",
    );

    sink.onLine("stdout", "starting with hunter2");
    sink.addSecrets(["tls-private-key"]);
    sink.setPhase(COMMAND_LOG_PHASES.COMPOSE_UP);
    sink.onLine("stderr", "wrote tls-private-key to disk");

    // Redaction happens before the spool write — no plaintext on disk.
    const onDisk = await Deno.readTextFile(spoolPath);
    assertEquals(onDisk.includes("hunter2"), false);
    assertEquals(onDisk.includes("tls-private-key"), false);

    await sink.finalize();

    const events = parseEvents(sent);
    assertEquals(events.length, 2);
    assertEquals(events[0]?.phase, COMMAND_LOG_PHASES.PREPARE);
    assertEquals(events[0]?.message, "starting with ***");
    assertEquals(events[1]?.phase, COMMAND_LOG_PHASES.COMPOSE_UP);
    assertEquals(events[1]?.stream, "stderr");
    assertEquals(events[1]?.message, "wrote *** to disk");

    // Fully acked → spool file removed.
    assertEquals(await Deno.stat(spoolPath).catch(() => null), null);
  });
});

test("finalize is safe to call twice", async () => {
  await withTempLayout(async (fixture) => {
    let calls = 0;
    const sink = createCommandOutputSink({
      commandId: "cmd-sink-2",
      phase: "prepare",
      layout: { daemonStateDir: fixture.dirs.stateDir },
      send: (params) => {
        calls += 1;
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });
    sink.onLine("stdout", "one");
    await sink.finalize();
    await sink.finalize();
    assertEquals(calls, 1);
  });
});

test("spool survives an uploader failure and stays for the orphan sweep", async () => {
  await withTempLayout(async (fixture) => {
    const sink = createCommandOutputSink({
      commandId: "cmd-sink-3",
      phase: "prepare",
      layout: { daemonStateDir: fixture.dirs.stateDir },
      send: () => Promise.reject(new Error("instance unreachable")),
    });
    sink.onLine("stdout", "line one");
    await sink.finalize();

    const spoolPath = commandLogSpoolPath(
      commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir }),
      "cmd-sink-3",
    );
    assertStringIncludes(await Deno.readTextFile(spoolPath), "line one");
  });
});

test("byte cap appends the truncation marker once", async () => {
  await withTempLayout(async (fixture) => {
    const sent: SentChunk[] = [];
    const sink = createCommandOutputSink({
      commandId: "cmd-sink-4",
      phase: "build",
      layout: { daemonStateDir: fixture.dirs.stateDir },
      flushBytes: 64,
      maxBytes: 200,
      send: (params) => {
        sent.push(params);
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });
    for (let i = 0; i < 20; i += 1) {
      sink.onLine("stdout", `build step ${i} ${"x".repeat(40)}`);
    }
    await sink.finalize();

    const markers = sent.filter((chunk) =>
      chunk.bytes.includes(TRUNCATION_MARKER)
    );
    assertEquals(markers.length, 1);
    assertEquals(sent.at(-1)?.bytes, `${TRUNCATION_MARKER}\n`);
  });
});

test("sink degrades to a no-op when the spool cannot be opened", async () => {
  await withTempLayout(async (fixture) => {
    let calls = 0;
    const sink = createCommandOutputSink({
      commandId: "../escape",
      phase: "prepare",
      layout: { daemonStateDir: fixture.dirs.stateDir },
      send: () => {
        calls += 1;
        return Promise.resolve({ nextSeq: 1 });
      },
    });
    sink.onLine("stdout", "ignored");
    await sink.finalize();
    assertEquals(calls, 0);
  });
});

test("a failed truncation marker keeps the spool file for the orphan sweep", async () => {
  await withTempLayout(async (fixture) => {
    const sink = createCommandOutputSink({
      commandId: "cmd-sink-5",
      phase: "build",
      layout: { daemonStateDir: fixture.dirs.stateDir },
      flushBytes: 64,
      maxBytes: 200,
      send: (params) => {
        if (params.bytes.includes(TRUNCATION_MARKER)) {
          return Promise.reject(new Error("instance unreachable"));
        }
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });
    for (let i = 0; i < 20; i += 1) {
      sink.onLine("stdout", `build step ${i} ${"x".repeat(40)}`);
    }
    await sink.finalize();

    const spoolPath = commandLogSpoolPath(
      commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir }),
      "cmd-sink-5",
    );
    // Nothing durable was stored for the sealed tail — keep the transcript.
    assertStringIncludes(await Deno.readTextFile(spoolPath), "build step 0");
  });
});

test("spooling stops once the truncation marker is sealed", async () => {
  await withTempLayout(async (fixture) => {
    const sink = createCommandOutputSink({
      commandId: "cmd-sink-6",
      phase: "build",
      layout: { daemonStateDir: fixture.dirs.stateDir },
      flushBytes: 64,
      maxBytes: 200,
      send: (params) => Promise.resolve({ nextSeq: params.seq + 1 }),
    });
    const spoolPath = commandLogSpoolPath(
      commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir }),
      "cmd-sink-6",
    );
    for (let i = 0; i < 20; i += 1) {
      sink.onLine("stdout", `build step ${i} ${"x".repeat(40)}`);
      // Let queued flushes (and the truncation seal) run between lines.
      await Promise.resolve();
    }
    const sealedSize = (await Deno.stat(spoolPath)).size;
    for (let i = 0; i < 20; i += 1) {
      sink.onLine("stdout", `post-cap line ${i} ${"y".repeat(40)}`);
    }
    assertEquals((await Deno.stat(spoolPath)).size, sealedSize);
    assertEquals(
      (await Deno.readTextFile(spoolPath)).includes("post-cap line"),
      false,
    );
    await sink.finalize();
  });
});

test("multiline TLS private key material never reaches the spool", async () => {
  await withTempLayout(async (fixture) => {
    const sent: SentChunk[] = [];
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ",
      "Cw3fakekeymaterialline2/PLAINTEXT+not+for+disk==",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");
    const multilineVariable = "VAR_LINE_ONE_SECRET\nVAR_LINE_TWO_SECRET";
    const sink = createCommandOutputSink({
      commandId: "cmd-sink-7",
      phase: COMMAND_LOG_PHASES.PREPARE,
      layout: { daemonStateDir: fixture.dirs.stateDir },
      secrets: [pem],
      send: (params) => {
        sent.push(params);
        return Promise.resolve({ nextSeq: params.seq + 1 });
      },
    });
    const spoolPath = commandLogSpoolPath(
      commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir }),
      "cmd-sink-7",
    );

    sink.addSecrets([multilineVariable]);
    // The sink sees the decrypted material one line at a time (that is how
    // `runDockerStreamed` tees it), so each PEM line must match on its own.
    for (const line of [...pem.split("\n"), ...multilineVariable.split("\n")]) {
      if (line.length === 0) continue;
      sink.onLine("stdout", `echoing ${line}`);
    }

    const onDisk = await Deno.readTextFile(spoolPath);
    for (const line of [...pem.split("\n"), ...multilineVariable.split("\n")]) {
      if (line.length === 0) continue;
      assertEquals(onDisk.includes(line), false);
    }
    assertStringIncludes(onDisk, "echoing ***");

    await sink.finalize();
    const uploaded = sent.map((chunk) => chunk.bytes).join("");
    assertEquals(uploaded.includes("PLAINTEXT+not+for+disk"), false);
    assertEquals(uploaded.includes("VAR_LINE_TWO_SECRET"), false);
  });
});
