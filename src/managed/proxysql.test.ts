/**
 * Host-free unit coverage for shared ProxySQL compose / config generation.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  assertNoFrontendUserConflict,
  buildProxySqlAdminStatements,
  formatProxySqlBindHost,
  ManagedFrontendUserConflictError,
  PROXYSQL_IMAGE,
  proxysqlCompose,
  type ProxySqlDesiredState,
  readCurrentProxySqlBindAddress,
  readPublishedBindAddressFromCompose,
  renderProxySqlConfig,
  staticConfigSectionChanged,
  writeProxySqlConfigAtomic,
} from "./proxysql.ts";
import type { SystemComponentDescriptor } from "../deploy/system-component.ts";
import { SYSTEM_MANAGED_INGRESS_COMPONENT } from "../deploy/system-component.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DESCRIPTOR: SystemComponentDescriptor = {
  component: SYSTEM_MANAGED_INGRESS_COMPONENT,
  serviceId: "00000000-0000-4000-8000-0000000000aa",
  composeServiceName: "proxysql",
  containerName: "00000000-0000-4000-8000-0000000000aa",
  role: "system",
};

function clusterDesired(
  overrides: Partial<ProxySqlDesiredState["clusters"][number]> = {},
): ProxySqlDesiredState["clusters"][number] {
  return {
    managedId: "m1",
    engine: "postgres",
    protocolPort: 5432,
    writerHostgroup: 0,
    readerHostgroup: 1,
    backends: [
      {
        memberId: "mb1",
        role: "primary",
        readEligible: false,
        address: "engine-1",
        port: 5432,
        transport: "local",
      },
    ],
    users: [{ username: "app", role: "user", password: "s3cret-app" }],
    ...overrides,
  };
}

test("proxysqlCompose without descriptor stays anonymous", () => {
  const compose = proxysqlCompose();
  assertStringIncludes(compose, `image: ${PROXYSQL_IMAGE}`);
  assertEquals(compose.includes("container_name:"), false);
  assertStringIncludes(compose, "turbopanel-managed:");
  assertStringIncludes(compose, "external: true");
  assertStringIncludes(compose, "127.0.0.1:6032:6032");
});

test("proxysqlCompose with descriptor emits identity + system labels", () => {
  const compose = proxysqlCompose(DESCRIPTOR);
  assertStringIncludes(compose, `container_name: ${DESCRIPTOR.containerName}`);
  assertStringIncludes(compose, "component: managed-ingress");
  assertStringIncludes(
    compose,
    'com.turbopanel.system.component: "managed-ingress"',
  );
  assertStringIncludes(compose, "turbopanel.role: system");
});

test("formatProxySqlBindHost brackets IPv6 and validates bind", () => {
  assertEquals(formatProxySqlBindHost("0.0.0.0"), "0.0.0.0");
  assertEquals(formatProxySqlBindHost("203.0.113.10"), "203.0.113.10");
  assertEquals(formatProxySqlBindHost("2001:db8::1"), "[2001:db8::1]");
  assertThrows(() => formatProxySqlBindHost("not-an-ip"), Error);
});

test("proxysqlCompose publishes bind-aware listener ports", () => {
  const compose = proxysqlCompose(null, "2001:db8::10");
  assertStringIncludes(compose, '"[2001:db8::10]:5432:5432"');
  assertStringIncludes(compose, '"[2001:db8::10]:3306:3306"');
});

test("proxysqlCompose omits published db ports entirely when bindAddress is null", () => {
  // Regression coverage: exposure disabled everywhere must never fall back to
  // publishing on every interface. Only the loopback-only admin port remains.
  const compose = proxysqlCompose(DESCRIPTOR, null);
  assertEquals(compose.includes(`:${5432}:${5432}`), false);
  assertEquals(compose.includes(`:${3306}:${3306}`), false);
  assertStringIncludes(compose, '"127.0.0.1:6032:6032"');
  assertStringIncludes(compose, "turbopanel-managed:");
  assertStringIncludes(compose, "external: true");
});

test("proxysqlCompose with no bindAddress argument also defaults to no publish", () => {
  const compose = proxysqlCompose(DESCRIPTOR);
  assertEquals(compose.includes(":5432:5432"), false);
  assertEquals(compose.includes(":3306:3306"), false);
});

test("proxysqlCompose publishes only on the intended address for public/datacenter exposure", () => {
  const compose = proxysqlCompose(DESCRIPTOR, "203.0.113.5");
  assertStringIncludes(compose, '"203.0.113.5:5432:5432"');
  assertStringIncludes(compose, '"203.0.113.5:3306:3306"');
  // Never accidentally widen to all-interfaces alongside the intended bind.
  assertEquals(compose.includes('"0.0.0.0:5432:5432"'), false);
  assertEquals(compose.includes('"0.0.0.0:3306:3306"'), false);
});

test("renderProxySqlConfig keeps ProxySQL's internal listener on every interface regardless of the publish bind", () => {
  // The container's own `interfaces=` must stay `0.0.0.0` even when the
  // compose-level publish is private-only (null) or a narrow public IP —
  // sibling containers on MANAGED_INGRESS_NETWORK dial this internal
  // address, which is unrelated to whether/where compose publishes to the
  // host. See `CONTAINER_LISTEN_ADDRESS` in proxysql.ts.
  const privateCnf = renderProxySqlConfig({
    bindAddress: null,
    clusters: [clusterDesired()],
  });
  const publicCnf = renderProxySqlConfig({
    bindAddress: "203.0.113.5",
    clusters: [clusterDesired()],
  });
  for (const cnf of [privateCnf, publicCnf]) {
    assertStringIncludes(cnf, 'interfaces="0.0.0.0:5432"');
    assertEquals(cnf.includes('interfaces="203.0.113.5:5432"'), false);
  }
});

test("readPublishedBindAddressFromCompose round-trips proxysqlCompose's publish decision", () => {
  assertEquals(
    readPublishedBindAddressFromCompose(proxysqlCompose(DESCRIPTOR, null)),
    null,
  );
  assertEquals(
    readPublishedBindAddressFromCompose(
      proxysqlCompose(DESCRIPTOR, "203.0.113.5"),
    ),
    "203.0.113.5",
  );
  assertEquals(
    readPublishedBindAddressFromCompose(
      proxysqlCompose(DESCRIPTOR, "2001:db8::10"),
    ),
    "2001:db8::10",
  );
  assertEquals(readPublishedBindAddressFromCompose(""), null);
});

test("readCurrentProxySqlBindAddress returns null when the compose file has never been written", async () => {
  const { createTempLayout } = await import("../testing/temp-layout.ts");
  const { resolveLayout } = await import("../paths/layout.ts");
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await readCurrentProxySqlBindAddress(layout), null);
  } finally {
    await fixture.cleanup();
  }
});

test("readCurrentProxySqlBindAddress reflects a previously-published bind on disk", async () => {
  const { createTempLayout } = await import("../testing/temp-layout.ts");
  const { resolveLayout } = await import("../paths/layout.ts");
  const { proxysqlComposePath, proxysqlConfigDir } = await import(
    "./paths.ts"
  );
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(
      proxysqlComposePath(layout),
      proxysqlCompose(DESCRIPTOR, "203.0.113.5"),
    );
    assertEquals(
      await readCurrentProxySqlBindAddress(layout),
      "203.0.113.5",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("assertNoFrontendUserConflict allows unique usernames across clusters", () => {
  assertNoFrontendUserConflict({
    bindAddress: "0.0.0.0",
    clusters: [
      clusterDesired({
        managedId: "a",
        users: [{ username: "u1", role: "root", password: "p1" }],
      }),
      clusterDesired({
        managedId: "b",
        users: [{ username: "u2", role: "user", password: "p2" }],
      }),
    ],
  });
});

test("assertNoFrontendUserConflict throws on duplicate username", () => {
  assertThrows(
    () =>
      assertNoFrontendUserConflict({
        bindAddress: "0.0.0.0",
        clusters: [
          clusterDesired({
            managedId: "a",
            users: [{ username: "shared", role: "root", password: "p1" }],
          }),
          clusterDesired({
            managedId: "b",
            users: [{ username: "shared", role: "user", password: "p2" }],
          }),
        ],
      }),
    ManagedFrontendUserConflictError,
  );
});

test("renderProxySqlConfig emits binding-user frontend password", () => {
  const cnf = renderProxySqlConfig({
    bindAddress: "0.0.0.0",
    clusters: [
      clusterDesired({
        users: [{
          username: "bound_app",
          role: "user",
          password: "bind-secret",
        }],
      }),
    ],
  });
  assertStringIncludes(cnf, 'username="bound_app"');
  assertStringIncludes(cnf, 'password="bind-secret"');
});

test("renderProxySqlConfig preserves admin credentials when provided", () => {
  const cnf = renderProxySqlConfig(
    {
      bindAddress: "0.0.0.0",
      clusters: [clusterDesired()],
    },
    { user: "admin", password: "admin-s3cret" },
  );
  assertStringIncludes(cnf, 'admin_credentials="admin:admin-s3cret"');
});

test("proxysqlCompose mounts admin.cnf at the admin defaults path", () => {
  const compose = proxysqlCompose();
  assertStringIncludes(compose, "./admin.cnf:/etc/proxysql-admin.cnf:ro");
});

test("buildProxySqlAdminStatements inserts frontend passwords", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddress: "0.0.0.0",
    clusters: [
      clusterDesired({
        users: [{ username: "app", role: "user", password: "fe-pass" }],
      }),
    ],
  });
  const joined = statements.join("\n");
  assertStringIncludes(joined, "'app','fe-pass'");
});

test("renderProxySqlConfig emits pgsql servers/users and skips empty reader rules", () => {
  const cnf = renderProxySqlConfig({
    bindAddress: "0.0.0.0",
    clusters: [clusterDesired()],
  });
  assertStringIncludes(cnf, "pgsql_servers");
  assertStringIncludes(cnf, "pgsql_users");
  assertStringIncludes(cnf, 'hostname="engine-1"');
  assertStringIncludes(cnf, "use_ssl=1");
  assertStringIncludes(cnf, "have_ssl");
  // Writer-only: no readEligible backends → no reader-hostgroup rules required.
  assertEquals(cnf.includes("match_digest"), false);
});

test("renderProxySqlConfig emits reader-hostgroup rules when replicas exist", () => {
  const cnf = renderProxySqlConfig({
    bindAddress: "0.0.0.0",
    clusters: [
      clusterDesired({
        backends: [
          {
            memberId: "mb1",
            role: "primary",
            readEligible: false,
            address: "writer",
            port: 5432,
            transport: "local",
          },
          {
            memberId: "mb2",
            role: "replica",
            readEligible: true,
            address: "reader",
            port: 5432,
            transport: "datacenter",
          },
        ],
      }),
    ],
  });
  assertStringIncludes(cnf, "pgsql_query_rules");
  assertStringIncludes(cnf, 'hostname="reader"');
  assertStringIncludes(cnf, 'username="app"');
  assertStringIncludes(cnf, 'match_pattern="^SELECT"');
});

test("read-split query rules are username-scoped per cluster on the same port", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddress: "0.0.0.0",
    clusters: [
      clusterDesired({
        managedId: "m-a",
        engine: "mysql",
        protocolPort: 3306,
        writerHostgroup: 10,
        readerHostgroup: 11,
        users: [{ username: "user_a", role: "user", password: "pa" }],
        backends: [
          {
            memberId: "pa",
            role: "primary",
            readEligible: false,
            address: "writer-a",
            port: 3306,
            transport: "local",
          },
          {
            memberId: "ra",
            role: "replica",
            readEligible: true,
            address: "reader-a",
            port: 3306,
            transport: "local",
          },
        ],
      }),
      clusterDesired({
        managedId: "m-b",
        engine: "mysql",
        protocolPort: 3306,
        writerHostgroup: 20,
        readerHostgroup: 21,
        users: [{ username: "user_b", role: "user", password: "pb" }],
        backends: [
          {
            memberId: "pb",
            role: "primary",
            readEligible: false,
            address: "writer-b",
            port: 3306,
            transport: "local",
          },
          {
            memberId: "rb",
            role: "replica",
            readEligible: true,
            address: "reader-b",
            port: 3306,
            transport: "local",
          },
        ],
      }),
    ],
  });
  const joined = statements.join("\n");
  assertStringIncludes(
    joined,
    "INSERT INTO mysql_query_rules (rule_id,active,username,match_pattern,destination_hostgroup,apply) VALUES (1,1,'user_a','^SELECT',11,1)",
  );
  assertStringIncludes(
    joined,
    "INSERT INTO mysql_query_rules (rule_id,active,username,match_pattern,destination_hostgroup,apply) VALUES (2,1,'user_b','^SELECT',21,1)",
  );
  // Cross-cluster routing must not exist (user_a never lands on reader 21).
  assertEquals(joined.includes("'user_a','^SELECT',21"), false);
  assertEquals(joined.includes("'user_b','^SELECT',11"), false);
});

test("buildProxySqlAdminStatements orders replace then LOAD/SAVE", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddress: "0.0.0.0",
    clusters: [clusterDesired()],
  });
  const joined = statements.join("\n");
  assertStringIncludes(joined, "DELETE FROM pgsql_servers");
  assertStringIncludes(joined, "LOAD PGSQL SERVERS TO RUNTIME");
  assertStringIncludes(joined, "SAVE PGSQL SERVERS TO DISK");
  // Both families are always cleared — empty MySQL still DELETE+SAVE.
  assertStringIncludes(joined, "DELETE FROM mysql_servers");
  assertStringIncludes(joined, "LOAD MYSQL SERVERS TO RUNTIME");
  assertStringIncludes(joined, "SAVE MYSQL SERVERS TO DISK");
  assertStringIncludes(joined, "DELETE FROM mysql_users");
  assertStringIncludes(joined, "DELETE FROM mysql_query_rules");
  const deleteIdx = joined.indexOf("DELETE FROM pgsql_servers");
  const loadIdx = joined.indexOf("LOAD PGSQL SERVERS TO RUNTIME");
  assertEquals(deleteIdx < loadIdx, true);
});

test("buildProxySqlAdminStatements clears stale MySQL when only Postgres remains", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddress: "0.0.0.0",
    clusters: [clusterDesired()], // postgres only
  });
  const joined = statements.join("\n");
  assertStringIncludes(joined, "DELETE FROM mysql_servers");
  assertStringIncludes(joined, "DELETE FROM mysql_users");
  assertStringIncludes(joined, "DELETE FROM mysql_query_rules");
  assertStringIncludes(joined, "SAVE MYSQL SERVERS TO DISK");
  assertStringIncludes(joined, "SAVE MYSQL USERS TO DISK");
  assertStringIncludes(joined, "SAVE MYSQL QUERY RULES TO DISK");
  // No MySQL INSERTs when family empty
  assertEquals(joined.includes("INSERT INTO mysql_servers"), false);
  assertEquals(joined.includes("INSERT INTO mysql_users"), false);
  assertEquals(joined.includes("INSERT INTO mysql_query_rules"), false);
});

test("staticConfigSectionChanged ignores dynamic user/server changes and the publish bind", () => {
  const a = renderProxySqlConfig({
    bindAddress: "0.0.0.0",
    clusters: [clusterDesired()],
  });
  const b = renderProxySqlConfig({
    bindAddress: "0.0.0.0",
    clusters: [
      clusterDesired({
        users: [{ username: "other", role: "user", password: "other-pass" }],
      }),
    ],
  });
  assertEquals(staticConfigSectionChanged(a, b), false);

  // The compose-level publish bind is no longer reflected in the cnf's
  // `interfaces=` line at all (see `CONTAINER_LISTEN_ADDRESS`) — it is a
  // pure compose `ports:` concern now, detected separately in the
  // `managed.ingress.reconcile` handler via
  // `readPublishedBindAddressFromCompose`, not via the static cnf section.
  const c = renderProxySqlConfig({
    bindAddress: "203.0.113.5",
    clusters: [clusterDesired()],
  });
  assertEquals(staticConfigSectionChanged(a, c), false);
  const d = renderProxySqlConfig({
    bindAddress: null,
    clusters: [clusterDesired()],
  });
  assertEquals(staticConfigSectionChanged(a, d), false);

  // Admin credential changes still count as a static-section change.
  const e = renderProxySqlConfig(
    { bindAddress: "0.0.0.0", clusters: [clusterDesired()] },
    { user: "admin", password: "rotated" },
  );
  assertEquals(staticConfigSectionChanged(a, e), true);
});

test("writeProxySqlConfigAtomic validates before commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-proxysql-cfg-" });
  try {
    const path = join(root, "proxysql.cnf");
    await writeProxySqlConfigAtomic(path, "admin_variables=\n{\n}");
    assertEquals(await Deno.readTextFile(path), "admin_variables=\n{\n}");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
