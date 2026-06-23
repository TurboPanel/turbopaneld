import { encodeBase64Url } from "@std/encoding/base64url";
import { DaemonTokenManager } from "./token-manager.ts";
import type { DaemonKeyFile } from "../crypto/keys.ts";

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

Deno.test("Returns cached token when not near expiry", async () => {
  const keyFile = await makeKeyFile();
  let challengeCalls = 0;
  const apiClient = {
    getAuthChallenge: async () => {
      challengeCalls += 1;
      return { challengeId: "c1", nonce: "n1", at: "", expiresAt: "" };
    },
    createSession: async () => ({
      token: makeJwt(Math.floor(Date.now() / 1000) + 900),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineId: "machine-1",
    hostname: "host-1",
    apiClient,
  });

  await manager.getToken();
  await manager.getToken();
  if (challengeCalls !== 1) {
    throw new Error(`expected 1 challenge call, got ${challengeCalls}`);
  }
});

Deno.test("Refreshes when less than 60 s remain", async () => {
  const keyFile = await makeKeyFile();
  let challengeCalls = 0;
  let sessionCalls = 0;
  const apiClient = {
    getAuthChallenge: async () => {
      challengeCalls += 1;
      return {
        challengeId: `c-${challengeCalls}`,
        nonce: `n-${challengeCalls}`,
        at: "",
        expiresAt: "",
      };
    },
    createSession: async () => {
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
    machineId: "machine-1",
    hostname: "host-1",
    apiClient,
  });

  await manager.getToken();
  await manager.getToken();
  if (challengeCalls !== 2) {
    throw new Error(`expected 2 challenge calls, got ${challengeCalls}`);
  }
});

Deno.test("Concurrent getToken() calls share one refresh promise", async () => {
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
    createSession: async () => ({
      token: makeJwt(Math.floor(Date.now() / 1000) + 900),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineId: "machine-1",
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

Deno.test("Retries once on refresh failure before throwing", async () => {
  const keyFile = await makeKeyFile();
  let challengeCalls = 0;
  const apiClient = {
    getAuthChallenge: async () => {
      challengeCalls += 1;
      if (challengeCalls === 1) {
        throw new Error("temporary failure");
      }
      return { challengeId: "c2", nonce: "n2", at: "", expiresAt: "" };
    },
    createSession: async () => ({
      token: makeJwt(Math.floor(Date.now() / 1000) + 900),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
  };
  const manager = new DaemonTokenManager({
    keyFile,
    serverId: "srv-1",
    keyId: "kid-1",
    machineId: "machine-1",
    hostname: "host-1",
    apiClient,
    refreshEarlyMs: 0,
  });

  const token = await manager.getToken();
  if (!token) {
    throw new Error("expected token after retry");
  }
  if (challengeCalls !== 2) {
    throw new Error(`expected 2 challenge calls, got ${challengeCalls}`);
  }
});
