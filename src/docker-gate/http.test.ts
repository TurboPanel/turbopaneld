import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BufferedReader,
  type ByteSink,
  type ByteSource,
  concatBytes,
  encodeText,
  errorResponse,
  headerTokens,
  headerValue,
  HttpError,
  MAX_HEAD_BYTES,
  parseRequestHead,
  parseResponseHead,
  relayBody,
  relayChunked,
  requestFraming,
  responseFraming,
  wantsClose,
} from "../../orchestration/roles/docker-gate/files/http.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** A source that hands out the given pieces one read at a time. */
function pieces(...parts: Array<string | Uint8Array>): ByteSource {
  const queue = parts.map((part) =>
    typeof part === "string" ? encodeText(part) : part
  );
  return {
    read(p) {
      const next = queue.shift();
      if (next === undefined) return Promise.resolve(null);
      const take = Math.min(next.length, p.length);
      p.set(next.subarray(0, take));
      if (take < next.length) queue.unshift(next.subarray(take));
      return Promise.resolve(take);
    },
  };
}

function collector(): ByteSink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write(p) {
      parts.push(p.slice());
      return Promise.resolve(p.length);
    },
    bytes: () => concatBytes(parts),
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function head(raw: string) {
  return parseRequestHead(encodeText(raw));
}

test("a request head is read across small reads and parsed", async () => {
  const reader = new BufferedReader(
    pieces(
      "POST /v1.43/containers/cre",
      "ate HTTP/1.1\r\nHost: d\r\n",
      "\r\nBODY",
    ),
  );
  const raw = await reader.readHead();
  assert(raw !== null);
  assertEquals(
    text(raw),
    "POST /v1.43/containers/create HTTP/1.1\r\nHost: d\r\n\r\n",
  );
  const parsed = parseRequestHead(raw);
  assertEquals(parsed.method, "POST");
  assertEquals(parsed.target, "/v1.43/containers/create");
  assertEquals(headerValue(parsed.headers, "host"), "d");
  assertEquals(reader.buffered, 4);
  assertEquals(text(reader.takeBuffered()), "BODY");
});

test("a clean EOF before a request yields null; EOF inside a head is a 400", async () => {
  assertEquals(await new BufferedReader(pieces()).readHead(), null);
  const err = await assertRejects(
    () => new BufferedReader(pieces("GET / HTTP/1.1\r\nHo")).readHead(),
    HttpError,
  );
  assertEquals(err.status, 400);
});

test("a head larger than the cap is a 431", async () => {
  const big = new Uint8Array(MAX_HEAD_BYTES + 100).fill(65);
  const err = await assertRejects(
    () => new BufferedReader(pieces(big)).readHead(),
    HttpError,
  );
  assertEquals(err.status, 431);
});

const BAD_REQUESTS: Array<[string, string, number]> = [
  ["bare LF", "GET / HTTP/1.1\nHost: d\r\n\r\n", 400],
  ["obs-fold", "GET / HTTP/1.1\r\nHost: d\r\n  folded\r\n\r\n", 400],
  ["space before colon", "GET / HTTP/1.1\r\nHost : d\r\n\r\n", 400],
  ["no colon", "GET / HTTP/1.1\r\nHost\r\n\r\n", 400],
  ["NUL byte", "GET / HTTP/1.1\r\nX: a\u0000b\r\n\r\n", 400],
  ["lowercase method", "get / HTTP/1.1\r\n\r\n", 400],
  ["absolute-form target", "GET http://x/ HTTP/1.1\r\n\r\n", 400],
  ["extra request-line token", "GET / x HTTP/1.1\r\n\r\n", 400],
  ["HTTP/2", "GET / HTTP/2.0\r\n\r\n", 505],
];

for (const [name, raw, status] of BAD_REQUESTS) {
  test(`parseRequestHead refuses ${name}`, () => {
    const err = assertThrows(() => head(raw), HttpError);
    assertEquals(err.status, status);
  });
}

test("framing: length, chunked, none, and every ambiguity is refused", () => {
  assertEquals(requestFraming(head("GET / HTTP/1.1\r\n\r\n")), {
    kind: "none",
  });
  assertEquals(
    requestFraming(head("POST / HTTP/1.1\r\nContent-Length: 12\r\n\r\n")),
    { kind: "length", length: 12 },
  );
  assertEquals(
    requestFraming(
      head("POST / HTTP/1.1\r\nTransfer-Encoding: Chunked\r\n\r\n"),
    ),
    { kind: "chunked" },
  );
  const refused = [
    "POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: 1, 1\r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: 0x10\r\n\r\n",
    "POST / HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
    "POST / HTTP/1.1\r\nTransfer-Encoding: identity\r\n\r\n",
  ];
  for (const raw of refused) {
    assertThrows(() => requestFraming(head(raw)), HttpError, "", raw);
  }
});

test("response framing: no body for HEAD, 204, 304 and 1xx; eof when unframed", () => {
  const respond = (status: string, extra = "") =>
    parseResponseHead(encodeText(`HTTP/1.1 ${status}\r\n${extra}\r\n`));
  assertEquals(
    responseFraming("GET", respond("200 OK", "Content-Length: 3\r\n")),
    {
      kind: "length",
      length: 3,
    },
  );
  assertEquals(
    responseFraming("HEAD", respond("200 OK", "Content-Length: 3\r\n")),
    {
      kind: "none",
    },
  );
  assertEquals(responseFraming("GET", respond("204 No Content")), {
    kind: "none",
  });
  assertEquals(responseFraming("GET", respond("304 Not Modified")), {
    kind: "none",
  });
  assertEquals(responseFraming("GET", respond("100 Continue")), {
    kind: "none",
  });
  assertEquals(responseFraming("GET", respond("200 OK")), { kind: "eof" });
  assertEquals(
    responseFraming("GET", respond("200 OK", "Transfer-Encoding: chunked\r\n")),
    { kind: "chunked" },
  );
});

test("a malformed status line is a 502", () => {
  const err = assertThrows(
    () => parseResponseHead(encodeText("HTTP/1.1 OK\r\n\r\n")),
    HttpError,
  );
  assertEquals(err.status, 502);
});

test("header helpers split, lower-case and find case-insensitively", () => {
  const parsed = head(
    "GET / HTTP/1.1\r\nConnection: Upgrade, Keep-Alive\r\nupgrade: tcp\r\n\r\n",
  );
  assertEquals(headerTokens(parsed.headers, "CONNECTION"), [
    "upgrade",
    "keep-alive",
  ]);
  assertEquals(headerValue(parsed.headers, "Upgrade"), "tcp");
  assertEquals(headerValue(parsed.headers, "missing"), undefined);
});

test("wantsClose: Connection: close, and HTTP/1.0 without keep-alive", () => {
  const close = head("GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
  assertEquals(wantsClose(close.headers, close.version), true);
  const plain = head("GET / HTTP/1.1\r\n\r\n");
  assertEquals(wantsClose(plain.headers, plain.version), false);
  const old = head("GET / HTTP/1.0\r\n\r\n");
  assertEquals(wantsClose(old.headers, old.version), true);
  const oldKeep = head("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n");
  assertEquals(wantsClose(oldKeep.headers, oldKeep.version), false);
});

test("copyExact relays exactly the length and leaves the next message buffered", async () => {
  const reader = new BufferedReader(pieces("hel", "lo wor", "ld!NEXT"));
  const sink = collector();
  await reader.copyExact(12, sink);
  assertEquals(text(sink.bytes()), "hello world!");
  assertEquals(text(reader.takeBuffered()), "NEXT");
});

test("copyExact throws when the stream ends early", async () => {
  const reader = new BufferedReader(pieces("abc"));
  await assertRejects(() => reader.copyExact(10, collector()), HttpError);
});

const CHUNKED = "5\r\nhello\r\n7;ext=1\r\n, world\r\n0\r\nTrailer: x\r\n\r\n";

test("relayChunked forwards the framing byte for byte", async () => {
  const reader = new BufferedReader(pieces(CHUNKED + "TAIL"));
  const sink = collector();
  await relayChunked(reader, sink);
  assertEquals(text(sink.bytes()), CHUNKED);
  assertEquals(text(reader.takeBuffered()), "TAIL");
});

test("relayChunked can capture the decoded payload and enforce a cap", async () => {
  const sink = collector();
  const capture = { chunks: [] as Uint8Array[], maxBytes: 100 };
  await relayChunked(new BufferedReader(pieces(CHUNKED)), sink, capture);
  assertEquals(text(concatBytes(capture.chunks)), "hello, world");
  assertEquals(text(sink.bytes()), CHUNKED);

  const tooBig = { chunks: [] as Uint8Array[], maxBytes: 8 };
  const err = await assertRejects(
    () =>
      relayChunked(new BufferedReader(pieces(CHUNKED)), collector(), tooBig),
    HttpError,
  );
  assertEquals(err.status, 413);
});

test("relayChunked refuses a bad chunk size", async () => {
  await assertRejects(
    () => relayChunked(new BufferedReader(pieces("zz\r\n")), collector()),
    HttpError,
    "invalid chunk size",
  );
});

test("relayBody follows the framing, including until-EOF", async () => {
  const none = collector();
  await relayBody(
    new BufferedReader(pieces("ignored")),
    { kind: "none" },
    none,
  );
  assertEquals(none.bytes().length, 0);

  const eof = collector();
  await relayBody(
    new BufferedReader(pieces("a", "b", "c")),
    { kind: "eof" },
    eof,
  );
  assertEquals(text(eof.bytes()), "abc");

  const length = collector();
  await relayBody(
    new BufferedReader(pieces("abcdef")),
    { kind: "length", length: 4 },
    length,
  );
  assertEquals(text(length.bytes()), "abcd");

  const chunked = collector();
  await relayBody(
    new BufferedReader(pieces(CHUNKED)),
    { kind: "chunked" },
    chunked,
  );
  assertEquals(text(chunked.bytes()), CHUNKED);
});

test("atEof distinguishes buffered bytes from an ended stream", async () => {
  const reader = new BufferedReader(pieces("x"));
  assertEquals(await reader.atEof(), false);
  assertEquals(text(reader.takeBuffered()), "x");
  assertEquals(await reader.atEof(), true);
});

test("errorResponse is a complete JSON response that closes the connection", () => {
  const response = text(errorResponse(417, "nope"));
  assert(response.startsWith("HTTP/1.1 417 Expectation Failed\r\n"));
  assert(response.includes("Connection: close"));
  assert(response.endsWith('{"message":"nope"}'));
  assert(text(errorResponse(499, "x")).startsWith("HTTP/1.1 499 Error"));
});

test("optional whitespace is only space and tab: a vertical tab is not trimmed", () => {
  const spaced = head("POST / HTTP/1.1\r\nContent-Length: \t 5 \t\r\n\r\n");
  assertEquals(requestFraming(spaced), { kind: "length", length: 5 });
  const odd = head("POST / HTTP/1.1\r\nContent-Length: \u000b5\r\n\r\n");
  assertThrows(() => requestFraming(odd), HttpError, "invalid Content-Length");
});

test("a request target holding '#' is refused: Go reads it as data, not a fragment", () => {
  for (
    const target of ["/build?q=1#&networkmode=host", "/build#?networkmode=host"]
  ) {
    assertThrows(
      () => parseRequestHead(encodeText(`POST ${target} HTTP/1.1\r\n\r\n`)),
      HttpError,
    );
  }
});
