import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  CHANNEL_PINNED_CODE,
  decideUpdateChannel,
} from "./update-channel-pin.ts";
import { UpdatePreflightError } from "./run-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("an absent or empty message channel keeps the host channel", () => {
  for (const messageChannel of [undefined, null, "", "   "]) {
    for (const signedSession of [false, true]) {
      assertEquals(
        decideUpdateChannel({
          hostChannel: "release",
          messageChannel,
          signedSession,
        }),
        "release",
      );
    }
  }
});

test("the host's own channel passes on an unsigned session", () => {
  assertEquals(
    decideUpdateChannel({
      hostChannel: "canary",
      messageChannel: " canary ",
      signedSession: false,
    }),
    "canary",
  );
});

test("a signed session may move the server to another channel", () => {
  assertEquals(
    decideUpdateChannel({
      hostChannel: "release",
      messageChannel: "canary",
      signedSession: true,
    }),
    "canary",
  );
});

test("an unsigned session cannot change the channel", () => {
  const err = assertThrows(
    () =>
      decideUpdateChannel({
        hostChannel: "release",
        messageChannel: "trunk",
        signedSession: false,
      }),
    UpdatePreflightError,
  );
  assertEquals(err.code, CHANNEL_PINNED_CODE);
  assertStringIncludes(err.message, "channel_pinned: ");
  assertStringIncludes(err.message, "update channel is release");
  assertStringIncludes(err.message, "re-running the installer on the host");
});

test("an unknown message channel falls back to the host channel", () => {
  for (const signedSession of [false, true]) {
    assertEquals(
      decideUpdateChannel({
        hostChannel: "rc",
        messageChannel: "!!!invalid!!!",
        signedSession,
      }),
      "rc",
    );
  }
});
