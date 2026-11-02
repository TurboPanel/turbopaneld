import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import {
  buildAuthPayloadV2,
  buildEnrollmentPayloadV2,
  type DaemonKeyFile,
} from "../crypto/keys.ts";
import { DaemonApiError, type DaemonSessionRequest } from "./api-client.ts";
import { classifyConnectFailure } from "./connect-failure.ts";
import { enrollDaemon } from "./enroll.ts";
import { PanelIdentityError } from "./panel-identity-trust.ts";
import {
  DaemonTokenManager,
  installTokenManagerTimeSource,
} from "./token-manager.ts";

const test = Deno.test.bind(Deno);

const PANEL_KID = "P".repeat(43);

function jwt(exp: number): string {
  const part = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  return `${part({ alg: "EdDSA" })}.${part({ exp })}.sig`;
}

async function keyFile(): Promise<DaemonKeyFile> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  return {
    algorithm: "Ed25519",
    keyId: "kid-test",
    createdAt: "2026-11-01T00:00:00.000Z",
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

function manager(
  file: DaemonKeyFile,
  opts: {
    pinned: boolean;
    verify: Awaited<
      ReturnType<
        NonNullable<
          ConstructorParameters<typeof DaemonTokenManager>[0]["verifyToken"]
        >
      >
    >;
    sessions: DaemonSessionRequest[];
  },
) {
  return new DaemonTokenManager({
    keyFile: file,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: undefined,
    hostname: "host-1",
    apiClient: {
      getAuthChallenge: () =>
        Promise.resolve({
          challengeId: "c1",
          nonce: "n1",
          at: "",
          expiresAt: "",
        }),
      createSession: (body) => {
        opts.sessions.push(body);
        return Promise.resolve({
          token: jwt(Math.floor(Date.now() / 1000) + 900),
          expiresAt: "",
        });
      },
    },
    verifyToken: () => Promise.resolve(opts.verify),
    panelFingerprint: () => opts.pinned ? PANEL_KID : undefined,
  });
}

test("v2 proof strings add the fingerprint, method, path and iat", () => {
  assertEquals(
    buildAuthPayloadV2({
      challengeId: "c",
      nonce: "n",
      serverId: "s",
      keyId: "k",
      machineKey: "m",
      hostname: "h",
      panelFingerprint: "F",
      iat: 1700000000,
    }),
    "turbopanel-daemon-auth-v2\nc\nn\ns\nk\nm\nh\nF\nPOST\n/api/daemon/v1/auth/session\n1700000000",
  );
  assertEquals(
    buildEnrollmentPayloadV2({
      challengeId: "c",
      nonce: "n",
      licenseId: "l",
      machineKey: "m",
      hostname: "h",
      publicKeyFingerprint: "p",
      panelFingerprint: "F",
      iat: 1700000000,
    }),
    "turbopanel-daemon-enroll-v2\nc\nn\nl\nm\nh\np\nF\nPOST\n/api/daemon/v1/enroll\n1700000000",
  );
});

test("a pinned server signs in with v2 and names the pinned key; an unpinned one sends v1", async () => {
  const file = await keyFile();
  const verified = {
    ok: true as const,
    claims: { sub: "srv-1", kid: "kid-1", exp: 4_000_000_000, iat: 0 },
  };
  const pinnedSessions: DaemonSessionRequest[] = [];
  await manager(file, {
    pinned: true,
    verify: verified as never,
    sessions: pinnedSessions,
  }).getToken();
  assertEquals(pinnedSessions[0]?.payloadVersion, 2);
  assertEquals(pinnedSessions[0]?.panelFingerprint, PANEL_KID);
  assertEquals(typeof pinnedSessions[0]?.iat, "number");

  const plainSessions: DaemonSessionRequest[] = [];
  await manager(file, {
    pinned: false,
    verify: verified as never,
    sessions: plainSessions,
  }).getToken();
  assertEquals("payloadVersion" in plainSessions[0]!, false);
});

test("pinned: a token is never used without a verified JWKS; a forged key set parks", async () => {
  const file = await keyFile();
  const forged = new PanelIdentityError(
    "/api/daemon/v1/jwks.json",
    "answer is not signed",
  );
  const err = await manager(file, {
    pinned: true,
    verify: { ok: false, reason: "unavailable", cause: forged },
    sessions: [],
  }).getToken().catch((e) => e);
  assertInstanceOf(err, PanelIdentityError);
  assertEquals(classifyConnectFailure(err).kind, "panel-identity");

  const restore = installTokenManagerTimeSource({
    delay: () => Promise.resolve(),
  });
  try {
    await assertRejects(
      () =>
        manager(file, {
          pinned: true,
          verify: { ok: false, reason: "unavailable" },
          sessions: [],
        }).getToken(),
      Error,
      "JWKS unavailable",
    );
  } finally {
    restore();
  }

  const unpinned = await manager(file, {
    pinned: false,
    verify: { ok: false, reason: "unavailable" },
    sessions: [],
  }).getToken();
  assertEquals(typeof unpinned, "string");
});

test("the new sign-in refusals are classified", () => {
  assertEquals(
    classifyConnectFailure(
      new DaemonApiError(403, "Panel fingerprint mismatch"),
    ).kind,
    "panel-identity",
  );
  assertEquals(
    classifyConnectFailure(new DaemonApiError(403, "Signed proof required"))
      .kind,
    "permanent",
  );
  assertEquals(
    classifyConnectFailure(new DaemonApiError(400, "Proof clock skew")).kind,
    "transient",
  );
});

test("a pinned enrollment sends a v2 proof naming the pinned key", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const bodies: Record<string, unknown>[] = [];
    await enrollDaemon({
      apiClient: {
        getEnrollmentChallenge: () =>
          Promise.resolve({
            challengeId: "c",
            nonce: "n",
            at: "",
            expiresAt: "",
          }),
        enroll: (body: Record<string, unknown>) => {
          bodies.push(body);
          return Promise.resolve({ serverId: "srv-9", keyId: "kid-9" });
        },
      } as unknown as Parameters<typeof enrollDaemon>[0]["apiClient"],
      machineKey: undefined,
      hostname: "host-9",
      licenseId: "lic",
      licenseToken: "tok",
      stateDir,
      panelFingerprint: PANEL_KID,
      nowMs: () => 1_700_000_000_000,
    });
    assertEquals(bodies[0]?.payloadVersion, 2);
    assertEquals(bodies[0]?.panelFingerprint, PANEL_KID);
    assertEquals(bodies[0]?.iat, 1_700_000_000);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("pinned with no verified key: no challenge, no v1 proof, no token", async () => {
  const file = await keyFile();
  let calls = 0;
  const token = new DaemonTokenManager({
    keyFile: file,
    serverId: "srv-1",
    keyId: "kid-1",
    machineKey: undefined,
    hostname: "host-1",
    apiClient: {
      getAuthChallenge: () => {
        calls += 1;
        return Promise.reject(new Error("must not be called"));
      },
      createSession: () => {
        calls += 1;
        return Promise.reject(new Error("must not be called"));
      },
    },
    panelFingerprint: () => undefined,
    isPinned: () => true,
  });
  const restore = installTokenManagerTimeSource({
    delay: () => Promise.resolve(),
  });
  try {
    const err = await token.getToken().catch((e) => e);
    assertEquals(err.message, "control plane key not verified yet");
    assertEquals(calls, 0);
  } finally {
    restore();
  }
});
