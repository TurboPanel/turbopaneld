import { assertEquals, assertRejects } from "@std/assert";
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
import { clearDaemonKeyState } from "./client.ts";
import { enrollDaemon } from "./enroll.ts";

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
  name: "clearDaemonKeyState removes key files but keeps server.id",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const stateDir = fixture.dirs.stateDir;
      await Deno.writeTextFile(join(stateDir, "server.id"), "srv-keep\n");
      await Deno.writeTextFile(
        join(stateDir, "server-key.json"),
        JSON.stringify({ algorithm: "Ed25519" }),
      );
      await Deno.writeTextFile(join(stateDir, "server-key-id"), "kid-1\n");

      await clearDaemonKeyState(stateDir);

      assertEquals(
        (await Deno.readTextFile(join(stateDir, "server.id"))).trim(),
        "srv-keep",
      );
      await assertRejects(
        () => Deno.stat(join(stateDir, "server-key.json")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(stateDir, "server-key-id")),
        Deno.errors.NotFound,
      );
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
