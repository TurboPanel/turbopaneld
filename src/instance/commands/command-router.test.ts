import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import type { CommandDispatchMessage } from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;

  readonly sentFrames: string[] = [];
  readyState = MockWebSocket.OPEN;

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("cannot send on a non-open mock socket");
    }
    this.sentFrames.push(data);
  }
}

function parseFrames(frames: string[]): Record<string, unknown>[] {
  return frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

test({
  name: "handleCommandDispatch acks then returns ping outcome",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: "req-1",
      commandId: "cmd-1",
      commandType: "daemon.ping",
      payload: {},
      at: new Date().toISOString(),
    };

    await handleCommandDispatch(message, ws);

    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames.length, 2);
    assertEquals(frames[0]?.type, "command-ack");
    assertEquals(typeof frames[0]?.daemonReceivedAt, "string");
    assertEquals(frames[1]?.type, "command-outcome");
    assertEquals(frames[1]?.ok, true);
    assertEquals(typeof frames[1]?.daemonReceivedAt, "string");
    assertEquals(typeof frames[1]?.daemonRespondedAt, "string");

    const result = frames[1]?.result as Record<string, unknown>;
    assert(
      typeof result.daemonHostname === "string" &&
        result.daemonHostname.length > 0,
    );
    assertEquals(
      typeof (result.daemonBuild as Record<string, unknown>).commit,
      "string",
    );
  },
});

test({
  name:
    "handleCommandDispatch returns sanitized error for unknown command type",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: "req-2",
      commandId: "cmd-2",
      commandType: "does.not.exist",
      payload: {},
      at: new Date().toISOString(),
    };

    await handleCommandDispatch(message, ws);

    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames[0]?.type, "command-ack");
    assertEquals(frames[1]?.type, "command-outcome");
    assertEquals(frames[1]?.ok, false);
    assertEquals(frames[1]?.result, undefined);
    assertMatch(String(frames[1]?.error), /Unknown command type/);
    assertEquals(String(frames[1]?.error).includes("\n"), false);
  },
});

test({
  name: "handleCommandDispatch acks then returns reboot outcome",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const { setRebootExecutorForTests } = await import("./reboot.ts");

    let executorScheduled = false;
    setRebootExecutorForTests(async () => {
      executorScheduled = true;
      return { success: true, stderr: "" };
    });

    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-reboot",
        commandId: "cmd-reboot",
        commandType: "server.reboot",
        payload: {},
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames.length, 2);
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.type, "command-outcome");
      assertEquals(frames[1]?.ok, true);

      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.scheduled, true);
      assertEquals(executorScheduled, false);
    } finally {
      setRebootExecutorForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch rejects invalid hostname before ansible",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: "req-3",
      commandId: "cmd-3",
      commandType: "server.hostname.set",
      payload: { hostname: "a;rm -rf /" },
      at: new Date().toISOString(),
    };

    await handleCommandDispatch(message, ws);

    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames[0]?.type, "command-ack");
    assertEquals(frames[1]?.type, "command-outcome");
    assertEquals(frames[1]?.ok, false);
    assertEquals(frames[1]?.result, undefined);
    assertMatch(String(frames[1]?.error), /Invalid hostname/);
    assertEquals(String(frames[1]?.error).includes("\n"), false);
    assert(String(frames[1]?.error).length <= 500);
  },
});
