import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertMessageManifestIsChannelHead,
  CHANNEL_PINNED_CODE,
  CHANNEL_UNKNOWN_CODE,
  decideMessageManifest,
  decideUpdateChannel,
  hostUpdateChannel,
  MANIFEST_PINNED_CODE,
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

test("an unknown message channel is refused, signed session or not", () => {
  for (const signedSession of [false, true]) {
    const err = assertThrows(
      () =>
        decideUpdateChannel({
          hostChannel: "rc",
          messageChannel: "!!!invalid!!!",
          signedSession,
        }),
      UpdatePreflightError,
    );
    assertEquals(err.code, CHANNEL_UNKNOWN_CODE);
    assertStringIncludes(err.message, "channel_unknown: ");
    assertStringIncludes(err.message, '"!!!invalid!!!"');
    assertStringIncludes(err.message, "update channel is rc");
    assertStringIncludes(err.message, "nothing was installed");
  }
});

test("a long unknown channel name is cut short in the refusal", () => {
  const err = assertThrows(
    () =>
      decideUpdateChannel({
        hostChannel: "release",
        messageChannel: "x".repeat(5_000),
        signedSession: true,
      }),
    UpdatePreflightError,
  );
  assertEquals(err.code, CHANNEL_UNKNOWN_CODE);
  assertEquals(err.message.length < 400, true);
});

test("the host channel comes from daemon.env, release by default", () => {
  assertEquals(hostUpdateChannel({}), "release");
  assertEquals(
    hostUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: "canary" }),
    "canary",
  );
});

test("an invalid daemon.env channel is refused as preflight_manifest", () => {
  const err = assertThrows(
    () => hostUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: "nightly" }),
    UpdatePreflightError,
  );
  assertEquals(err.code, "preflight_manifest");
  assertStringIncludes(err.message, "Invalid TURBOPANEL_UPDATE_CHANNEL");
  assertStringIncludes(err.message, "re-run the installer on the host");
});

const DAEMON_RAIL = "https://github.com/TurboPanel/turbopaneld/releases";
const CANARY_POINTER = `${DAEMON_RAIL}/download/canary/manifest.json`;
const CANARY_BUILD_86 =
  `${DAEMON_RAIL}/download/canary/manifest-0.1.18-canary.86.json`;
const CANARY_BUILD_70 =
  `${DAEMON_RAIL}/download/canary/manifest-0.1.18-canary.70.json`;
const RC_POINTER = `${DAEMON_RAIL}/download/rc/manifest.json`;
const RELEASE_POINTER = `${DAEMON_RAIL}/latest/download/manifest.json`;
const TAG_0_1_18 = `${DAEMON_RAIL}/download/v0.1.18/manifest.json`;
const TAG_0_1_19_RC_1 = `${DAEMON_RAIL}/download/v0.1.19-rc.1/manifest.json`;

function manifestRefusal(fn: () => unknown): UpdatePreflightError {
  const err = assertThrows(fn, UpdatePreflightError);
  assertEquals(err.code, MANIFEST_PINNED_CODE);
  assertStringIncludes(err.message, "manifest_pinned: ");
  return err;
}

test("a message with no manifest URL needs no check", () => {
  for (const messageUrl of [undefined, null, "", "   "]) {
    for (const signedSession of [false, true]) {
      assertEquals(
        decideMessageManifest({
          kind: "daemon",
          channel: "canary",
          messageUrl,
          signedSession,
        }),
        { check: "none" },
      );
    }
  }
});

test("a signed session keeps naming any build on the rail", () => {
  for (const messageUrl of [CANARY_BUILD_70, RC_POINTER, TAG_0_1_18]) {
    assertEquals(
      decideMessageManifest({
        kind: "daemon",
        channel: "canary",
        messageUrl,
        signedSession: true,
      }),
      { check: "none" },
    );
  }
});

test("an unsigned message may name the channel's own manifest", () => {
  assertEquals(
    decideMessageManifest({
      kind: "daemon",
      channel: "canary",
      messageUrl: ` ${CANARY_POINTER} `,
      signedSession: false,
    }),
    { check: "none" },
  );
  assertEquals(
    decideMessageManifest({
      kind: "daemon",
      channel: "release",
      messageUrl: RELEASE_POINTER,
      signedSession: false,
    }),
    { check: "none" },
  );
});

test("an unsigned exact build is held to the channel's current build", () => {
  assertEquals(
    decideMessageManifest({
      kind: "daemon",
      channel: "canary",
      messageUrl: CANARY_BUILD_86,
      signedSession: false,
    }),
    { check: "head", headUrl: CANARY_POINTER },
  );
  assertEquals(
    decideMessageManifest({
      kind: "daemon",
      channel: "release",
      messageUrl: TAG_0_1_18,
      signedSession: false,
    }),
    { check: "head", headUrl: RELEASE_POINTER },
  );
  // Each package is held to its own rail.
  assertEquals(
    decideMessageManifest({
      kind: "ui",
      channel: "canary",
      messageUrl:
        "https://github.com/TurboPanel/ui/releases/download/canary/manifest-0.1.18-canary.107.json",
      signedSession: false,
    }),
    {
      check: "head",
      headUrl:
        "https://github.com/TurboPanel/ui/releases/download/canary/manifest.json",
    },
  );
});

test("an unsigned message cannot reach another channel through the URL", () => {
  const err = manifestRefusal(() =>
    decideMessageManifest({
      kind: "daemon",
      channel: "release",
      messageUrl: RC_POINTER,
      signedSession: false,
    })
  );
  assertStringIncludes(err.message, "release channel's own daemon manifest");
  manifestRefusal(() =>
    decideMessageManifest({
      kind: "daemon",
      channel: "canary",
      messageUrl: RELEASE_POINTER,
      signedSession: false,
    })
  );
});

test("an unsigned URL off the package's rail is refused", () => {
  for (
    const messageUrl of [
      "https://example.com/manifest.json",
      "https://github.com/TurboPanel/turbopanel/releases/download/canary/manifest-0.1.22-canary.171.json",
      `${DAEMON_RAIL}/download/canary/manifest-0.1.18-canary.86.json?x=1`,
    ]
  ) {
    manifestRefusal(() =>
      decideMessageManifest({
        kind: "daemon",
        channel: "canary",
        messageUrl,
        signedSession: false,
      })
    );
  }
});

test("a channel with no published manifest refuses every unsigned URL", () => {
  for (const channel of ["trunk", "edge"] as const) {
    const err = manifestRefusal(() =>
      decideMessageManifest({
        kind: "daemon",
        channel,
        messageUrl: CANARY_BUILD_86,
        signedSession: false,
      })
    );
    assertStringIncludes(err.message, "no published manifest");
  }
});

test("a development overlay host keeps its manifest handling", () => {
  assertEquals(
    decideMessageManifest({
      kind: "daemon",
      channel: "trunk",
      messageUrl: CANARY_BUILD_86,
      signedSession: false,
      overlay: true,
    }),
    { check: "none" },
  );
});

test("the channel's current build passes the head check", () => {
  assertMessageManifestIsChannelHead({
    kind: "daemon",
    channel: "canary",
    messageUrl: ` ${CANARY_BUILD_86} `,
    headVersion: " 0.1.18-canary.86 ",
  });
  assertMessageManifestIsChannelHead({
    kind: "daemon",
    channel: "release",
    messageUrl: TAG_0_1_18,
    headVersion: "0.1.18",
  });
  assertMessageManifestIsChannelHead({
    kind: "daemon",
    channel: "rc",
    messageUrl: TAG_0_1_19_RC_1,
    headVersion: "0.1.19-rc.1",
  });
});

test("an older or different build fails the head check", () => {
  const older = manifestRefusal(() =>
    assertMessageManifestIsChannelHead({
      kind: "daemon",
      channel: "canary",
      messageUrl: CANARY_BUILD_70,
      headVersion: "0.1.18-canary.86",
    })
  );
  assertStringIncludes(older.message, '"0.1.18-canary.86"');
  assertStringIncludes(older.message, "manifest-0.1.18-canary.70.json");
  assertStringIncludes(older.message, "--manifest-url");
  // A release-candidate tag is one exact build, but not the release
  // channel's current one.
  manifestRefusal(() =>
    assertMessageManifestIsChannelHead({
      kind: "daemon",
      channel: "release",
      messageUrl: TAG_0_1_19_RC_1,
      headVersion: "0.1.18",
    })
  );
  // A tagged build is not what the canary channel publishes.
  manifestRefusal(() =>
    assertMessageManifestIsChannelHead({
      kind: "daemon",
      channel: "canary",
      messageUrl: TAG_0_1_18,
      headVersion: "0.1.18",
    })
  );
});

test("a head manifest without a usable version proves nothing", () => {
  for (const headVersion of [undefined, null, "", "  ", "../canary"]) {
    const err = manifestRefusal(() =>
      assertMessageManifestIsChannelHead({
        kind: "daemon",
        channel: "canary",
        messageUrl: CANARY_BUILD_86,
        headVersion,
      })
    );
    assertStringIncludes(err.message, "canary channel publishes now");
  }
});
