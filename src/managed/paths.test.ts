import { assertEquals, assertThrows } from "@std/assert";
import {
  assertSafeManagedIdentifiers,
  managedBackupArtifactPath,
  managedBackupsDir,
  managedComposePath,
  managedComposeProject,
  managedConfigDir,
  managedDir,
  managedEnvFilePath,
  managedTlsDir,
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
  orchestratorConfPath,
  orchestratorDataDir,
  orchestratorProject,
  orchestratorRaftCnfPath,
  orchestratorTlsDir,
  proxysqlAdminCnfPath,
  proxysqlComposePath,
  proxysqlConfigDir,
  proxysqlConfigPath,
  proxysqlDataDir,
  proxysqlMonitorCnfPath,
  proxysqlProject,
  proxysqlTlsDir,
  resolveManagedRelativePath,
} from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
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
  assertEquals(
    managedDir(LAYOUT, "abc"),
    "/var/lib/turbopanel/managed/abc",
  );
  assertEquals(
    managedComposeProject("abc"),
    "turbopanel-managed-abc",
  );
});

const LAYOUT = {
  configDir: "/etc/turbopanel",
  stateDir: "/var/lib/turbopanel",
} as Parameters<typeof managedDir>[0];

test("proxysql and managed path helpers join under config/state", () => {
  assertEquals(proxysqlProject(), "turbopanel-proxysql");
  assertEquals(
    proxysqlConfigDir(LAYOUT),
    "/etc/turbopanel/proxysql",
  );
  assertEquals(
    proxysqlComposePath(LAYOUT),
    "/etc/turbopanel/proxysql/docker-compose.yml",
  );
  assertEquals(
    proxysqlConfigPath(LAYOUT),
    "/etc/turbopanel/proxysql/proxysql.cnf",
  );
  assertEquals(proxysqlTlsDir(LAYOUT), "/etc/turbopanel/proxysql/tls");
  assertEquals(proxysqlDataDir(LAYOUT), "/var/lib/turbopanel/proxysql");
  assertEquals(
    proxysqlAdminCnfPath(LAYOUT),
    "/etc/turbopanel/proxysql/admin.cnf",
  );
  assertEquals(
    proxysqlMonitorCnfPath(LAYOUT),
    "/etc/turbopanel/proxysql/monitor.cnf",
  );
  assertEquals(
    managedComposePath(LAYOUT, "abc"),
    "/var/lib/turbopanel/managed/abc/docker-compose.yml",
  );
  assertEquals(
    managedConfigDir(LAYOUT, "abc"),
    "/var/lib/turbopanel/managed/abc/config",
  );
  assertEquals(
    managedTlsDir(LAYOUT, "abc"),
    "/var/lib/turbopanel/managed/abc/tls",
  );
  assertEquals(
    managedEnvFilePath(LAYOUT, "abc"),
    "/var/lib/turbopanel/managed/abc/.env",
  );
});

test("resolveManagedRelativePath rejects empty, metachar, and bad segments", () => {
  assertThrows(
    () => resolveManagedRelativePath("/tmp/managed", ""),
    Error,
    "invalid",
  );
  assertThrows(
    () => resolveManagedRelativePath("/tmp/managed", "a".repeat(256)),
    Error,
    "invalid",
  );
  assertThrows(
    () => resolveManagedRelativePath("/tmp/managed", "foo;rm"),
    Error,
    "unsupported characters",
  );
  assertThrows(
    () => resolveManagedRelativePath("/tmp/managed", "foo/./bar"),
    Error,
    "invalid",
  );
});

test("assertSafeManagedIdentifiers rejects environmentId and volume names", () => {
  assertThrows(
    () =>
      assertSafeManagedIdentifiers({
        managedId: "ok-id",
        environmentId: "../escape",
        projectName: "tp-managed-pg",
        containerName: "ok-name-1",
        volumes: [],
      }),
    Error,
    "environmentId",
  );
  assertThrows(
    () =>
      assertSafeManagedIdentifiers({
        managedId: "ok-id",
        environmentId: "env1",
        projectName: "",
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
        containerName: "ok-name-1",
        volumes: [{ name: "bad-name", target: "/data" }],
      }),
    Error,
    "volume name",
  );
});

test("orchestrator path helpers join under config/state", () => {
  assertEquals(orchestratorProject(), "turbopanel-orchestrator");
  assertEquals(
    orchestratorConfigDir(LAYOUT),
    "/etc/turbopanel/orchestrator",
  );
  assertEquals(
    orchestratorComposePath(LAYOUT),
    "/etc/turbopanel/orchestrator/docker-compose.yml",
  );
  assertEquals(
    orchestratorConfPath(LAYOUT),
    "/etc/turbopanel/orchestrator/orchestrator.conf.json",
  );
  assertEquals(
    orchestratorApiCnfPath(LAYOUT),
    "/etc/turbopanel/orchestrator/api.cnf",
  );
  assertEquals(
    orchestratorRaftCnfPath(LAYOUT),
    "/etc/turbopanel/orchestrator/raft.cnf",
  );
  assertEquals(
    orchestratorTlsDir(LAYOUT),
    "/etc/turbopanel/orchestrator/tls",
  );
  assertEquals(
    orchestratorDataDir(LAYOUT),
    "/var/lib/turbopanel/orchestrator",
  );
});

test("managedBackupsDir and managedBackupArtifactPath", () => {
  assertEquals(
    managedBackupsDir(LAYOUT, "abc"),
    "/var/lib/turbopanel/managed/abc/backups",
  );
  assertEquals(
    managedBackupArtifactPath(LAYOUT, "abc", "bk_1", "dump"),
    "/var/lib/turbopanel/managed/abc/backups/bk_1.dump",
  );
  assertThrows(
    () => managedBackupArtifactPath(LAYOUT, "abc", "../escape", "dump"),
    Error,
    "backupId",
  );
  assertThrows(
    () => managedBackupArtifactPath(LAYOUT, "abc", "bk_1", "sh"),
    Error,
    "extension",
  );
});
