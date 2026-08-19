/**
 * Host-free coverage for ProxySQL admin interface apply helpers.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { resolveLayout } from "../paths/layout.ts";
import { createTempLayout } from "../testing/temp-layout.ts";
import {
  applyProxySqlAdminStatements,
  loadProxySqlAdminCredentials,
  loadProxySqlMonitorCredentials,
  parseProxySqlAdminCnf,
  parseProxySqlClientCnf,
  parseProxySqlMonitorCnf,
  PROXYSQL_ADMIN_DEFAULTS_PATH,
  PROXYSQL_MONITOR_USERNAME,
} from "./proxysql-admin.ts";
import { proxysqlAdminCnfPath, proxysqlMonitorCnfPath } from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseProxySqlAdminCnf reads [client] user/password", () => {
  const creds = parseProxySqlAdminCnf(
    "[client]\nuser=admin\npassword=s3cret\n",
  );
  assertEquals(creds.user, "admin");
  assertEquals(creds.password, "s3cret");
});

test("parseProxySqlMonitorCnf reads [client] user/password", () => {
  const creds = parseProxySqlMonitorCnf(
    "[client]\nuser=tp_monitor\npassword=mon-pass\n",
  );
  assertEquals(creds.user, "tp_monitor");
  assertEquals(creds.password, "mon-pass");
});

test("PROXYSQL_MONITOR_USERNAME is the stable host monitor login", () => {
  assertEquals(PROXYSQL_MONITOR_USERNAME, "tp_monitor");
});

test("PROXYSQL_ADMIN_DEFAULTS_PATH is the compose-mounted admin.cnf path", () => {
  assertEquals(PROXYSQL_ADMIN_DEFAULTS_PATH, "/etc/proxysql-admin.cnf");
});

test("loadProxySqlMonitorCredentials returns null when monitor.cnf is missing", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(layout.configDir + "/proxysql", {
      recursive: true,
      mode: 0o750,
    });
    const creds = await loadProxySqlMonitorCredentials(layout);
    assertEquals(creds, null);
  } finally {
    await fixture.cleanup();
  }
});

test("loadProxySqlMonitorCredentials reads monitor.cnf", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(layout.configDir + "/proxysql", {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      proxysqlMonitorCnfPath(layout),
      "[client]\nuser=tp_monitor\npassword=mon-s3cret\n",
      { mode: 0o600 },
    );
    const creds = await loadProxySqlMonitorCredentials(layout);
    assertEquals(creds, { user: "tp_monitor", password: "mon-s3cret" });
  } finally {
    await fixture.cleanup();
  }
});

test("loadProxySqlAdminCredentials rejects directory scar at admin.cnf path", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(proxysqlAdminCnfPath(layout), {
      recursive: true,
      mode: 0o755,
    });
    await assertRejects(
      () => loadProxySqlAdminCredentials(layout),
      TypeError,
      "directory",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("loadProxySqlAdminCredentials rejects missing admin.cnf", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(layout.configDir + "/proxysql", {
      recursive: true,
      mode: 0o750,
    });
    await assertRejects(
      () => loadProxySqlAdminCredentials(layout),
      TypeError,
      "missing",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("applyProxySqlAdminStatements uses mounted defaults path (not host temp)", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(layout.configDir + "/proxysql", {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      proxysqlAdminCnfPath(layout),
      "[client]\nuser=admin\npassword=s3cret-password\n",
      { mode: 0o600 },
    );

    const calls: Array<{ args: string[]; input?: string }> = [];
    await applyProxySqlAdminStatements(
      ["DELETE FROM pgsql_servers", "LOAD PGSQL SERVERS TO RUNTIME"],
      {
        layout,
        containerName: "proxysql-test",
        runDocker: (args, options) => {
          calls.push({ args, input: options?.input });
          return Promise.resolve({
            success: true,
            code: 0,
            stdout: "",
            stderr: "",
          });
        },
      },
    );

    assertEquals(calls.length, 1);
    const call = calls[0]!;
    assertEquals(call.args.includes("exec"), true);
    assertEquals(call.args.includes("-i"), true);
    // defaults-extra-file must precede host/port options for libmysqlclient.
    const mysqlIdx = call.args.indexOf("mysql");
    assertEquals(
      call.args[mysqlIdx + 1],
      `--defaults-extra-file=${PROXYSQL_ADMIN_DEFAULTS_PATH}`,
    );
    assertStringIncludes(
      call.args.join(" "),
      `--defaults-extra-file=${PROXYSQL_ADMIN_DEFAULTS_PATH}`,
    );
    assertEquals(call.args.some((a) => a.includes("s3cret-password")), false);
    assertStringIncludes(call.input ?? "", "DELETE FROM pgsql_servers");
    assertStringIncludes(call.input ?? "", "LOAD PGSQL SERVERS TO RUNTIME");
  } finally {
    await fixture.cleanup();
  }
});

test("applyProxySqlAdminStatements rejects missing host admin.cnf", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(layout.configDir + "/proxysql", {
      recursive: true,
      mode: 0o750,
    });
    await assertRejects(
      () =>
        applyProxySqlAdminStatements(["SELECT 1"], {
          layout,
          containerName: "proxysql-test",
          runDocker: () =>
            Promise.resolve({
              success: true,
              code: 0,
              stdout: "",
              stderr: "",
            }),
        }),
      TypeError,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("applyProxySqlAdminStatements redacts password on failure", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(layout.configDir + "/proxysql", {
      recursive: true,
      mode: 0o750,
    });
    await Deno.writeTextFile(
      proxysqlAdminCnfPath(layout),
      "[client]\nuser=admin\npassword=s3cret-password\n",
      { mode: 0o600 },
    );
    await assertRejects(
      () =>
        applyProxySqlAdminStatements(["SELECT 1"], {
          layout,
          containerName: "proxysql-test",
          runDocker: () =>
            Promise.resolve({
              success: false,
              code: 1,
              stdout: "",
              stderr: "boom s3cret-password",
            }),
        }),
      Error,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("parseProxySqlClientCnf ignores comments and non-client sections", () => {
  const creds = parseProxySqlClientCnf(
    "; comment\n[monitor]\nuser=ignored\npassword=ignored\n[client]\nuser=admin\npassword=secret\n",
  );
  assertEquals(creds, { user: "admin", password: "secret" });
});

test("parseProxySqlClientCnf rejects missing password", () => {
  assertThrows(
    () => parseProxySqlClientCnf("[client]\nuser=admin\n"),
    TypeError,
    "missing [client] user/password",
  );
});

test("loadProxySqlMonitorCredentials rejects monitor.cnf directory scar", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(proxysqlMonitorCnfPath(layout), { recursive: true });
    await assertRejects(
      () => loadProxySqlMonitorCredentials(layout),
      TypeError,
      "monitor.cnf is a directory",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("applyProxySqlAdminStatements requires layout and containerName", async () => {
  await assertRejects(
    () => applyProxySqlAdminStatements(["SELECT 1"], {}),
    TypeError,
    "requires layout",
  );
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await assertRejects(
      () => applyProxySqlAdminStatements(["SELECT 1"], { layout }),
      TypeError,
      "requires containerName",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("applyProxySqlAdminStatements is a no-op for empty statement lists", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    let called = false;
    await applyProxySqlAdminStatements([], {
      layout,
      containerName: "proxysql-test",
      runDocker: () => {
        called = true;
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      },
    });
    assertEquals(called, false);
  } finally {
    await fixture.cleanup();
  }
});
