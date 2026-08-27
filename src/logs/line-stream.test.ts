import { assertEquals } from "@std/assert";
import { emitBufferedLines, pumpLines } from "./line-stream.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function chunkedStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(parts[index]));
      index += 1;
    },
  });
}

test("pumpLines accumulates the full decoded text without a line handler", async () => {
  const text = await pumpLines(streamFrom("one\ntwo\n"));
  assertEquals(text, "one\ntwo\n");
});

test("pumpLines emits complete lines and strips trailing CR", async () => {
  const lines: string[] = [];
  const text = await pumpLines(
    streamFrom("one\r\ntwo\n\nthree"),
    (line) => lines.push(line),
  );
  assertEquals(text, "one\r\ntwo\n\nthree");
  assertEquals(lines, ["one", "two", "three"]);
});

test("pumpLines joins chunks that split a line across reads", async () => {
  const lines: string[] = [];
  const text = await pumpLines(
    chunkedStream(["hel", "lo\nwor", "ld\n"]),
    (line) => lines.push(line),
  );
  assertEquals(text, "hello\nworld\n");
  assertEquals(lines, ["hello", "world"]);
});

test("pumpLines skips empty chunks and empty lines", async () => {
  const lines: string[] = [];
  await pumpLines(
    chunkedStream(["\n", "", "keep\n", "\n"]),
    (line) => lines.push(line),
  );
  assertEquals(lines, ["keep"]);
});

test("emitBufferedLines is a no-op without a handler or text", () => {
  emitBufferedLines("", () => {
    throw new TypeError("must not emit");
  });
  emitBufferedLines("hello");
});

test("emitBufferedLines replays non-empty lines and strips CR", () => {
  const lines: string[] = [];
  emitBufferedLines("one\r\n\ntwo\r", (line) => lines.push(line));
  assertEquals(lines, ["one", "two"]);
});
