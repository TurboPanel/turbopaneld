import { assertEquals } from "@std/assert";
import {
  CommandLogUploader,
  type SendCommandLogChunkFn,
  TRUNCATION_MARKER,
} from "./uploader.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type SentChunk = { commandId: string; seq: number; bytes: string };

function recorder(
  behavior: (call: number) => void = () => {},
): { sent: SentChunk[]; send: SendCommandLogChunkFn } {
  const sent: SentChunk[] = [];
  let calls = 0;
  const send: SendCommandLogChunkFn = (params) => {
    calls += 1;
    behavior(calls);
    sent.push(params);
    return Promise.resolve({ nextSeq: params.seq + 1 });
  };
  return { sent, send };
}

const noSleep = () => Promise.resolve();

test("upload forwards the chunk and reports the ack", async () => {
  const { sent, send } = recorder();
  const uploader = new CommandLogUploader({ commandId: "cmd-1", send });
  assertEquals(await uploader.upload({ seq: 1, bytes: "line\n" }), true);
  assertEquals(sent, [{ commandId: "cmd-1", seq: 1, bytes: "line\n" }]);
});

test("upload retries then gives up without throwing", async () => {
  const { sent, send } = recorder((call) => {
    if (call < 3) throw new Error(`transport down ${call}`);
  });
  const uploader = new CommandLogUploader({
    commandId: "cmd-2",
    send,
    sleep: noSleep,
  });
  assertEquals(await uploader.upload({ seq: 1, bytes: "a\n" }), true);
  assertEquals(sent.length, 1);

  const alwaysFails = new CommandLogUploader({
    commandId: "cmd-3",
    send: () => Promise.reject(new Error("nope")),
    sleep: noSleep,
  });
  assertEquals(await alwaysFails.upload({ seq: 1, bytes: "a\n" }), false);
});

test("byte cap emits one truncation marker and stops uploading", async () => {
  const { sent, send } = recorder();
  const uploader = new CommandLogUploader({
    commandId: "cmd-4",
    send,
    maxBytes: 20,
  });
  assertEquals(await uploader.upload({ seq: 1, bytes: "0123456789\n" }), true);
  assertEquals(uploader.truncated, false);

  await uploader.upload({ seq: 2, bytes: "0123456789abcdef\n" });
  assertEquals(uploader.truncated, true);
  assertEquals(sent.at(-1)?.bytes, `${TRUNCATION_MARKER}\n`);

  assertEquals(await uploader.upload({ seq: 3, bytes: "more\n" }), false);
  assertEquals(
    sent.filter((c) => c.bytes.includes(TRUNCATION_MARKER)).length,
    1,
  );
});

test("a failed truncation marker is reported as unacked and stays unsealed", async () => {
  const attempts: SentChunk[] = [];
  const uploader = new CommandLogUploader({
    commandId: "cmd-5",
    maxBytes: 20,
    sleep: noSleep,
    send: (params) => {
      attempts.push(params);
      if (params.bytes.includes(TRUNCATION_MARKER)) {
        return Promise.reject(new Error("instance unreachable"));
      }
      return Promise.resolve({ nextSeq: params.seq + 1 });
    },
  });

  assertEquals(await uploader.upload({ seq: 1, bytes: "0123456789\n" }), true);
  // Cap trips; the marker cannot be delivered → nothing is acked or sealed.
  assertEquals(
    await uploader.upload({ seq: 2, bytes: "0123456789abc\n" }),
    false,
  );
  assertEquals(uploader.truncated, false);
  assertEquals(
    attempts.filter((c) => c.bytes.includes(TRUNCATION_MARKER)).length,
    3,
  );
});
