import { assertEquals, assertRejects } from "@std/assert";
import {
  challengeResponse,
  createFakeInstanceApi,
  enrollResponse,
  jwksResponse,
  permanentAuthErrorResponse,
  permanentEnrollmentErrorResponse,
  serverKeyMismatchResponse,
  sessionResponse,
  staleIdentityErrorResponse,
} from "../testing/fake-instance-api.ts";
import { createTestSigningKey } from "../testing/jwks-test-helpers.ts";
import {
  DaemonApiClient,
  DaemonApiError,
  MAX_SECRETS_DECRYPT_BATCH,
  MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS,
} from "./api-client.ts";
import { classifyConnectFailure } from "./connect-failure.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const INSTANCE_CONFIG = {
  kind: "url" as const,
  baseUrl: "https://instance.test",
  wsBaseUrl: "wss://instance.test",
};

type Captured = {
  pathSuffix: string;
  method: string;
  contentType: string | null;
  authorization: string | null;
};

function captureInit(
  pathSuffix: string,
  captures: Captured[],
  buildResponse: () => Response,
): (init?: RequestInit) => Response {
  return (init) => {
    const headers = new Headers(init?.headers);
    captures.push({
      pathSuffix,
      method: init?.method ?? "GET",
      contentType: headers.get("content-type"),
      authorization: headers.get("authorization"),
    });
    return buildResponse();
  };
}

test({
  name: "DaemonApiClient methods hit expected paths with JSON content-type",
  permissions: { net: true },
  fn: async () => {
    const api = createFakeInstanceApi();
    const restore = api.install();
    const captures: Captured[] = [];
    try {
      api.script(
        "/api/daemon/v1/auth/challenge",
        captureInit(
          "/api/daemon/v1/auth/challenge",
          captures,
          () => challengeResponse(),
        ),
      );
      api.script(
        "/api/daemon/v1/enroll",
        captureInit("/api/daemon/v1/enroll", captures, () => enrollResponse()),
      );
      api.script(
        "/api/daemon/v1/auth/session",
        captureInit(
          "/api/daemon/v1/auth/session",
          captures,
          () => sessionResponse(),
        ),
      );
      api.script(
        "/api/daemon/v1/jwks.json",
        captureInit(
          "/api/daemon/v1/jwks.json",
          captures,
          () => new Response(JSON.stringify({ keys: [] }), { status: 200 }),
        ),
      );
      api.script(
        "/api/daemon/v1/metrics",
        captureInit(
          "/api/daemon/v1/metrics",
          captures,
          () => new Response(null, { status: 204 }),
        ),
      );
      api.script(
        "/api/daemon/v1/secrets/decrypt",
        captureInit(
          "/api/daemon/v1/secrets/decrypt",
          captures,
          () =>
            new Response(JSON.stringify({ plaintexts: ["a"] }), {
              status: 200,
            }),
        ),
      );

      const client = new DaemonApiClient({
        config: INSTANCE_CONFIG,
        getToken: () => Promise.resolve("tok"),
      });

      await client.getEnrollmentChallenge();
      await client.getAuthChallenge({ serverId: "s1", keyId: "k1" });
      await client.enroll({
        licenseId: "lic",
        licenseToken: "ltok",
        hostname: "h",
        publicJwk: { kty: "OKP" },
        challengeId: "c1",
        signature: "sig",
      });
      await client.createSession({
        serverId: "s1",
        keyId: "k1",
        challengeId: "c1",
        signature: "sig",
        hostname: "h",
        at: new Date().toISOString(),
      });
      await client.getJwks();
      await client.sendHostMetrics({ cpu: 1 });
      await client.decryptSecrets(["tpdaemon.v1.x"]);

      const byPath = Object.fromEntries(
        captures.map((c) => [c.pathSuffix, c]),
      );
      assertEquals(byPath["/api/daemon/v1/auth/challenge"]?.method, "POST");
      assertEquals(byPath["/api/daemon/v1/enroll"]?.method, "POST");
      assertEquals(byPath["/api/daemon/v1/auth/session"]?.method, "POST");
      assertEquals(byPath["/api/daemon/v1/jwks.json"]?.method, "GET");
      assertEquals(byPath["/api/daemon/v1/metrics"]?.method, "POST");
      assertEquals(byPath["/api/daemon/v1/secrets/decrypt"]?.method, "POST");
      for (const c of captures) {
        assertEquals(c.contentType, "application/json");
      }
      // challenge is scripted once; getEnrollmentChallenge + getAuthChallenge
      // both hit it — two captures share the same pathSuffix last-wins above.
      assertEquals(
        captures.filter((c) => c.pathSuffix === "/api/daemon/v1/auth/challenge")
          .length,
        2,
      );
    } finally {
      restore();
    }
  },
});

test({
  name: "DaemonApiClient auth paths set Bearer and retry once on 401",
  permissions: { net: true },
  fn: async () => {
    const api = createFakeInstanceApi();
    const restore = api.install();
    try {
      let tokenCalls = 0;
      const tokens: string[] = [];
      const getToken = (options?: { forceRefresh?: boolean }) => {
        tokenCalls += 1;
        const token = options?.forceRefresh ? "refreshed" : "initial";
        tokens.push(token);
        return Promise.resolve(token);
      };

      let metricsHits = 0;
      api.script("/api/daemon/v1/metrics", (init) => {
        metricsHits += 1;
        const auth = new Headers(init?.headers).get("authorization");
        if (metricsHits === 1) {
          assertEquals(auth, "Bearer initial");
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          });
        }
        assertEquals(auth, "Bearer refreshed");
        return new Response(null, { status: 204 });
      });

      let decryptHits = 0;
      api.script("/api/daemon/v1/secrets/decrypt", (init) => {
        decryptHits += 1;
        const auth = new Headers(init?.headers).get("authorization");
        assertEquals(auth, "Bearer initial");
        return new Response(JSON.stringify({ plaintexts: ["ok"] }), {
          status: 200,
        });
      });

      const client = new DaemonApiClient({
        config: INSTANCE_CONFIG,
        getToken,
      });

      await client.sendHostMetrics({ n: 1 });
      assertEquals(metricsHits, 2);
      assertEquals(tokenCalls, 2);
      assertEquals(tokens, ["initial", "refreshed"]);

      tokenCalls = 0;
      tokens.length = 0;
      await client.decryptSecrets(["tpdaemon.v1.a"]);
      assertEquals(decryptHits, 1);
      assertEquals(tokenCalls, 1);
      assertEquals(tokens, ["initial"]);
    } finally {
      restore();
    }
  },
});

test({
  name: "DaemonApiClient error mapping feeds classifyConnectFailure kinds",
  permissions: { net: true },
  fn: async () => {
    const cases: Array<{
      path: string;
      response: Response;
      expectedStatus: number;
      expectedMessage: string;
      expectedKind: ReturnType<typeof classifyConnectFailure>["kind"];
      call: (client: DaemonApiClient) => Promise<unknown>;
    }> = [
      {
        path: "/api/daemon/v1/enroll",
        response: permanentEnrollmentErrorResponse("invalid-license"),
        expectedStatus: 401,
        expectedMessage: "Invalid license",
        expectedKind: "permanent",
        call: (c) =>
          c.enroll({
            licenseId: "l",
            licenseToken: "t",
            hostname: "h",
            publicJwk: { kty: "OKP" },
            challengeId: "c",
            signature: "s",
          }),
      },
      {
        path: "/api/daemon/v1/auth/session",
        response: permanentAuthErrorResponse("license-inactive"),
        expectedStatus: 400,
        expectedMessage: "License is inactive",
        expectedKind: "permanent",
        call: (c) =>
          c.createSession({
            serverId: "s",
            keyId: "k",
            challengeId: "c",
            signature: "s",
            hostname: "h",
            at: new Date().toISOString(),
          }),
      },
      {
        path: "/api/daemon/v1/auth/session",
        response: staleIdentityErrorResponse(),
        expectedStatus: 404,
        expectedMessage: "Server key not found",
        expectedKind: "stale-identity",
        call: (c) =>
          c.createSession({
            serverId: "s",
            keyId: "k",
            challengeId: "c",
            signature: "s",
            hostname: "h",
            at: new Date().toISOString(),
          }),
      },
      {
        path: "/api/daemon/v1/auth/session",
        response: serverKeyMismatchResponse(),
        expectedStatus: 400,
        expectedMessage: "Server key mismatch",
        expectedKind: "stale-identity",
        call: (c) =>
          c.createSession({
            serverId: "s",
            keyId: "k",
            challengeId: "c",
            signature: "s",
            hostname: "h",
            at: new Date().toISOString(),
          }),
      },
      {
        path: "/api/daemon/v1/auth/challenge",
        response: new Response(
          JSON.stringify({ error: "Service Unavailable" }),
          { status: 503 },
        ),
        expectedStatus: 503,
        expectedMessage: "Service Unavailable",
        expectedKind: "transient",
        call: (c) => c.getEnrollmentChallenge(),
      },
      {
        path: "/api/daemon/v1/auth/challenge",
        response: new Response(
          JSON.stringify({ error: "Too Many Requests" }),
          { status: 429 },
        ),
        expectedStatus: 429,
        expectedMessage: "Too Many Requests",
        expectedKind: "transient",
        call: (c) => c.getEnrollmentChallenge(),
      },
      {
        path: "/api/daemon/v1/auth/challenge",
        response: new Response(
          JSON.stringify({ error: "Invalid or expired challenge" }),
          { status: 400 },
        ),
        expectedStatus: 400,
        expectedMessage: "Invalid or expired challenge",
        expectedKind: "transient",
        call: (c) => c.getEnrollmentChallenge(),
      },
    ];

    for (const entry of cases) {
      const api = createFakeInstanceApi();
      const restore = api.install();
      try {
        api.script(entry.path, () => entry.response);
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("tok"),
        });
        const err = await assertRejects(
          () => entry.call(client),
          DaemonApiError,
        );
        assertEquals(err.status, entry.expectedStatus, entry.expectedMessage);
        assertEquals(err.message, entry.expectedMessage);
        assertEquals(
          classifyConnectFailure(err).kind,
          entry.expectedKind,
          entry.expectedMessage,
        );
      } finally {
        restore();
      }
    }
  },
});

test({
  name: "DaemonApiClient getJwks returns scripted JWKS keys",
  permissions: { net: true },
  fn: async () => {
    const signing = await createTestSigningKey();
    const api = createFakeInstanceApi();
    const restore = api.install();
    try {
      api.script("/api/daemon/v1/jwks.json", () => jwksResponse(signing));
      const client = new DaemonApiClient({
        config: INSTANCE_CONFIG,
        getToken: () => Promise.resolve("tok"),
      });
      const doc = await client.getJwks();
      assertEquals(doc.keys, signing.jwks.keys);
    } finally {
      restore();
    }
  },
});

test({
  name:
    "decryptSecrets rejects empty, oversized batch, and oversized ciphertext locally",
  fn: async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response("{}"));
      },
    });
    try {
      const client = new DaemonApiClient({
        config: INSTANCE_CONFIG,
        getToken: () => Promise.resolve("tok"),
      });

      const empty = await assertRejects(
        () => client.decryptSecrets([]),
        DaemonApiError,
      );
      assertEquals(empty.status, 400);

      const oversized = await assertRejects(
        () =>
          client.decryptSecrets(
            Array.from(
              { length: MAX_SECRETS_DECRYPT_BATCH + 1 },
              () => "tpdaemon.v1.x",
            ),
          ),
        DaemonApiError,
      );
      assertEquals(oversized.status, 400);

      const huge = "x".repeat(MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS + 1);
      const tooLong = await assertRejects(
        () => client.decryptSecrets([huge]),
        DaemonApiError,
      );
      assertEquals(tooLong.status, 400);
      assertEquals(fetchCalls, 0, "guard rails must run before fetch");
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  },
});
