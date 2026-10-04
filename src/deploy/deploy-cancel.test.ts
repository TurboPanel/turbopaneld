import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CANCELLED_PREFIX,
  createDeployCancelToken,
  DeployCancelledError,
  DeployCancelRegistry,
  throwIfAborted,
} from "./deploy-cancel.ts";
import { runDockerStreamed, setDockerCliIoForTest } from "./docker-cli.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

test("every cancelled error starts with the wire prefix", () => {
  const err = new DeployCancelledError("stopped while building");
  assert(err.message.startsWith(CANCELLED_PREFIX));
  assertEquals(err.message, "cancelled: stopped while building");
  assertEquals(err.name, "DeployCancelledError");
});

test("throwIfAborted ignores a missing or quiet signal and throws on an aborted one", () => {
  throwIfAborted(undefined, "x");
  throwIfAborted(new AbortController().signal, "x");
  const controller = new AbortController();
  controller.abort();
  const err = assertThrows(
    () => throwIfAborted(controller.signal, "while building"),
    DeployCancelledError,
  );
  assert(err.message.startsWith(CANCELLED_PREFIX));
  assert(err.message.includes("while building"));
  assert(err.message.includes("previous version is still serving"));
});

test("a token cancels before commit and refuses after it", () => {
  const token = createDeployCancelToken();
  token.throwIfCancelled("here");
  assertEquals(token.cancel(), "cancelling");
  assertEquals(token.signal.aborted, true);
  assertEquals(token.cancel(), "cancelling");
  assertThrows(() => token.throwIfCancelled("here"), DeployCancelledError);
  // A cancel that landed first wins: the deploy may not commit.
  assertThrows(() => token.commit("here"), DeployCancelledError);
  assertEquals(token.committed, false);
});

test("a committed token answers too_late and never aborts", () => {
  const token = createDeployCancelToken();
  token.commit("switching");
  token.commit("switching again");
  assertEquals(token.committed, true);
  assertEquals(token.cancel(), "too_late");
  assertEquals(token.signal.aborted, false);
  token.throwIfCancelled("later");
});

test("the registry cancels a live deploy and forgets it when it ends", () => {
  const registry = new DeployCancelRegistry();
  const token = registry.begin("c1");
  assertEquals(registry.cancel("c1"), "cancelling");
  assertEquals(token.signal.aborted, true);
  registry.end("c1");
  assertEquals(registry.cancel("c1"), "not_running");
});

test("the registry reports too_late for a committed deploy", () => {
  const registry = new DeployCancelRegistry();
  registry.begin("c1").commit("switching");
  assertEquals(registry.cancel("c1"), "too_late");
});

test("a cancel for an unknown deploy is remembered and refuses the later dispatch once", () => {
  const registry = new DeployCancelRegistry();
  assertEquals(registry.cancel("late"), "not_running");
  const err = assertThrows(() => registry.begin("late"), DeployCancelledError);
  assert(err.message.startsWith(CANCELLED_PREFIX));
  // The memory is spent: a second dispatch of the same id is not refused.
  registry.begin("late");
});

test("a remembered cancel expires", () => {
  let now = 1_000;
  const registry = new DeployCancelRegistry({
    now: () => now,
    rememberMs: 500,
  });
  registry.cancel("late");
  now += 501;
  registry.begin("late");
});

test("remembered cancels are bounded, oldest dropped first", () => {
  const registry = new DeployCancelRegistry({ maxRemembered: 2 });
  registry.cancel("a");
  registry.cancel("b");
  registry.cancel("c");
  registry.begin("a");
  assertThrows(() => registry.begin("b"), DeployCancelledError);
  assertThrows(() => registry.begin("c"), DeployCancelledError);
});

test("aborting the signal kills a streamed docker child", async () => {
  const restore = setDockerCliIoForTest({
    spawnStreaming: (_bin, _args, options) =>
      Promise.resolve(
        new Deno.Command("sleep", {
          args: ["30"],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }).spawn(),
      ),
  });
  try {
    const token = createDeployCancelToken();
    setTimeout(() => token.cancel(), 100);
    const started = Date.now();
    const result = await runDockerStreamed(["compose", "build"], {
      signal: token.signal,
    });
    assertEquals(result.success, false);
    assert(Date.now() - started < 10_000, "the child was not killed");
  } finally {
    restore();
  }
});
