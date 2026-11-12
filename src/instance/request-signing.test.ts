import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  bodySha256B64u,
  buildAttachSigningInput,
  buildRequestSigningInput,
  DAEMON_SIGNATURE_HEADER,
  generateDaemonKeypair,
  signAttachProof,
  signDaemonRequest,
  verifyChallenge,
} from "../crypto/keys.ts";
import {
  createFakeInstanceApi,
  enrollResponse,
  sessionResponse,
} from "../testing/fake-instance-api.ts";
import { DaemonApiClient } from "./api-client.ts";

const test = Deno.test.bind(Deno);

const PANEL = "P".repeat(43);
const NOW_MS = Date.parse("2026-11-05T12:00:00.000Z");
const INSTANCE_CONFIG = {
  kind: "url" as const,
  baseUrl: "https://instance.test",
  wsBaseUrl: "wss://instance.test",
};

test("request signing input is fixed text, method upper-cased", () => {
  assertEquals(
    buildRequestSigningInput({
      method: "post",
      pathname: "/api/daemon/v1/ping",
      panelFingerprint: PANEL,
      nonce: "n",
      bodySha256: "h",
      iat: 1_800_000_000,
    }),
    `tp-request\nPOST\n/api/daemon/v1/ping\n${PANEL}\nn\nh\n1800000000`,
  );
});

test("the empty body hashes to the SHA-256 of zero bytes", async () => {
  assertEquals(
    await bodySha256B64u(""),
    "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  );
});

test("a signed request header verifies with the daemon's public key", async () => {
  const key = await generateDaemonKeypair();
  const header = await signDaemonRequest(
    { keyId: key.keyId, privateJwk: key.privateJwk },
    {
      method: "POST",
      pathname: "/api/daemon/v1/secrets/decrypt",
      body: '{"a":1}',
      panelFingerprint: PANEL,
      nowMs: NOW_MS,
    },
  );
  const [keyId, nonce, iat, sig] = header.split(":");
  assertEquals(keyId, key.keyId);
  assertMatch(nonce, /^[A-Za-z0-9_-]{22}$/);
  assertEquals(Number(iat), NOW_MS / 1000);
  const input = buildRequestSigningInput({
    method: "POST",
    pathname: "/api/daemon/v1/secrets/decrypt",
    panelFingerprint: PANEL,
    nonce,
    bodySha256: await bodySha256B64u('{"a":1}'),
    iat: Number(iat),
  });
  assert(await verifyChallenge(key.publicJwk, input, sig));
});

test("the attach proof is bound to the session and verifies", async () => {
  const key = await generateDaemonKeypair();
  const proof = await signAttachProof(
    { keyId: "key-1", privateJwk: key.privateJwk },
    { sessionId: "sess", panelFingerprint: PANEL, serverId: "srv" },
    NOW_MS,
  );
  assertEquals(proof.keyId, "key-1");
  assertEquals(proof.iat, NOW_MS / 1000);
  const input = buildAttachSigningInput({
    sessionId: "sess",
    panelFingerprint: PANEL,
    serverId: "srv",
    keyId: "key-1",
    iat: proof.iat,
  });
  assertEquals(input, `tp-attach\nsess\n${PANEL}\nsrv\nkey-1\n${proof.iat}`);
  assert(await verifyChallenge(key.publicJwk, input, proof.sig));
});

test({
  name:
    "the client signs authenticated calls and /auth/session, with a fresh value on the 401 retry",
  permissions: { net: true },
  fn: async () => {
    const api = createFakeInstanceApi();
    const restore = api.install();
    try {
      const seen: Array<{ path: string; signature: string | null }> = [];
      const record = (path: string, init?: RequestInit) =>
        seen.push({
          path,
          signature: new Headers(init?.headers).get(DAEMON_SIGNATURE_HEADER),
        });
      let metricsHits = 0;
      api.script("/api/daemon/v1/metrics", (init) => {
        record("metrics", init);
        metricsHits += 1;
        return metricsHits === 1
          ? new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          })
          : new Response(null, { status: 204 });
      });
      api.script("/api/daemon/v1/auth/session", (init) => {
        record("session", init);
        return sessionResponse();
      });
      api.script("/api/daemon/v1/enroll", (init) => {
        record("enroll", init);
        return enrollResponse();
      });
      const calls: Array<{ method: string; pathname: string; body: string }> =
        [];
      const client = new DaemonApiClient({
        config: INSTANCE_CONFIG,
        getToken: () => Promise.resolve("tok"),
        signRequest: (request) => {
          calls.push(request);
          return Promise.resolve(`sig-${calls.length}`);
        },
      });
      await client.sendHostMetrics({ n: 1 });
      await client.createSession(
        {
          serverId: "srv",
          keyId: "key",
          challengeId: "c",
          signature: "s",
          hostname: "h",
        } as Parameters<typeof client.createSession>[0],
      );
      await client.enroll(
        {} as Parameters<typeof client.enroll>[0],
      );
      assertEquals(seen, [
        { path: "metrics", signature: "sig-1" },
        { path: "metrics", signature: "sig-2" },
        { path: "session", signature: "sig-3" },
        { path: "enroll", signature: null },
      ]);
      assertEquals(calls[0], {
        method: "POST",
        pathname: "/api/daemon/v1/metrics",
        body: JSON.stringify({ n: 1 }),
      });
      assertEquals(calls[2]?.pathname, "/api/daemon/v1/auth/session");
    } finally {
      restore();
    }
  },
});

test({
  name: "no header is sent when the signer has no pinned key",
  permissions: { net: true },
  fn: async () => {
    const api = createFakeInstanceApi();
    const restore = api.install();
    try {
      let signature: string | null = "unset";
      api.script("/api/daemon/v1/ping", (init) => {
        signature = new Headers(init?.headers).get(DAEMON_SIGNATURE_HEADER);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const client = new DaemonApiClient({
        config: INSTANCE_CONFIG,
        getToken: () => Promise.resolve("tok"),
        signRequest: () => Promise.resolve(null),
      });
      await client.ping();
      assertEquals(signature, null);
    } finally {
      restore();
    }
  },
});
