/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertSafeManagedIdentifiers,
  managedBackupArtifactPath,
  managedBackupsDir,
  managedComposeProject,
  managedDir,
  resolveManagedRelativePath,
} from "./paths.ts";

const test = Deno.test.bind(Deno);

test("assertSafeManagedIdentifiers rejects hostile ids", () => {
  assertThrows(
    () =>
      assertSafeManagedIdentifiers({
        managedId: "../escape",
        environmentId: "env1",
        projectName: "proj",
        containerName: "ok-name-1",
        volumes: [],
      }),
    Error,
    "managedId",
  );
  assertThrows(
    () =>
      assertSafeManagedIdentifiers({
        managedId: "ok-id",
        environmentId: "env1",
        projectName: "Bad Name!",
        containerName: "ok-name-1",
        volumes: [],
      }),
    Error,
    "projectName",
  );
  assertThrows(
    () =>
      assertSafeManagedIdentifiers({
        managedId: "ok-id",
        environmentId: "env1",
        projectName: "tp-managed-pg",
        containerName: "-starts-with-hyphen",
        volumes: [],
      }),
    Error,
    "containerName",
  );
  assertThrows(
    () =>
      assertSafeManagedIdentifiers({
        managedId: "ok-id",
        environmentId: "env1",
        projectName: "tp-managed-pg",
        containerName: "has/slash",
        volumes: [],
      }),
    Error,
    "containerName",
  );
  assertSafeManagedIdentifiers({
    managedId: "00000000-0000-4000-8000-000000000001",
    environmentId: "env_1",
    projectName: "tp-managed-pg",
    containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
  });
});

test("resolveManagedRelativePath refuses absolute and parent paths", () => {
  assertThrows(
    () => resolveManagedRelativePath("/tmp/managed", "/etc/passwd"),
    Error,
    "absolute",
  );
  assertThrows(
    () => resolveManagedRelativePath("/tmp/managed", "../escape"),
    Error,
    "..",
  );
  assertThrows(
    () => resolveManagedRelativePath("/tmp/managed", "foo\\bar"),
    Error,
    "absolute",
  );
  assertEquals(
    resolveManagedRelativePath("/tmp/managed/config", "postgresql.conf"),
    "/tmp/managed/config/postgresql.conf",
  );
  assertEquals(
    resolveManagedRelativePath("/tmp/managed", "tls/server.crt"),
    "/tmp/managed/tls/server.crt",
  );
});

test("managedDir and compose project naming", () => {
  const layout = { stateDir: "/var/lib/turbopanel" } as Parameters<
    typeof managedDir
  >[0];
  assertEquals(
    managedDir(layout, "abc"),
    "/var/lib/turbopanel/managed/abc",
  );
  assertEquals(
    managedComposeProject("abc"),
    "turbopanel-managed-abc",
  );
});

test("managedBackupsDir and managedBackupArtifactPath", () => {
  const layout = { stateDir: "/var/lib/turbopanel" } as Parameters<
    typeof managedDir
  >[0];
  assertEquals(
    managedBackupsDir(layout, "abc"),
    "/var/lib/turbopanel/managed/abc/backups",
  );
  assertEquals(
    managedBackupArtifactPath(layout, "abc", "bk_1", "dump"),
    "/var/lib/turbopanel/managed/abc/backups/bk_1.dump",
  );
  assertThrows(
    () => managedBackupArtifactPath(layout, "abc", "../escape", "dump"),
    Error,
    "backupId",
  );
  assertThrows(
    () => managedBackupArtifactPath(layout, "abc", "bk_1", "sh"),
    Error,
    "extension",
  );
});
