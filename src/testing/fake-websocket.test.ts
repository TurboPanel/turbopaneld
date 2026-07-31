/**
 * Test-only helpers — do not import from production code.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  framesOfType,
  lastFrameOfType,
  MockWebSocket,
  parseSentFrames,
} from "./fake-websocket.ts";

describe("fake-websocket frame helpers", () => {
  it("parseSentFrames JSON-parses outbound frames", () => {
    const socket = new MockWebSocket("wss://example.test");
    socket.open();
    socket.send(JSON.stringify({ type: "hello", at: "t0" }));
    socket.send(JSON.stringify({ type: "ping" }));
    assertEquals(parseSentFrames(socket), [
      { type: "hello", at: "t0" },
      { type: "ping" },
    ]);
  });

  it("parseSentFrames throws TypeError on invalid JSON", () => {
    const socket = new MockWebSocket("wss://example.test");
    socket.open();
    socket.send("not-json{");
    assertThrows(
      () => parseSentFrames(socket),
      TypeError,
      "sentFrames[0] is not valid JSON",
    );
  });

  it("framesOfType / lastFrameOfType filter by type", () => {
    const socket = new MockWebSocket("wss://example.test");
    socket.open();
    socket.send(JSON.stringify({ type: "hello" }));
    socket.send(JSON.stringify({ type: "ping" }));
    socket.send(JSON.stringify({ type: "heartbeat", at: "t1" }));
    socket.send(JSON.stringify({ type: "ping" }));
    assertEquals(framesOfType(socket, "ping"), [
      { type: "ping" },
      { type: "ping" },
    ]);
    assertEquals(lastFrameOfType(socket, "heartbeat"), {
      type: "heartbeat",
      at: "t1",
    });
    assertEquals(lastFrameOfType(socket, "missing"), undefined);
  });
});
