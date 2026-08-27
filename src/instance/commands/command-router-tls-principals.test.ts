import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { fingerprintPemCertificate, splitPemBundle } from "../paths.ts";
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

async function mintCert(dir: string, cn: string): Promise<string> {
  const keyPath = join(dir, `${cn}.key`);
  const certPath = join(dir, `${cn}.crt`);
  const gen = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      `/CN=${cn}`,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!gen.success) {
    throw new Error(`openssl failed: ${new TextDecoder().decode(gen.stderr)}`);
  }
  return await Deno.readTextFile(certPath);
}

function dispatchMessage(
  commandType: string,
  payload: unknown,
): CommandDispatchMessage {
  const id = crypto.randomUUID();
  return {
    type: "command-dispatch",
    id,
    commandId: crypto.randomUUID(),
    commandType,
    payload,
    at: new Date().toISOString(),
  };
}

test({
  name:
    "handleCommandDispatch routes server.tls.trust.reconcile and writes the CA",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const dir = await Deno.makeTempDir({ prefix: "tp-router-tls-" });
    const previous = Deno.env.get("TURBOPANEL_INSTANCE_CA");
    try {
      const cert = await mintCert(dir, "router-ca");
      const caPath = join(dir, "instance-ca.pem");
      // resolveInstanceCaPath only honors the env override when the file exists.
      await Deno.writeTextFile(caPath, cert);
      Deno.env.set("TURBOPANEL_INSTANCE_CA", caPath);
      const fingerprint = await fingerprintPemCertificate(cert);

      const ws = new MockWebSocket() as unknown as WebSocket;
      await handleCommandDispatch(
        dispatchMessage("server.tls.trust.reconcile", {
          bundlePem: cert,
          fingerprint,
        }),
        ws,
      );

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.type, "command-outcome");
      assertEquals(frames[1]?.ok, true);
      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.applied, true);
      assertEquals(result.fingerprint, fingerprint);
      const written = await Deno.readTextFile(caPath);
      assertEquals(splitPemBundle(written).length, 1);
    } finally {
      if (previous === undefined) Deno.env.delete("TURBOPANEL_INSTANCE_CA");
      else Deno.env.set("TURBOPANEL_INSTANCE_CA", previous);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "handleCommandDispatch rejects malformed server.principals.reconcile payloads",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleCommandDispatch(
      dispatchMessage("server.principals.reconcile", { principals: "all" }),
      ws,
    );
    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames[1]?.ok, false);
    assertMatch(String(frames[1]?.error), /principals must be an array/);
  },
});

test({
  name: "handleCommandDispatch builds a real log sink when send is provided",
  permissions: { env: true, sys: ["hostname"], read: true, write: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const root = await Deno.makeTempDir({ prefix: "tp-router-sink-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_DAEMON_STATE_DIR: Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR"),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", join(root, "state"));
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      await handleCommandDispatch(
        dispatchMessage("daemon.ping", {}),
        ws,
        {
          sendCommandLogChunk: (params) =>
            Promise.resolve({ nextSeq: params.seq + 1 }),
        },
      );
      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[1]?.ok, true);
      assertEquals(typeof frames[1]?.result, "object");
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_DAEMON_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_DAEMON_STATE_DIR");
      } else {
        Deno.env.set(
          "TURBOPANEL_DAEMON_STATE_DIR",
          previous.TURBOPANEL_DAEMON_STATE_DIR,
        );
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleCommandDispatch rejects invalid server.tls.trust.reconcile payloads",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleCommandDispatch(
      dispatchMessage("server.tls.trust.reconcile", {
        bundlePem: "not-a-pem-bundle",
        fingerprint: "sha256:abc",
      }),
      ws,
    );
    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames[1]?.ok, false);
    assertMatch(
      String(frames[1]?.error),
      /bundlePem must contain at least one certificate/,
    );
  },
});
