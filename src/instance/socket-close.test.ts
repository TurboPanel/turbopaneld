import { assertEquals } from "@std/assert";
import { closeAndAbandon } from "./socket-close.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A half-open socket: close() starts CLOSING and the peer never answers. */
class HalfOpenSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  closeCalls = 0;
  close(): void {
    this.closeCalls++;
    this.readyState = WebSocket.CLOSING;
  }
}

Deno.test("closeAndAbandon fires the close event when the peer never answers", async () => {
  const ws = new HalfOpenSocket();
  let closed = 0;
  ws.addEventListener("close", () => closed++);
  closeAndAbandon(ws as unknown as WebSocket, 30);
  assertEquals(closed, 0);
  await sleep(80);
  assertEquals(closed, 1);
  assertEquals(ws.closeCalls, 1);
});

Deno.test("closeAndAbandon stays quiet when the socket closes normally", async () => {
  const ws = new HalfOpenSocket();
  let closed = 0;
  ws.addEventListener("close", () => closed++);
  closeAndAbandon(ws as unknown as WebSocket, 30);
  ws.readyState = WebSocket.CLOSED;
  ws.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  await sleep(80);
  assertEquals(closed, 1);
});

Deno.test("closeAndAbandon unbinds handlers so a late frame or close is ignored", async () => {
  const ws = new HalfOpenSocket() as HalfOpenSocket & {
    onmessage: (() => void) | null;
    onclose: (() => void) | null;
  };
  ws.onmessage = () => {};
  ws.onclose = () => {};
  closeAndAbandon(ws as unknown as WebSocket, 20);
  assertEquals(typeof ws.onclose, "function");
  await sleep(60);
  assertEquals(ws.onmessage, null);
  assertEquals(ws.onclose, null);
});

Deno.test("closeAndAbandon leaves a socket that already closed alone", async () => {
  const ws = new HalfOpenSocket() as HalfOpenSocket & {
    onmessage: (() => void) | null;
  };
  const handler = () => {};
  ws.onmessage = handler;
  closeAndAbandon(ws as unknown as WebSocket, 20);
  ws.readyState = WebSocket.CLOSED;
  await sleep(60);
  assertEquals(ws.onmessage, handler);
});
