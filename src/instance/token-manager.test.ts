import { encodeBase64Url } from "@std/encoding/base64url";
import { DaemonTokenManager } from "./token-manager.ts";
import type { DaemonKeyFile } from "../crypto/keys.ts";
import { DaemonApiError } from "./api-client.ts";
import { createFakeClock, flushMicrotasks } from "../testing/fake-clock.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function makeJwt(exp: number): string {
  const header = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ exp })),
  );
  return `${header}.${payload}.signature`;
}

async function makeKeyFile(): Promise<DaemonKeyFile> {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    algorithm: "Ed25519",
    keyId: "kid-test",
    createdAt: new Date().toISOString(),
    publicJwk,
    privateJwk,
  };
}

test("Returns cached token when not near expiry", async () => {
  const keyFile = await makeKeyFile();
  let challengeCalls = 0;
  const apiClient = {
    getAuthChallenge: async () => {
      await Promise.resolve();
      challengeCalls += 1;
      return { challengeId: "c1", nonce: "n1", at: "", expiresAt: "" };
    },
    createSession: () =>
      Promise.resolve({
        token: makeJwt(Math.floor(Date.now() / 1000) + 900),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: "machine-1",
    hostname: "host-1",
    apiClient,
  });

  await manager.getToken();
  await manager.getToken();
  if (challengeCalls !== 1) {
    throw new Error(`expected 1 challenge call, got ${challengeCalls}`);
  }
});

test("Refreshes when less than 60 s remain", async () => {
  const keyFile = await makeKeyFile();
  let challengeCalls = 0;
  let sessionCalls = 0;
  const apiClient = {
    getAuthChallenge: async () => {
      await Promise.resolve();
      challengeCalls += 1;
      return {
        challengeId: `c-${challengeCalls}`,
        nonce: `n-${challengeCalls}`,
        at: "",
        expiresAt: "",
      };
    },
    createSession: async () => {
      await Promise.resolve();
      sessionCalls += 1;
      return {
        token: sessionCalls === 1
          ? makeJwt(Math.floor(Date.now() / 1000) + 30)
          : makeJwt(Math.floor(Date.now() / 1000) + 900),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
    },
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: "machine-1",
    hostname: "host-1",
    apiClient,
  });

  await manager.getToken();
  await manager.getToken();
  if (challengeCalls !== 2) {
    throw new Error(`expected 2 challenge calls, got ${challengeCalls}`);
  }
});

test("Concurrent getToken() calls share one refresh promise", async () => {
  const keyFile = await makeKeyFile();
  let challengeCalls = 0;
  let release: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apiClient = {
    getAuthChallenge: async () => {
      challengeCalls += 1;
      await waitForRelease;
      return { challengeId: "c1", nonce: "n1", at: "", expiresAt: "" };
    },
    createSession: () =>
      Promise.resolve({
        token: makeJwt(Math.floor(Date.now() / 1000) + 900),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: "machine-1",
    hostname: "host-1",
    apiClient,
  });

  const one = manager.getToken();
  const two = manager.getToken();
  const three = manager.getToken();
  release?.();
  await Promise.all([one, two, three]);

  if (challengeCalls !== 1) {
    throw new Error(`expected 1 challenge call, got ${challengeCalls}`);
  }
});

test("Retries once on refresh failure before throwing", async () => {
  const clock = createFakeClock({ now: 1_000_000 });
  const restoreClock = clock.install();
  try {
    const keyFile = await makeKeyFile();
    let challengeCalls = 0;
    const apiClient = {
      getAuthChallenge: async () => {
        await Promise.resolve();
        challengeCalls += 1;
        if (challengeCalls === 1) {
          throw new Error("temporary failure");
        }
        return { challengeId: "c2", nonce: "n2", at: "", expiresAt: "" };
      },
      createSession: () =>
        Promise.resolve({
          token: makeJwt(Math.floor(Date.now() / 1000) + 900),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
    };
    const manager = new DaemonTokenManager({
      keyFile,
      serverId: "srv-1",
      keyId: "kid-1",
      machineKey: "machine-1",
      hostname: "host-1",
      apiClient,
      refreshEarlyMs: 0,
    });

    const tokenPromise = manager.getToken();
    for (let i = 0; i < 10 && challengeCalls < 1; i++) {
      await flushMicrotasks();
    }
    if (challengeCalls < 1) {
      throw new Error(
        `expected first challenge call before retry delay, got ${challengeCalls}`,
      );
    }

    const wallStart = performance.now();
    await clock.advance(2_000);
    const token = await tokenPromise;
    if (performance.now() - wallStart >= 500) {
      throw new Error(
        "expected fake-clock advance to drive retry without sleep",
      );
    }
    if (!token) {
      throw new Error("expected token after retry");
    }
    if (challengeCalls !== 2) {
      throw new Error(`expected 2 challenge calls, got ${challengeCalls}`);
    }
  } finally {
    restoreClock();
  }
});

test("verifyToken invalid hard-fails without retry", async () => {
  const keyFile = await makeKeyFile();
  let sessionCalls = 0;
  const apiClient = {
    getAuthChallenge: () =>
      Promise.resolve({
        challengeId: "c1",
        nonce: "n1",
        at: "",
        expiresAt: "",
      }),
    createSession: async () => {
      sessionCalls += 1;
      return await Promise.resolve({
        token: makeJwt(Math.floor(Date.now() / 1000) + 900),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    },
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: "machine-1",
    hostname: "host-1",
    apiClient,
    refreshEarlyMs: 0,
    verifyToken: () => Promise.resolve({ ok: false, reason: "invalid" }),
  });

  let threw = false;
  try {
    await manager.getToken();
  } catch (error) {
    threw = true;
    if (!(error instanceof Error)) {
      throw new Error("expected Error");
    }
    if (!error.message.includes("JWKS verification")) {
      throw new Error(`unexpected error: ${error.message}`);
    }
  }
  if (!threw) {
    throw new Error("expected getToken to throw on invalid verification");
  }
  if (sessionCalls !== 1) {
    throw new Error(
      `expected 1 session call without retry, got ${sessionCalls}`,
    );
  }
});

test("permanent first error skips 2s retry", async () => {
  const clock = createFakeClock({ now: 1_000_000 });
  const restoreClock = clock.install();
  try {
    const keyFile = await makeKeyFile();
    let challengeCalls = 0;
    const apiClient = {
      getAuthChallenge: async () => {
        await Promise.resolve();
        challengeCalls += 1;
        throw new DaemonApiError(401, "Invalid license");
      },
      createSession: () =>
        Promise.resolve({
          token: makeJwt(Math.floor(Date.now() / 1000) + 900),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
    };
    const manager = new DaemonTokenManager({
      keyFile,
      serverId: "srv-1",
      keyId: "kid-1",
      machineKey: "machine-1",
      hostname: "host-1",
      apiClient,
      refreshEarlyMs: 0,
    });

    let threw = false;
    try {
      await manager.getToken();
    } catch (error) {
      threw = true;
      if (!(error instanceof DaemonApiError) || error.status !== 401) {
        throw new Error(`unexpected error: ${String(error)}`);
      }
    }
    if (!threw) {
      throw new Error("expected getToken to throw on permanent failure");
    }
    if (challengeCalls !== 1) {
      throw new Error(
        `expected 1 challenge call without retry, got ${challengeCalls}`,
      );
    }
    // Advancing the fake clock must not trigger a second attempt.
    await clock.advance(2_000);
    await flushMicrotasks();
    if (challengeCalls !== 1) {
      throw new Error(
        `expected no delayed retry after permanent error, got ${challengeCalls}`,
      );
    }
  } finally {
    restoreClock();
  }
});

test("verifyToken unavailable still caches token", async () => {
  const keyFile = await makeKeyFile();
  const token = makeJwt(Math.floor(Date.now() / 1000) + 900);
  const apiClient = {
    getAuthChallenge: () =>
      Promise.resolve({
        challengeId: "c1",
        nonce: "n1",
        at: "",
        expiresAt: "",
      }),
    createSession: () =>
      Promise.resolve({
        token,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: "machine-1",
    hostname: "host-1",
    apiClient,
    verifyToken: () => Promise.resolve({ ok: false, reason: "unavailable" }),
  });

  const cached = await manager.getToken();
  if (cached !== token) {
    throw new Error("expected token to be cached despite unavailable JWKS");
  }
});

test("verifyToken sub mismatch hard-fails without retry", async () => {
  const keyFile = await makeKeyFile();
  let sessionCalls = 0;
  const apiClient = {
    getAuthChallenge: () =>
      Promise.resolve({
        challengeId: "c1",
        nonce: "n1",
        at: "",
        expiresAt: "",
      }),
    createSession: async () => {
      sessionCalls += 1;
      return await Promise.resolve({
        token: makeJwt(Math.floor(Date.now() / 1000) + 900),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    },
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: "machine-1",
    hostname: "host-1",
    apiClient,
    refreshEarlyMs: 0,
    verifyToken: () =>
      Promise.resolve({
        ok: true,
        claims: {
          sub: "other-server",
          kid: "kid-1",
          jti: "jti-1",
          iss: "turbopanel",
          aud: "turbopanel-daemon-api",
          typ: "daemon",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        },
      }),
  });

  let threw = false;
  try {
    await manager.getToken();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error("expected getToken to throw on sub mismatch");
  }
  if (sessionCalls !== 1) {
    throw new Error(
      `expected 1 session call without retry, got ${sessionCalls}`,
    );
  }
});

test("verifyToken kid mismatch hard-fails without retry", async () => {
  const keyFile = await makeKeyFile();
  let sessionCalls = 0;
  const apiClient = {
    getAuthChallenge: () =>
      Promise.resolve({
        challengeId: "c1",
        nonce: "n1",
        at: "",
        expiresAt: "",
      }),
    createSession: async () => {
      sessionCalls += 1;
      return await Promise.resolve({
        token: makeJwt(Math.floor(Date.now() / 1000) + 900),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    },
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: "machine-1",
    hostname: "host-1",
    apiClient,
    refreshEarlyMs: 0,
    verifyToken: () =>
      Promise.resolve({
        ok: true,
        claims: {
          sub: "srv-1",
          kid: "other-kid",
          jti: "jti-1",
          iss: "turbopanel",
          aud: "turbopanel-daemon-api",
          typ: "daemon",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        },
      }),
  });

  let threw = false;
  try {
    await manager.getToken();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error("expected getToken to throw on kid mismatch");
  }
  if (sessionCalls !== 1) {
    throw new Error(
      `expected 1 session call without retry, got ${sessionCalls}`,
    );
  }
});
