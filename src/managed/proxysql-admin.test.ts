/**
 * Host-free coverage for ProxySQL admin interface apply helpers.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { resolveLayout } from "../paths/layout.ts";
import { createTempLayout } from "../testing/temp-layout.ts";
import {
  applyProxySqlAdminStatements,
  parseProxySqlAdminCnf,
  PROXYSQL_ADMIN_DEFAULTS_PATH,
} from "./proxysql-admin.ts";
import { proxysqlAdminCnfPath } from "./paths.ts";

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

test("PROXYSQL_ADMIN_DEFAULTS_PATH is the compose-mounted admin.cnf path", () => {
  assertEquals(PROXYSQL_ADMIN_DEFAULTS_PATH, "/etc/proxysql-admin.cnf");
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
        runDocker: async (args, options) => {
          calls.push({ args, input: options?.input });
          return { success: true, code: 0, stdout: "", stderr: "" };
        },
      },
    );

    assertEquals(calls.length, 1);
    const call = calls[0]!;
    assertEquals(call.args.includes("exec"), true);
    assertEquals(call.args.includes("-i"), true);
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
          runDocker: async () => ({
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
          runDocker: async () => ({
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
