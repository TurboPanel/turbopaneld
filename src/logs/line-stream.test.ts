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

test("pumpLines skips a decoded empty string chunk", async () => {
  const lines: string[] = [];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("keep\n"));
      controller.enqueue(new Uint8Array());
      controller.enqueue(encoder.encode("tail\n"));
      controller.close();
    },
  });
  const text = await pumpLines(stream, (line) => lines.push(line));
  assertEquals(text, "keep\ntail\n");
  assertEquals(lines, ["keep", "tail"]);
});

test("pumpLines skips a falsy decoded value from TextDecoderStream", async () => {
  const Original = globalThis.TextDecoderStream;
  globalThis.TextDecoderStream = class
    extends TransformStream<Uint8Array, string> {
    constructor() {
      super({
        transform(chunk, controller) {
          controller.enqueue("");
          const decoded = new TextDecoder().decode(chunk);
          if (decoded) controller.enqueue(decoded);
        },
      });
    }
  } as typeof TextDecoderStream;
  try {
    const lines: string[] = [];
    const text = await pumpLines(
      streamFrom("keep\n"),
      (line) => lines.push(line),
    );
    assertEquals(text, "keep\n");
    assertEquals(lines, ["keep"]);
  } finally {
    globalThis.TextDecoderStream = Original;
  }
});

test("pumpLines drops a trailing whitespace-only remainder", async () => {
  const lines: string[] = [];
  const text = await pumpLines(
    streamFrom("keep\n   "),
    (line) => lines.push(line),
  );
  assertEquals(text, "keep\n   ");
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

function repeatedStream(
  piece: string,
  times: number,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(piece);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= times) return controller.close();
      sent += 1;
      controller.enqueue(bytes);
    },
  });
}

test("pumpLines keeps only the tail when tailChars is set", async () => {
  const text = await pumpLines(
    repeatedStream("line of output\n", 20_000),
    undefined,
    { tailChars: 1000 },
  );
  assertEquals(text.length <= 1000, true);
  assertEquals(text.endsWith("line of output\n"), true);
});

test("pumpLines splits a newline-free stream in linear time with bounded memory", async () => {
  const pieces: number[] = [];
  const started = performance.now();
  const text = await pumpLines(
    repeatedStream("x".repeat(65536), 800),
    (line) => pieces.push(line.length),
    { tailChars: 4096, maxLineChars: 8192 },
  );
  assertEquals(performance.now() - started < 5000, true);
  assertEquals(text.length <= 4096, true);
  assertEquals(Math.max(...pieces) <= 8192, true);
  assertEquals(pieces.reduce((a, b) => a + b, 0), 65536 * 800);
});

test("pumpLines calls onLimit once past maxTotalChars and drains the rest", async () => {
  let hits = 0;
  const lines: string[] = [];
  const text = await pumpLines(
    repeatedStream("abcdefghi\n", 1000),
    (line) => lines.push(line),
    { tailChars: 100, maxTotalChars: 500, onLimit: () => hits += 1 },
  );
  assertEquals(hits, 1);
  assertEquals(lines.length <= 50, true);
  assertEquals(text.length <= 100, true);
});
