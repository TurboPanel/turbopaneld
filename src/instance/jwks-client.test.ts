import { it } from "@std/testing/bdd";
import { DaemonJwksClient, type InstanceJwtClaims } from "./jwks-client.ts";
import {
  createTestSigningKey,
  signInstanceJwt,
} from "../testing/jwks-test-helpers.ts";
import type { JwksDocument } from "./api-client.ts";

function makeClient(
  jwks: JwksDocument,
  options?: {
    getJwks?: () => Promise<JwksDocument>;
    minRefreshIntervalMs?: number;
  },
): { client: DaemonJwksClient; getJwksCalls: () => number } {
  let calls = 0;
  const client = new DaemonJwksClient({
    apiClient: {
      getJwks: options?.getJwks ?? (() => {
        calls += 1;
        return Promise.resolve(jwks);
      }),
    },
    refreshTtlMs: 3_600_000,
    minRefreshIntervalMs: options?.minRefreshIntervalMs ?? 60_000,
  });
  return { client, getJwksCalls: () => calls };
}

it("valid token verifies and cache hit avoids refetch", async () => {
  const { kid, privateKey, jwks } = await createTestSigningKey();
  const { client, getJwksCalls } = makeClient(jwks);
  const token = await signInstanceJwt(privateKey, kid, {
    sub: "server-1",
    kid: "daemon-key-1",
  });

  const first = await client.verifyInstanceJwt(token);
  const second = await client.verifyInstanceJwt(token);

  if (!first.ok || !second.ok) {
    throw new Error("expected both verifications to succeed");
  }
  if (first.claims.sub !== "server-1") {
    throw new Error("expected sub claim server-1");
  }
  if (getJwksCalls() !== 1) {
    throw new Error(`expected 1 JWKS fetch, got ${getJwksCalls()}`);
  }
});

it("unknown kid triggers exactly one refresh and is bounded", async () => {
  const primary = await createTestSigningKey();
  const secondary = await createTestSigningKey();
  let calls = 0;
  const { client } = makeClient(primary.jwks, {
    getJwks: async () => {
      await Promise.resolve();
      calls += 1;
      return calls === 1 ? primary.jwks : secondary.jwks;
    },
    minRefreshIntervalMs: 60_000,
  });

  const unknownKidToken = await signInstanceJwt(
    secondary.privateKey,
    secondary.kid,
    { sub: "server-1", kid: "daemon-key-1" },
  );

  const first = await client.verifyInstanceJwt(unknownKidToken);
  const second = await client.verifyInstanceJwt(unknownKidToken);

  if (!first.ok || !second.ok) {
    throw new Error("expected verification to succeed after refresh");
  }
  if (calls !== 2) {
    throw new Error(`expected 2 JWKS fetches, got ${calls}`);
  }

  const third = await client.verifyInstanceJwt(unknownKidToken);
  if (!third.ok) {
    throw new Error("expected cached verification to succeed");
  }
  if (calls !== 2) {
    throw new Error(
      `expected no extra JWKS fetch within min interval, got ${calls}`,
    );
  }
});

it("concurrent verifyInstanceJwt shares one in-flight JWKS refresh", async () => {
  const primary = await createTestSigningKey();
  const secondary = await createTestSigningKey();
  let calls = 0;
  const getCalls = (): number => calls;
  let release: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { client } = makeClient(primary.jwks, {
    getJwks: async () => {
      calls += 1;
      const callNumber = calls;
      await waitForRelease;
      // First (shared) refresh returns primary; a later unknown-kid retry
      // (after release) may fetch secondary — still one call per refresh.
      return callNumber === 1 ? primary.jwks : secondary.jwks;
    },
    minRefreshIntervalMs: 60_000,
  });

  const token = await signInstanceJwt(
    primary.privateKey,
    primary.kid,
    { sub: "server-1", kid: "daemon-key-1" },
  );

  const one = client.verifyInstanceJwt(token);
  const two = client.verifyInstanceJwt(token);
  const three = client.verifyInstanceJwt(token);

  // All three must be blocked on the same in-flight getJwks before release.
  for (let i = 0; i < 20 && getCalls() < 1; i++) {
    await Promise.resolve();
  }
  if (getCalls() !== 1) {
    throw new Error(
      `expected single in-flight getJwks before release, got ${getCalls()}`,
    );
  }

  release?.();
  const results = await Promise.all([one, two, three]);
  for (const result of results) {
    if (!result.ok) {
      throw new Error("expected concurrent verifications to succeed");
    }
  }
  if (getCalls() !== 1) {
    throw new Error(
      `expected concurrent verifiers to share one refresh, got ${getCalls()}`,
    );
  }

  // Bounded unknown-kid retry: exactly one more refresh, then min-interval
  // throttle (mirrors the sequential case around this concurrent path).
  const unknownKidToken = await signInstanceJwt(
    secondary.privateKey,
    secondary.kid,
    { sub: "server-1", kid: "daemon-key-1" },
  );
  const afterRefresh = await client.verifyInstanceJwt(unknownKidToken);
  if (!afterRefresh.ok) {
    throw new Error(
      "expected verification to succeed after unknown-kid refresh",
    );
  }
  if (getCalls() !== 2) {
    throw new Error(
      `expected 2 JWKS fetches after unknown-kid, got ${getCalls()}`,
    );
  }
  const throttled = await client.verifyInstanceJwt(unknownKidToken);
  if (!throttled.ok) {
    throw new Error("expected cached verification after unknown-kid refresh");
  }
  if (getCalls() !== 2) {
    throw new Error(
      `expected min-refresh-interval to block further refetch, got ${getCalls()}`,
    );
  }
});

it("expired token returns invalid", async () => {
  const { kid, privateKey, jwks } = await createTestSigningKey();
  const { client } = makeClient(jwks);
  const token = await signInstanceJwt(privateKey, kid, {
    sub: "server-1",
    kid: "daemon-key-1",
    exp: Math.floor(Date.now() / 1000) - 60,
  });

  const result = await client.verifyInstanceJwt(token);
  if (result.ok || result.reason !== "invalid") {
    throw new Error("expected invalid result for expired token");
  }
});

it("bad signature returns invalid", async () => {
  const { encodeBase64Url } = await import("@std/encoding/base64url");
  const { kid, privateKey, jwks } = await createTestSigningKey();
  const { client } = makeClient(jwks);
  const token = await signInstanceJwt(privateKey, kid, {
    sub: "server-1",
    kid: "daemon-key-1",
  });
  const parts = token.split(".");
  parts[2] = encodeBase64Url(new Uint8Array(64));
  const tampered = parts.join(".");

  const result = await client.verifyInstanceJwt(tampered);
  if (result.ok || result.reason !== "invalid") {
    throw new Error("expected invalid result for bad signature");
  }
});

it("wrong iss aud typ return invalid", async () => {
  const { kid, privateKey, jwks } = await createTestSigningKey();
  const { client } = makeClient(jwks);

  for (
    const overrides of [
      { iss: "wrong" },
      { aud: "wrong" },
      { typ: "wrong" },
    ] as const
  ) {
    const token = await signInstanceJwt(privateKey, kid, {
      sub: "server-1",
      kid: "daemon-key-1",
      ...overrides,
    });
    const result = await client.verifyInstanceJwt(token);
    if (result.ok || result.reason !== "invalid") {
      throw new Error(`expected invalid for ${JSON.stringify(overrides)}`);
    }
  }
});

it("getJwks throws with empty cache returns unavailable", async () => {
  const client = new DaemonJwksClient({
    apiClient: {
      getJwks: async () => {
        await Promise.resolve();
        throw new Error("network down");
      },
    },
  });

  const { kid, privateKey } = await createTestSigningKey();
  const validToken = await signInstanceJwt(privateKey, kid, {
    sub: "server-1",
    kid: "daemon-key-1",
  });
  const unavailable = await client.verifyInstanceJwt(validToken);
  if (unavailable.ok || unavailable.reason !== "unavailable") {
    throw new Error(
      "expected unavailable when JWKS fetch fails with empty cache",
    );
  }
});

it("getJwks throws with expired token returns invalid not unavailable", async () => {
  const client = new DaemonJwksClient({
    apiClient: {
      getJwks: async () => {
        await Promise.resolve();
        throw new Error("network down");
      },
    },
  });

  const { kid, privateKey } = await createTestSigningKey();
  const expiredToken = await signInstanceJwt(privateKey, kid, {
    sub: "server-1",
    kid: "daemon-key-1",
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  const result = await client.verifyInstanceJwt(expiredToken);
  if (result.ok || result.reason !== "invalid") {
    throw new Error("expected invalid for expired token even when JWKS fails");
  }
});

it("getJwks throws with wrong iss aud typ returns invalid", async () => {
  const client = new DaemonJwksClient({
    apiClient: {
      getJwks: async () => {
        await Promise.resolve();
        throw new Error("network down");
      },
    },
  });

  const { kid, privateKey } = await createTestSigningKey();

  for (
    const overrides of [
      { iss: "wrong" },
      { aud: "wrong" },
      { typ: "wrong" },
    ] as const
  ) {
    const token = await signInstanceJwt(privateKey, kid, {
      sub: "server-1",
      kid: "daemon-key-1",
      ...overrides,
    });
    const result = await client.verifyInstanceJwt(token);
    if (result.ok || result.reason !== "invalid") {
      throw new Error(
        `expected invalid for ${JSON.stringify(overrides)} when JWKS fails`,
      );
    }
  }
});

it("empty sub or kid claim returns invalid", async () => {
  const { kid, privateKey, jwks } = await createTestSigningKey();
  const { client } = makeClient(jwks);

  for (
    const claimOverrides of [
      { sub: "", kid: "daemon-key-1" },
      { sub: "server-1", kid: "" },
    ] satisfies Array<Pick<InstanceJwtClaims, "sub" | "kid">>
  ) {
    const token = await signInstanceJwt(privateKey, kid, claimOverrides);
    const result = await client.verifyInstanceJwt(token);
    if (result.ok || result.reason !== "invalid") {
      throw new Error(
        `expected invalid for sub=${claimOverrides.sub} kid=${claimOverrides.kid}`,
      );
    }
  }
});
