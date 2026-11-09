import { assertEquals, assertRejects } from "@std/assert";
import { decodeBase64Url } from "@std/encoding/base64url";
import { type HpkeEnvelope, openFromSender } from "../crypto/hpke.ts";
import { computePublicKeyFingerprint } from "../crypto/keys.ts";
import { loadOrCreateSealingKey } from "../crypto/sealing-key.ts";
import { join } from "@std/path";
import {
  challengeResponse,
  createFakeInstanceApi,
  enrollResponse,
  parseJsonBody,
  permanentEnrollmentErrorResponse,
} from "../testing/fake-instance-api.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { DaemonApiClient, DaemonApiError } from "./api-client.ts";
import { enrollDaemon, enrollSealAad } from "./enroll.ts";
import { PanelIdentityError } from "./panel-identity-trust.ts";

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

test({
  name: "enrollDaemon first enroll omits serverId and persists identity files",
  permissions: { env: true, net: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrollBody: unknown;
      try {
        api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
        api.script("/api/daemon/v1/enroll", async (init) => {
          enrollBody = await parseJsonBody(init);
          return enrollResponse({ serverId: "srv-new", keyId: "kid-new" });
        });

        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });

        const result = await enrollDaemon({
          apiClient: client,
          machineKey: "mk-1",
          hostname: "host-1",
          licenseId: "lic-1",
          licenseToken: "tok-1",
          stateDir: fixture.dirs.stateDir,
        });

        assertEquals(result.serverId, "srv-new");
        assertEquals(result.keyId, "kid-new");
        assertEquals(
          (enrollBody as { serverId?: string }).serverId,
          undefined,
          "first enroll must not send serverId",
        );

        assertEquals(
          (await Deno.readTextFile(join(fixture.dirs.stateDir, "server.id")))
            .trim(),
          "srv-new",
        );
        assertEquals(
          (await Deno.readTextFile(
            join(fixture.dirs.stateDir, "server-key-id"),
          ))
            .trim(),
          "kid-new",
        );
        const keyStat = await Deno.stat(
          join(fixture.dirs.stateDir, "server-key.json"),
        );
        assertEquals(keyStat.isFile, true);
      } finally {
        restore();
      }
    });
  },
});

test({
  name: "enrollDaemon re-enroll sends persisted serverId",
  permissions: { env: true, net: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const persistedId = "srv-persisted";
      await Deno.writeTextFile(
        join(fixture.dirs.stateDir, "server.id"),
        `${persistedId}\n`,
      );

      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrollBody: unknown;
      try {
        api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
        api.script("/api/daemon/v1/enroll", async (init) => {
          enrollBody = await parseJsonBody(init);
          return enrollResponse({
            serverId: persistedId,
            keyId: "kid-re",
          });
        });

        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });

        await enrollDaemon({
          apiClient: client,
          machineKey: undefined,
          hostname: "host-1",
          licenseId: "lic-1",
          licenseToken: "tok-1",
          stateDir: fixture.dirs.stateDir,
        });

        assertEquals(
          (enrollBody as { serverId?: string }).serverId,
          persistedId,
        );
      } finally {
        restore();
      }
    });
  },
});

test({
  name: "enrollDaemon surfaces DaemonApiError permanent enrollment failures",
  permissions: { env: true, net: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const api = createFakeInstanceApi();
      const restore = api.install();
      try {
        api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
        api.script(
          "/api/daemon/v1/enroll",
          () => permanentEnrollmentErrorResponse("invalid-license"),
        );

        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });

        const err = await assertRejects(
          () =>
            enrollDaemon({
              apiClient: client,
              machineKey: "mk-1",
              hostname: "host-1",
              licenseId: "lic-1",
              licenseToken: "tok-1",
              stateDir: fixture.dirs.stateDir,
            }),
          DaemonApiError,
        );
        assertEquals(err.status, 401);
        assertEquals(err.message, "Invalid license");
      } finally {
        restore();
      }
    });
  },
});

test({
  name: "enrollDaemon treats blank server.id as absent",
  permissions: { env: true, net: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await Deno.writeTextFile(
        join(fixture.dirs.stateDir, "server.id"),
        "  \n",
      );
      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrollBody: unknown;
      try {
        api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
        api.script("/api/daemon/v1/enroll", async (init) => {
          enrollBody = await parseJsonBody(init);
          return enrollResponse({ serverId: "srv-blank", keyId: "kid-blank" });
        });
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        await enrollDaemon({
          apiClient: client,
          machineKey: undefined,
          hostname: "host-1",
          licenseId: "lic-1",
          licenseToken: "tok-1",
          stateDir: fixture.dirs.stateDir,
        });
        assertEquals(
          (enrollBody as { serverId?: string }).serverId,
          undefined,
        );
      } finally {
        restore();
      }
    });
  },
});

test({
  name: "enrollDaemon surfaces non-NotFound server.id read errors",
  permissions: { env: true, net: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await Deno.mkdir(join(fixture.dirs.stateDir, "server.id"), {
        recursive: true,
      });
      const api = createFakeInstanceApi();
      const restore = api.install();
      try {
        api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        await assertRejects(
          () =>
            enrollDaemon({
              apiClient: client,
              machineKey: "mk",
              hostname: "host-1",
              licenseId: "lic-1",
              licenseToken: "tok-1",
              stateDir: fixture.dirs.stateDir,
            }),
        );
      } finally {
        restore();
      }
    });
  },
});

test({
  name: "enrollDaemon leaves an unchanged pre-provisioned server.id untouched",
  permissions: { env: true, net: true, read: true, write: true },
  fn: async () => {
    // The self-hosted wizard writes the co-located seat's server.id as the
    // instance user (0640): the daemon can read it but not open it for
    // writing. Re-enrolling the same seat must not need to.
    await withTempLayout(async (fixture) => {
      const serverIdPath = join(fixture.dirs.stateDir, "server.id");
      await Deno.writeTextFile(serverIdPath, "srv-seat\n");
      await Deno.chmod(serverIdPath, 0o440);
      const before = await Deno.stat(serverIdPath);
      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrollBody: unknown;
      try {
        api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
        api.script("/api/daemon/v1/enroll", async (init) => {
          enrollBody = await parseJsonBody(init);
          return enrollResponse({ serverId: "srv-seat", keyId: "kid-seat" });
        });
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        const result = await enrollDaemon({
          apiClient: client,
          machineKey: "mk",
          hostname: "panel-host",
          licenseId: "lic-1",
          licenseToken: "tok-1",
          stateDir: fixture.dirs.stateDir,
        });
        assertEquals(result.serverId, "srv-seat");
        assertEquals(
          (enrollBody as { serverId?: string }).serverId,
          "srv-seat",
        );
        const after = await Deno.stat(serverIdPath);
        assertEquals(after.mtime?.getTime(), before.mtime?.getTime());
        assertEquals(await Deno.readTextFile(serverIdPath), "srv-seat\n");
        assertEquals(
          (await Deno.readTextFile(
            join(fixture.dirs.stateDir, "server-key-id"),
          ))
            .trim(),
          "kid-seat",
        );
      } finally {
        await Deno.chmod(serverIdPath, 0o640);
        restore();
      }
    });
  },
});

test({
  name: "enrollDaemon replaces a changed server.id by rename, group-writable",
  permissions: { env: true, net: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const serverIdPath = join(fixture.dirs.stateDir, "server.id");
      await Deno.writeTextFile(serverIdPath, "srv-old\n");
      await Deno.chmod(serverIdPath, 0o440);
      const api = createFakeInstanceApi();
      const restore = api.install();
      try {
        api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
        api.script(
          "/api/daemon/v1/enroll",
          () => enrollResponse({ serverId: "srv-new", keyId: "kid-new" }),
        );
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        const result = await enrollDaemon({
          apiClient: client,
          machineKey: "mk",
          hostname: "host-1",
          licenseId: "lic-1",
          licenseToken: "tok-1",
          stateDir: fixture.dirs.stateDir,
        });
        assertEquals(result.serverId, "srv-new");
        assertEquals(await Deno.readTextFile(serverIdPath), "srv-new\n");
        const mode = (await Deno.stat(serverIdPath)).mode ?? 0;
        assertEquals(mode & 0o777, 0o660);
        // No temp file left behind.
        const leftovers: string[] = [];
        for await (const entry of Deno.readDir(fixture.dirs.stateDir)) {
          if (entry.name.startsWith("server.id.")) leftovers.push(entry.name);
        }
        assertEquals(leftovers, []);
      } finally {
        restore();
      }
    });
  },
});

const SEAL_PERMISSIONS = { env: true, net: true, read: true, write: true };

async function sealKeyFor(dir: string) {
  const loaded = await loadOrCreateSealingKey(dir, "panel-key");
  return {
    loaded,
    key: {
      kid: loaded.kid,
      pub: decodeBase64Url(loaded.pub),
      panelFingerprint: "P".repeat(43),
    },
  };
}

function echoingChallenge(
  init: RequestInit | undefined,
  mode: "current" | "older" = "current",
  echo = true,
) {
  const asked = JSON.parse(String(init?.body ?? "{}")) as {
    clientNonce?: string;
  };
  const now = Date.now();
  return new Response(JSON.stringify({
    challengeId: "challenge-1",
    nonce: "nonce-1",
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...(mode === "current" ? { sealedLicense: 1 } : {}),
    ...(echo && asked.clientNonce ? { clientNonce: asked.clientNonce } : {}),
  }));
}

test({
  name:
    "a pinned server seals its license to the control plane and never sends it in clear",
  permissions: SEAL_PERMISSIONS,
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrollBody: Record<string, unknown> = {};
      let challengeBody: Record<string, unknown> = {};
      try {
        const { loaded, key } = await sealKeyFor(fixture.dirs.stateDir);
        api.script("/api/daemon/v1/auth/challenge", async (init) => {
          challengeBody = await parseJsonBody(init) as Record<string, unknown>;
          return echoingChallenge(init);
        });
        api.script("/api/daemon/v1/enroll", async (init) => {
          enrollBody = await parseJsonBody(init) as Record<string, unknown>;
          return enrollResponse({ serverId: "srv-new", keyId: "kid-new" });
        });
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        await enrollDaemon({
          apiClient: client,
          machineKey: "mk",
          hostname: "host-1",
          licenseId: "lic-1",
          licenseToken: "secret-license-token",
          stateDir: fixture.dirs.stateDir,
          panelFingerprint: "P".repeat(43),
          panelSealKey: () => Promise.resolve(key),
        });
        assertEquals(typeof challengeBody.clientNonce, "string");
        assertEquals(enrollBody.licenseToken, undefined);
        assertEquals(
          JSON.stringify(enrollBody).includes("secret-license-token"),
          false,
        );
        assertEquals(enrollBody.clientNonce, challengeBody.clientNonce);
        // Only the holder of the sealing key, for this request, opens it.
        const opened = await openFromSender(
          loaded.privateRaw,
          enrollSealAad({
            panelFingerprint: key.panelFingerprint,
            challengeId: "challenge-1",
            challengeNonce: "nonce-1",
            clientNonce: challengeBody.clientNonce as string,
            publicKeyFingerprint: await computePublicKeyFingerprint(
              enrollBody.publicJwk as JsonWebKey,
            ),
          }),
          enrollBody.sealedLicenseToken as HpkeEnvelope,
        );
        assertEquals(
          new TextDecoder().decode(opened),
          "secret-license-token",
        );
      } finally {
        restore();
      }
    });
  },
});

test({
  name:
    "a pinned server with no verified sealing key refuses to send the license in clear",
  permissions: SEAL_PERMISSIONS,
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrolled = false;
      try {
        api.script(
          "/api/daemon/v1/auth/challenge",
          (init) => echoingChallenge(init),
        );
        api.script("/api/daemon/v1/enroll", () => {
          enrolled = true;
          return enrollResponse();
        });
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        for (const panelSealKey of [undefined, () => Promise.resolve(null)]) {
          await assertRejects(
            () =>
              enrollDaemon({
                apiClient: client,
                machineKey: "mk",
                hostname: "host-1",
                licenseId: "lic-1",
                licenseToken: "secret-license-token",
                stateDir: fixture.dirs.stateDir,
                panelFingerprint: "P".repeat(43),
                panelSealKey,
              }),
            PanelIdentityError,
          );
        }
        assertEquals(enrolled, false, "nothing was sent to the control plane");
      } finally {
        restore();
      }
    });
  },
});

test({
  name:
    "a pinned server sends the license in clear to an older control plane (no marker) only on a fresh answer",
  permissions: SEAL_PERMISSIONS,
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrollBody: Record<string, unknown> = {};
      let stale = false;
      try {
        api.script("/api/daemon/v1/auth/challenge", (init) => {
          const response = echoingChallenge(init, "older");
          if (!stale) return response;
          return challengeResponse({
            at: new Date(Date.now() - 3_600_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        });
        api.script("/api/daemon/v1/enroll", async (init) => {
          enrollBody = await parseJsonBody(init) as Record<string, unknown>;
          return enrollResponse();
        });
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        const params = {
          apiClient: client,
          machineKey: "mk",
          hostname: "host-1",
          licenseId: "lic-1",
          licenseToken: "tok-1",
          stateDir: fixture.dirs.stateDir,
          panelFingerprint: "P".repeat(43),
        };
        await enrollDaemon(params);
        assertEquals(enrollBody.licenseToken, "tok-1");
        assertEquals(enrollBody.sealedLicenseToken, undefined);

        // A stale answer without the echo could be an old one replayed.
        stale = true;
        enrollBody = {};
        await assertRejects(() => enrollDaemon(params), PanelIdentityError);
        assertEquals(enrollBody, {});
      } finally {
        restore();
      }
    });
  },
});

test({
  name: "an unpinned server sends the license in clear and no client nonce",
  permissions: SEAL_PERMISSIONS,
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const api = createFakeInstanceApi();
      const restore = api.install();
      let challengeBody: Record<string, unknown> | undefined;
      let enrollBody: Record<string, unknown> = {};
      try {
        api.script("/api/daemon/v1/auth/challenge", async (init) => {
          challengeBody = await parseJsonBody(init) as Record<string, unknown>;
          return challengeResponse();
        });
        api.script("/api/daemon/v1/enroll", async (init) => {
          enrollBody = await parseJsonBody(init) as Record<string, unknown>;
          return enrollResponse();
        });
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        await enrollDaemon({
          apiClient: client,
          machineKey: "mk",
          hostname: "host-1",
          licenseId: "lic-1",
          licenseToken: "tok-1",
          stateDir: fixture.dirs.stateDir,
        });
        assertEquals(challengeBody, {});
        assertEquals(enrollBody.licenseToken, "tok-1");
        assertEquals(enrollBody.clientNonce, undefined);
      } finally {
        restore();
      }
    });
  },
});

test({
  name:
    "a marked answer that does not echo this request's nonce is refused: stripped nonce, or another one",
  permissions: SEAL_PERMISSIONS,
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const api = createFakeInstanceApi();
      const restore = api.install();
      let enrolled = false;
      let behaviour: "stripped" | "other" = "stripped";
      try {
        const { key } = await sealKeyFor(fixture.dirs.stateDir);
        api.script("/api/daemon/v1/auth/challenge", () => {
          const now = Date.now();
          // What a genuine, current control plane answers a request whose
          // nonce an impostor removed (marker, no echo), or replaced.
          return new Response(JSON.stringify({
            challengeId: "challenge-1",
            nonce: "nonce-1",
            at: new Date(now).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
            sealedLicense: 1,
            ...(behaviour === "other"
              ? { clientNonce: "OTHEROTHEROTHEROTHEROTHER" }
              : {}),
          }));
        });
        api.script("/api/daemon/v1/enroll", () => {
          enrolled = true;
          return enrollResponse();
        });
        const client = new DaemonApiClient({
          config: INSTANCE_CONFIG,
          getToken: () => Promise.resolve("unused"),
        });
        for (behaviour of ["stripped", "other"] as const) {
          await assertRejects(
            () =>
              enrollDaemon({
                apiClient: client,
                machineKey: "mk",
                hostname: "host-1",
                licenseId: "lic-1",
                licenseToken: "secret-license-token",
                stateDir: fixture.dirs.stateDir,
                panelFingerprint: "P".repeat(43),
                panelSealKey: () => Promise.resolve(key),
              }),
            PanelIdentityError,
          );
        }
        assertEquals(enrolled, false, "the license was never sent");
      } finally {
        restore();
      }
    });
  },
});
