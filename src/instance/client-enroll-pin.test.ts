import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { InstanceClient } from "./client.ts";
import { wireCommandPorts } from "../commands/wire.ts";
import { resolveServerIdentityDir } from "./sockets.ts";
import {
  challengeResponse,
  createFakeInstanceApi,
  enrollResponse,
  installTrackingWebSocket,
  withTempLayout,
} from "../testing/index.ts";
import { waitFor } from "../testing/wait-for.ts";
import { createTestPanel } from "../testing/panel-signing.ts";

wireCommandPorts();

const test = Deno.test.bind(Deno);

const LAYOUT_ENV_KEYS = [
  "TURBOPANEL_CONFIG_DIR",
  "TURBOPANEL_STATE_DIR",
  "TURBOPANEL_LOG_DIR",
  "TURBOPANEL_BACKUP_DIR",
  "TURBOPANEL_RUN_DIR",
  "TURBOPANEL_DAEMON_STATE_DIR",
  "TURBOPANEL_RUNTIMES_DIR",
  "TURBOPANEL_HOME",
];

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}

type Scenario = "keyset-below-the-pin" | "signed-by-an-unpinned-key";

/**
 * A pinned server with no key files, so it enrolls. The first identity
 * document (the connect-time check) is good; the one the enroll step fetches
 * is not. The enroll must abort before the challenge and the license leave.
 */
async function enrollWithBadSecondDocument(
  scenario: Scenario,
): Promise<{ challenges: number; enrolls: number; documents: number }> {
  const saved = [...LAYOUT_ENV_KEYS, "TURBOPANEL_LIB_DIR"].map(
    (key) => [key, Deno.env.get(key)] as const,
  );
  const { restore: restoreWebSocket } = installTrackingWebSocket();
  let restoreFetch: (() => void) | undefined;
  const seen = { challenges: 0, enrolls: 0, documents: 0 };
  try {
    // The pin names keyset 2; the good document has it.
    const panel = await createTestPanel(2);
    const other = await createTestPanel(2);
    const api = createFakeInstanceApi();
    api.script(
      "/api/health",
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    api.script("/api/daemon/v1/instance/identity", async () => {
      seen.documents += 1;
      const doc = seen.documents === 1
        ? await panel.identityFetch({ nowMs: Date.now() })
        : scenario === "keyset-below-the-pin"
        ? await panel.identityFetch({ nowMs: Date.now(), keyset: 1 })
        : await other.identityFetch({ nowMs: Date.now() });
      return new Response(doc.body, {
        status: 200,
        headers: { "x-turbopanel-signature": doc.signature! },
      });
    });
    api.script("/api/daemon/v1/auth/challenge", () => {
      seen.challenges += 1;
      return panel.signedResponse(
        "/api/daemon/v1/auth/challenge",
        challengeResponse(),
      );
    });
    api.script("/api/daemon/v1/enroll", () => {
      seen.enrolls += 1;
      return panel.signedResponse(
        "/api/daemon/v1/enroll",
        enrollResponse(),
      );
    });
    restoreFetch = api.install();

    await withTempLayout(async (fixture) => {
      const stateDir = fixture.dirs.stateDir;
      const libDir = join(stateDir, "..", "lib");
      await Deno.mkdir(libDir, { recursive: true });
      await Deno.writeTextFile(
        join(libDir, "panel-identity"),
        [
          `current=${panel.kid}`,
          "next=",
          "keyset=2",
          "urls=https://instance.test",
          "pinned_by=install",
          "updated=2026-11-01T00:00:00Z",
          "",
        ].join("\n"),
      );
      for (const [key, value] of Object.entries(fixture.env)) {
        Deno.env.set(key, value);
      }
      Deno.env.set("TURBOPANEL_LIB_DIR", libDir);
      const identityDir = resolveServerIdentityDir(Deno.env.toObject());
      await Deno.mkdir(identityDir, { recursive: true });
      await Deno.writeTextFile(join(identityDir, "license.id"), "lic-1\n");
      await Deno.writeTextFile(
        join(identityDir, ["license", "token"].join(".")),
        "fixture-secret\n",
      );
      const client = new InstanceClient({
        config: {
          kind: "url",
          baseUrl: "https://instance.test",
          wsBaseUrl: "wss://instance.test",
        },
      });
      try {
        client.start();
        await waitFor(
          "the enroll step's document fetch",
          () => seen.documents >= 2,
        );
        // Give a wrongly continuing enroll time to reach the challenge.
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        client.stop();
      }
    });
  } finally {
    restoreFetch?.();
    restoreWebSocket();
    for (const [key, value] of saved) setOptionalEnv(key, value);
  }
  return seen;
}

for (
  const scenario of [
    "keyset-below-the-pin",
    "signed-by-an-unpinned-key",
  ] as const
) {
  test({
    name:
      `a pinned enroll aborts, sends nothing, when its document is ${scenario}`,
    permissions: "inherit",
    fn: async () => {
      const seen = await enrollWithBadSecondDocument(scenario);
      assertEquals(
        seen.documents,
        2,
        "the enroll step fetched its own document",
      );
      assertEquals(seen.challenges, 0, "no challenge was requested");
      assertEquals(seen.enrolls, 0, "the license was never sent");
    },
  });
}
