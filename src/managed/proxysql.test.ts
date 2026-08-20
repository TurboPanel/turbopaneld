/**
 * Host-free unit coverage for shared ProxySQL compose / config generation.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  assertManagedIngressPortsBindable,
  assertNoFrontendUserConflict,
  buildProxySqlAdminStatements,
  DEFAULT_PROXYSQL_LISTENER_PORTS,
  ensureProxySqlIngress,
  extractStaticProxySqlConfigSection,
  formatProxySqlBindHost,
  inspectProxySqlContainer,
  ManagedFrontendUserConflictError,
  ManagedIngressPortInUseError,
  MYSQL_PORT,
  PGSQL_PORT,
  protocolFamilyForCluster,
  PROXYSQL_IMAGE,
  type ProxySqlBackendDesired,
  proxysqlCompose,
  proxysqlComposeWithAttachments,
  type ProxySqlDesiredState,
  readCurrentProxySqlBindAddresses,
  readCurrentProxySqlListenerPorts,
  readCurrentProxySqlSegmentAttachments,
  readPublishedBindAddressesFromCompose,
  readPublishedListenerPortsFromCompose,
  readSegmentAttachmentsFromCompose,
  renderProxySqlConfig,
  restartProxySqlIngress,
  staticConfigSectionChanged,
  stopProxySqlIngress,
  writeProxySqlConfigAtomic,
} from "./proxysql.ts";
import { resolveLayout } from "../paths/layout.ts";
import { createTempLayout } from "../testing/temp-layout.ts";
import { reservedManagedIngressAddress } from "./ingress-cidr.ts";
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
  containerName: "00000000-0000-4000-8000-0000000000aa-sql",
  role: "turbopanel",
};

function clusterDesired(
  overrides: Partial<ProxySqlDesiredState["clusters"][number]> = {},
): ProxySqlDesiredState["clusters"][number] {
  return {
    managedId: "m1",
    engine: "postgres",
    protocolPort: 15432,
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

/**
 * The `interfaces=` value inside one protocol family's `*_variables` block.
 * Both families spell the key the same way, so the block header is the only
 * thing that tells them apart.
 */
function listenerInterface(
  cnf: string,
  family: "pgsql" | "mysql",
): string | null {
  const lines = cnf.split("\n");
  const header = lines.indexOf(`${family}_variables=`);
  if (header === -1) return null;
  for (const line of lines.slice(header)) {
    if (line.trim() === "}") return null;
    const match = /^\s*interfaces="(?<value>[^"]+)"$/.exec(line);
    if (match?.groups) return match.groups.value;
  }
  return null;
}

test("reservedManagedIngressAddress pins the last usable host", () => {
  assertEquals(
    reservedManagedIngressAddress("203.0.113.0/24"),
    "203.0.113.254",
  );
  assertEquals(reservedManagedIngressAddress("198.51.100.0/31"), null);
  assertEquals(reservedManagedIngressAddress("not-a-cidr"), null);
});

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
  assertEquals(DESCRIPTOR.containerName.endsWith("-sql"), true);
  assertStringIncludes(compose, "component: managed-ingress");
  assertStringIncludes(
    compose,
    'com.turbopanel.system.component: "managed-ingress"',
  );
  assertStringIncludes(compose, "turbopanel.role: turbopanel");
});

test("formatProxySqlBindHost brackets IPv6 and validates bind", () => {
  assertEquals(formatProxySqlBindHost("0.0.0.0"), "0.0.0.0");
  assertEquals(formatProxySqlBindHost("203.0.113.10"), "203.0.113.10");
  assertEquals(formatProxySqlBindHost("2001:db8::1"), "[2001:db8::1]");
  assertThrows(() => formatProxySqlBindHost("not-an-ip"), Error);
});

test("proxysqlCompose publishes bind-aware listener ports", () => {
  const compose = proxysqlCompose(null, ["2001:db8::10"]);
  assertStringIncludes(compose, '"[2001:db8::10]:15432:15432"');
  assertStringIncludes(compose, '"[2001:db8::10]:13306:13306"');
});

test("proxysqlCompose omits published db ports entirely when bindAddresses is empty", () => {
  // Regression coverage: exposure disabled everywhere must never fall back to
  // publishing on every interface. Only the loopback-only admin port remains.
  const compose = proxysqlCompose(DESCRIPTOR, []);
  assertEquals(compose.includes(`:${PGSQL_PORT}:${PGSQL_PORT}`), false);
  assertEquals(compose.includes(`:${MYSQL_PORT}:${MYSQL_PORT}`), false);
  assertEquals(compose.includes(`:${5432}:${5432}`), false);
  assertEquals(compose.includes(`:${3306}:${3306}`), false);
  assertStringIncludes(compose, '"127.0.0.1:6032:6032"');
  assertStringIncludes(compose, "turbopanel-managed:");
  assertStringIncludes(compose, "external: true");
});

test("proxysqlCompose with no bindAddresses argument also defaults to no publish", () => {
  const compose = proxysqlCompose(DESCRIPTOR);
  assertEquals(compose.includes(":15432:15432"), false);
  assertEquals(compose.includes(":13306:13306"), false);
  assertEquals(compose.includes(":5432:5432"), false);
  assertEquals(compose.includes(":3306:3306"), false);
});

test("proxysqlCompose attaches external spanning segment networks", () => {
  const compose = proxysqlCompose(DESCRIPTOR, [], [
    {
      name: "tpn_00000000-0000-4000-8000-0000000000cc",
      subnet: "203.0.113.0/24",
    },
    {
      name: "tpn_00000000-0000-4000-8000-0000000000dd",
      subnet: "198.51.100.0/24",
    },
  ]);
  assertStringIncludes(compose, "      turbopanel-managed: {}");
  assertStringIncludes(
    compose,
    "      tpn_00000000-0000-4000-8000-0000000000cc:",
  );
  assertStringIncludes(compose, '        ipv4_address: "203.0.113.254"');
  assertStringIncludes(
    compose,
    "      tpn_00000000-0000-4000-8000-0000000000dd:",
  );
  assertStringIncludes(compose, '        ipv4_address: "198.51.100.254"');
  assertStringIncludes(
    compose,
    "  tpn_00000000-0000-4000-8000-0000000000cc:",
  );
  assertStringIncludes(
    compose,
    "  tpn_00000000-0000-4000-8000-0000000000dd:",
  );
  assertStringIncludes(compose, "    external: true");
  assertEquals(compose.includes("driver:"), false);
  assertEquals(compose.includes("      - turbopanel-managed"), false);
  assertEquals(
    compose.includes("      - tpn_00000000-0000-4000-8000-0000000000cc"),
    false,
  );
});

test("readSegmentAttachmentsFromCompose round-trips rendered spanning attachments", () => {
  const compose = proxysqlCompose(DESCRIPTOR, ["203.0.113.5"], [
    {
      name: "tpn_00000000-0000-4000-8000-0000000000dd",
      subnet: "198.51.100.0/24",
    },
    {
      name: "tpn_00000000-0000-4000-8000-0000000000cc",
      subnet: "203.0.113.0/24",
    },
  ]);
  assertEquals(readSegmentAttachmentsFromCompose(compose), [
    {
      name: "tpn_00000000-0000-4000-8000-0000000000cc",
      ipv4Address: "203.0.113.254",
    },
    {
      name: "tpn_00000000-0000-4000-8000-0000000000dd",
      ipv4Address: "198.51.100.254",
    },
  ]);
  // The always-present shared ingress network is not a spanning attachment.
  assertEquals(
    readSegmentAttachmentsFromCompose(proxysqlCompose(DESCRIPTOR, [])),
    [],
  );
  assertEquals(readSegmentAttachmentsFromCompose(""), []);
});

test("proxysqlComposeWithAttachments renders pinned attachments verbatim", () => {
  // The self-heal path only recovers `ipv4_address` from disk — the source
  // subnet is gone — so attachments must render without re-deriving it.
  const compose = proxysqlComposeWithAttachments(DESCRIPTOR, [], [
    {
      name: "tpn_00000000-0000-4000-8000-0000000000cc",
      ipv4Address: "10.90.1.254",
    },
  ]);
  assertStringIncludes(
    compose,
    "      tpn_00000000-0000-4000-8000-0000000000cc:",
  );
  assertStringIncludes(compose, '        ipv4_address: "10.90.1.254"');
  assertStringIncludes(
    compose,
    "  tpn_00000000-0000-4000-8000-0000000000cc:\n    external: true",
  );
});

test("ensureProxySqlIngress preserves passed segment attachments in the written compose", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await ensureProxySqlIngress(
      layout,
      DESCRIPTOR,
      () =>
        Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        }),
      [],
      [
        {
          name: "tpn_00000000-0000-4000-8000-0000000000cc",
          ipv4Address: "10.90.1.254",
        },
      ],
    );
    assertEquals(await readCurrentProxySqlSegmentAttachments(layout), [
      {
        name: "tpn_00000000-0000-4000-8000-0000000000cc",
        ipv4Address: "10.90.1.254",
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("readCurrentProxySqlSegmentAttachments returns empty when compose has never been written", async () => {
  const fixture = await createTempLayout();
  try {
    assertEquals(
      await readCurrentProxySqlSegmentAttachments(resolveLayout(fixture.env)),
      [],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("proxysqlCompose rejects invalid spanning segment subnets", () => {
  assertThrows(
    () =>
      proxysqlCompose(DESCRIPTOR, [], [
        { name: "tpn_bad", subnet: "not-a-cidr" },
      ]),
    TypeError,
  );
  assertThrows(
    () =>
      proxysqlCompose(DESCRIPTOR, [], [
        { name: "tpn_narrow", subnet: "203.0.113.0/31" },
      ]),
    TypeError,
  );
});

test("proxysqlCompose publishes only on the intended address for public/datacenter exposure", () => {
  const compose = proxysqlCompose(DESCRIPTOR, ["203.0.113.5"]);
  assertStringIncludes(compose, '"203.0.113.5:15432:15432"');
  assertStringIncludes(compose, '"203.0.113.5:13306:13306"');
  // Never accidentally widen to all-interfaces alongside the intended bind.
  assertEquals(compose.includes('"0.0.0.0:15432:15432"'), false);
  assertEquals(compose.includes('"0.0.0.0:13306:13306"'), false);
});

test("renderProxySqlConfig keeps ProxySQL's internal listener on every interface regardless of the publish bind", () => {
  // The container's own `interfaces=` must stay `0.0.0.0` even when the
  // compose-level publish is private-only (null) or a narrow public IP —
  // sibling containers on MANAGED_INGRESS_NETWORK dial this internal
  // address, which is unrelated to whether/where compose publishes to the
  // host. See `CONTAINER_LISTEN_ADDRESS` in proxysql.ts.
  const privateCnf = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [clusterDesired()],
  });
  const publicCnf = renderProxySqlConfig({
    bindAddresses: ["203.0.113.5"],
    clusters: [clusterDesired()],
  });
  for (const cnf of [privateCnf, publicCnf]) {
    assertStringIncludes(cnf, 'interfaces="0.0.0.0:15432"');
    assertEquals(cnf.includes('interfaces="203.0.113.5:15432"'), false);
  }
});

test("readPublishedBindAddressesFromCompose round-trips proxysqlCompose's publish decision", () => {
  assertEquals(
    readPublishedBindAddressesFromCompose(proxysqlCompose(DESCRIPTOR, [])),
    [],
  );
  assertEquals(
    readPublishedBindAddressesFromCompose(
      proxysqlCompose(DESCRIPTOR, ["203.0.113.5"]),
    ),
    ["203.0.113.5"],
  );
  assertEquals(
    readPublishedBindAddressesFromCompose(
      proxysqlCompose(DESCRIPTOR, ["2001:db8::10"]),
    ),
    ["2001:db8::10"],
  );
  assertEquals(readPublishedBindAddressesFromCompose(""), []);
});

test("readPublishedBindAddressesFromCompose recovers every scope's address in order", () => {
  const compose = proxysqlCompose(DESCRIPTOR, [
    "203.0.113.5",
    "10.88.0.4",
  ]);
  assertEquals(readPublishedBindAddressesFromCompose(compose), [
    "203.0.113.5",
    "10.88.0.4",
  ]);
  // Both protocol listeners are published on each address, so the family
  // recovery still reads the first pair.
  assertEquals(readPublishedListenerPortsFromCompose(compose), {
    pgsql: PGSQL_PORT,
    mysql: MYSQL_PORT,
  });
});

test("readCurrentProxySqlBindAddresses returns [] when the compose file has never been written", async () => {
  const { createTempLayout } = await import("../testing/temp-layout.ts");
  const { resolveLayout } = await import("../paths/layout.ts");
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await readCurrentProxySqlBindAddresses(layout), []);
  } finally {
    await fixture.cleanup();
  }
});

test("readCurrentProxySqlBindAddresses reflects a previously-published bind on disk", async () => {
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
      proxysqlCompose(DESCRIPTOR, ["203.0.113.5"]),
    );
    assertEquals(
      await readCurrentProxySqlBindAddresses(layout),
      ["203.0.113.5"],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("assertNoFrontendUserConflict allows unique usernames across clusters", () => {
  assertNoFrontendUserConflict({
    bindAddresses: ["0.0.0.0"],
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
        bindAddresses: ["0.0.0.0"],
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
    bindAddresses: ["0.0.0.0"],
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
      bindAddresses: ["0.0.0.0"],
      clusters: [clusterDesired()],
    },
    { user: "admin", password: "admin-s3cret" },
  );
  assertStringIncludes(cnf, 'admin_credentials="admin:admin-s3cret"');
});

test("renderProxySqlConfig embeds monitor credentials in mysql and pgsql variables", () => {
  const cnf = renderProxySqlConfig(
    {
      bindAddresses: ["0.0.0.0"],
      clusters: [clusterDesired()],
    },
    { user: "admin", password: "admin-s3cret" },
    { user: "tp_monitor", password: "mon-s3cret" },
  );
  assertStringIncludes(cnf, 'monitor_username="tp_monitor"');
  assertStringIncludes(cnf, 'monitor_password="mon-s3cret"');
  assertStringIncludes(cnf, 'monitor_dbname="postgres"');
  // Dynamic section must not re-emit pgsql_variables (wipes monitor on load).
  assertEquals(
    cnf.split("pgsql_variables=").length - 1,
    1,
    "exactly one pgsql_variables block (static only)",
  );
  assertEquals(
    cnf.split("mysql_variables=").length - 1,
    1,
    "exactly one mysql_variables block (static only)",
  );
});

test("buildProxySqlAdminStatements sets monitor variables when provided", () => {
  const statements = buildProxySqlAdminStatements(
    {
      bindAddresses: ["0.0.0.0"],
      clusters: [clusterDesired()],
    },
    { monitor: { user: "tp_monitor", password: "mon-s3cret" } },
  );
  const joined = statements.join("\n");
  assertStringIncludes(joined, "SET pgsql-monitor_username='tp_monitor'");
  assertStringIncludes(joined, "SET pgsql-monitor_password='mon-s3cret'");
  assertStringIncludes(joined, "SET mysql-monitor_username='tp_monitor'");
  assertStringIncludes(joined, "LOAD PGSQL VARIABLES TO RUNTIME");
});

test("proxysqlCompose mounts admin.cnf at the admin defaults path", () => {
  const compose = proxysqlCompose();
  assertStringIncludes(compose, "./admin.cnf:/etc/proxysql-admin.cnf:ro");
});

test("buildProxySqlAdminStatements inserts frontend passwords", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddresses: ["0.0.0.0"],
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
    bindAddresses: ["0.0.0.0"],
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

const PRIMARY_AND_READER_BACKENDS: ProxySqlBackendDesired[] = [
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
];

test("libconfig server/user lists comma-separate adjacent records", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [
      clusterDesired({
        backends: PRIMARY_AND_READER_BACKENDS,
        users: [
          { username: "app", role: "user", password: "s3cret-app" },
          { username: "ro", role: "user", password: "s3cret-ro" },
        ],
      }),
      clusterDesired({
        managedId: "m2",
        writerHostgroup: 2,
        readerHostgroup: 3,
        backends: [
          {
            memberId: "mb3",
            role: "primary",
            readEligible: false,
            address: "engine-2",
            port: 5432,
            transport: "local",
          },
        ],
        users: [{ username: "app2", role: "user", password: "s3cret-app2" }],
      }),
    ],
  });
  // ProxySQL libconfig: a second `{...}` without a comma is `Parse error` and
  // crash-loops the container. Trailing commas after the last record are not
  // required (and some ProxySQL builds reject them).
  assertStringIncludes(
    cnf,
    '    { hostgroup_id=0 hostname="writer" port=5432 use_ssl=1 status="ONLINE" },\n' +
      '    { hostgroup_id=1 hostname="reader" port=5432 use_ssl=1 status="ONLINE" },\n' +
      '    { hostgroup_id=2 hostname="engine-2" port=5432 use_ssl=1 status="ONLINE" }',
  );
  assertStringIncludes(
    cnf,
    '    { username="app" password="s3cret-app" default_hostgroup=0 active=1 use_ssl=0 },\n' +
      '    { username="ro" password="s3cret-ro" default_hostgroup=0 active=1 use_ssl=0 },\n' +
      '    { username="app2" password="s3cret-app2" default_hostgroup=2 active=1 use_ssl=0 }',
  );
  assertEquals(cnf.includes("} ,"), false);
  assertEquals(cnf.includes("},\n)"), false);
});

test("a read-eligible replica alone does not split reads off the primary", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [clusterDesired({ backends: PRIMARY_AND_READER_BACKENDS })],
  });
  assertStringIncludes(cnf, 'hostname="reader"');
  assertStringIncludes(cnf, 'username="app"');
  // Read-write login stays on the writer hostgroup; no blanket ^SELECT rule.
  assertStringIncludes(
    cnf,
    'username="app" password="s3cret-app" default_hostgroup=0',
  );
  assertEquals(cnf.includes('match_pattern="^SELECT"'), false);
});

test("autoReadSplit opt-in emits ^SELECT rules for read-write logins only", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [
      clusterDesired({
        autoReadSplit: true,
        backends: PRIMARY_AND_READER_BACKENDS,
        users: [
          { username: "app", role: "user", password: "s3cret-app" },
          {
            username: "app_ro",
            role: "user",
            password: "s3cret-ro",
            connectionRole: "read-only",
          },
        ],
      }),
    ],
  });
  assertStringIncludes(
    cnf,
    'username="app" match_pattern="^SELECT" destination_hostgroup=1',
  );
  // app_ro already defaults to the reader hostgroup — a rule would be redundant.
  assertEquals(cnf.includes('username="app_ro" match_pattern'), false);
});

test("autoReadSplit without a read-eligible replica emits no rules", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [clusterDesired({ autoReadSplit: true })],
  });
  assertEquals(cnf.includes('match_pattern="^SELECT"'), false);
});

test("a read-only login defaults to the reader hostgroup", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [
      clusterDesired({
        backends: PRIMARY_AND_READER_BACKENDS,
        users: [
          {
            username: "app_ro",
            role: "user",
            password: "s3cret-ro",
            connectionRole: "read-only",
          },
        ],
      }),
    ],
  });
  assertStringIncludes(
    cnf,
    'username="app_ro" password="s3cret-ro" default_hostgroup=1',
  );
});

test("requireTls forces use_ssl on every frontend login of that cluster", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [
      clusterDesired({
        requireTls: true,
        users: [
          { username: "app", role: "user", password: "s3cret-app" },
          {
            username: "app_ro",
            role: "user",
            password: "s3cret-ro",
            connectionRole: "read-only",
          },
        ],
      }),
    ],
  });
  assertStringIncludes(cnf, 'username="app" password="s3cret-app"');
  assertStringIncludes(cnf, "active=1 use_ssl=1");
  assertEquals(cnf.includes("active=1 use_ssl=0"), false);
});

test("an optional-TLS cluster still accepts plaintext clients (use_ssl=0)", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [clusterDesired()],
  });
  assertStringIncludes(cnf, "active=1 use_ssl=0");
  // Backend legs stay encrypted regardless of the client-facing policy.
  assertStringIncludes(cnf, 'hostname="engine-1" port=5432 use_ssl=1');
});

test("admin user statements carry the cluster use_ssl decision", () => {
  const required = buildProxySqlAdminStatements({
    bindAddresses: ["0.0.0.0"],
    clusters: [
      clusterDesired({
        requireTls: true,
        engine: "mysql",
        protocolPort: 3306,
        users: [{
          username: "app",
          role: "user",
          password: "fe-pass",
          defaultDatabase: "app_db",
        }],
      }),
    ],
  }).join("\n");
  assertStringIncludes(
    required,
    "INSERT INTO mysql_users (username,password,default_hostgroup,active,use_ssl,default_schema) VALUES ('app','fe-pass',0,1,1,'app_db')",
  );

  const optional = buildProxySqlAdminStatements({
    bindAddresses: ["0.0.0.0"],
    clusters: [clusterDesired()],
  }).join("\n");
  assertStringIncludes(
    optional,
    "INSERT INTO pgsql_users (username,password,default_hostgroup,active,use_ssl) VALUES ('app','s3cret-app',0,1,0)",
  );
});

test("a replica that is not read-eligible is an OFFLINE_SOFT reader, never a writer", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [
      clusterDesired({
        backends: [
          PRIMARY_AND_READER_BACKENDS[0]!,
          {
            memberId: "mb3",
            role: "replica",
            readEligible: false,
            address: "standby",
            port: 5432,
            transport: "local",
          },
        ],
      }),
    ],
  });
  assertStringIncludes(
    cnf,
    'hostgroup_id=1 hostname="standby" port=5432 use_ssl=1 status="OFFLINE_SOFT"',
  );
  assertEquals(cnf.includes('hostgroup_id=0 hostname="standby"'), false);
});

test("read-split query rules are username-scoped per cluster on the same port", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddresses: ["0.0.0.0"],
    clusters: [
      clusterDesired({
        managedId: "m-a",
        engine: "mysql",
        protocolPort: 3306,
        autoReadSplit: true,
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
        autoReadSplit: true,
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
    bindAddresses: ["0.0.0.0"],
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
    bindAddresses: ["0.0.0.0"],
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
    bindAddresses: ["0.0.0.0"],
    clusters: [clusterDesired()],
  });
  const b = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
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
  // `readPublishedBindAddressesFromCompose`, not via the static cnf section.
  const c = renderProxySqlConfig({
    bindAddresses: ["203.0.113.5"],
    clusters: [clusterDesired()],
  });
  assertEquals(staticConfigSectionChanged(a, c), false);
  const d = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [clusterDesired()],
  });
  assertEquals(staticConfigSectionChanged(a, d), false);

  // Admin credential changes still count as a static-section change.
  const e = renderProxySqlConfig(
    { bindAddresses: ["0.0.0.0"], clusters: [clusterDesired()] },
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

test("writeProxySqlConfigAtomic rejects Docker bind-mount scar directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-proxysql-scar-" });
  try {
    const path = join(root, "proxysql.cnf");
    await Deno.mkdir(path, { recursive: true });
    await assertRejects(
      () => writeProxySqlConfigAtomic(path, "admin_variables=\n{\n}"),
      TypeError,
      "directory",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("writeProxySqlConfigAtomic rejects whitespace-only config before commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-proxysql-empty-" });
  try {
    const path = join(root, "proxysql.cnf");
    await assertRejects(
      () => writeProxySqlConfigAtomic(path, "   \n"),
      Error,
      "empty before commit",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("readPublishedBindAddressesFromCompose skips invalid host literals", () => {
  const compose = [
    '      - "not-a-bind:5432:5432"',
    '      - "203.0.113.5:5432:5432"',
  ].join("\n");
  assertEquals(readPublishedBindAddressesFromCompose(compose), ["203.0.113.5"]);
});

test("readPublishedBindAddressesFromCompose recovers new 15432 publish markers", () => {
  const compose = [
    '      - "203.0.113.9:15432:15432"',
  ].join("\n");
  assertEquals(readPublishedBindAddressesFromCompose(compose), ["203.0.113.9"]);
});

test("legacy and new protocolPort values route into the same family", () => {
  const pgsqlLegacy = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [clusterDesired({ protocolPort: 5432 })],
  });
  const pgsqlNew = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [clusterDesired({ protocolPort: 15432 })],
  });
  assertStringIncludes(pgsqlLegacy, "pgsql_servers");
  assertStringIncludes(pgsqlNew, "pgsql_servers");
  assertEquals(pgsqlLegacy.includes("mysql_servers"), false);
  assertEquals(pgsqlNew.includes("mysql_servers"), false);

  const mysqlLegacy = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [clusterDesired({ engine: "mysql", protocolPort: 3306 })],
  });
  const mysqlNew = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [clusterDesired({ engine: "mysql", protocolPort: 13306 })],
  });
  assertStringIncludes(mysqlLegacy, "mysql_servers");
  assertStringIncludes(mysqlNew, "mysql_servers");
  assertEquals(mysqlLegacy.includes("pgsql_servers"), false);
  assertEquals(mysqlNew.includes("pgsql_servers"), false);
});

test("an explicit cluster family wins over the port number", () => {
  // Once ports are organization-configurable a number no longer identifies a
  // protocol: an org may run Postgres on what used to be the MySQL default.
  const cnf = renderProxySqlConfig({
    bindAddresses: [],
    listenerPorts: { pgsql: 16306, mysql: 15432 },
    clusters: [
      clusterDesired({ protocolPort: 16306, family: "pgsql" }),
      clusterDesired({
        managedId: "m2",
        engine: "mysql",
        protocolPort: 15432,
        family: "mysql",
        writerHostgroup: 2,
        readerHostgroup: 3,
        users: [{ username: "app2", role: "user", password: "s3cret-app2" }],
      }),
    ],
  });
  assertStringIncludes(cnf, "pgsql_servers");
  assertStringIncludes(cnf, "mysql_servers");
  // The listener bindings follow listenerPorts, not the cluster ordering.
  assertEquals(listenerInterface(cnf, "pgsql"), "0.0.0.0:16306");
  assertEquals(listenerInterface(cnf, "mysql"), "0.0.0.0:15432");
});

test("protocolFamilyForCluster prefers the payload family, then engine, then port", () => {
  assertEquals(
    protocolFamilyForCluster(clusterDesired({
      engine: "mysql",
      protocolPort: 13306,
      family: "pgsql",
    })),
    "pgsql",
  );
  // No family on the wire (older control plane): the engine decides.
  assertEquals(
    protocolFamilyForCluster(
      clusterDesired({ engine: "mariadb", protocolPort: 15432 }),
    ),
    "mysql",
  );
  // Unknown engine and no family: fall back to the port.
  assertEquals(
    protocolFamilyForCluster(
      clusterDesired({ engine: "percona", protocolPort: 13306 }),
    ),
    "mysql",
  );
  assertEquals(
    protocolFamilyForCluster(
      clusterDesired({ engine: "percona", protocolPort: 9999 }),
    ),
    null,
  );
});

test("compose publishes organization-configured listener ports", () => {
  const compose = proxysqlCompose(DESCRIPTOR, ["203.0.113.5"], [], {
    pgsql: 18432,
    mysql: 18306,
  });
  assertStringIncludes(compose, '"203.0.113.5:18432:18432"');
  assertStringIncludes(compose, '"203.0.113.5:18306:18306"');
  // Admin stays loopback-only on its fixed port.
  assertStringIncludes(compose, '"127.0.0.1:6032:6032"');
  assertEquals(compose.includes(":15432:15432"), false);
  assertEquals(compose.includes(":13306:13306"), false);
});

test("compose falls back to the platform default listener ports", () => {
  const explicit = proxysqlCompose(
    DESCRIPTOR,
    ["203.0.113.5"],
    [],
    DEFAULT_PROXYSQL_LISTENER_PORTS,
  );
  assertEquals(proxysqlCompose(DESCRIPTOR, ["203.0.113.5"]), explicit);
  assertEquals(
    proxysqlCompose(DESCRIPTOR, ["203.0.113.5"], [], null),
    explicit,
  );
  assertStringIncludes(explicit, `:${PGSQL_PORT}:${PGSQL_PORT}`);
  assertStringIncludes(explicit, `:${MYSQL_PORT}:${MYSQL_PORT}`);
});

test("static config binds the configured listener ports", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    listenerPorts: { pgsql: 18432, mysql: 18306 },
    clusters: [
      clusterDesired({ protocolPort: 18432, family: "pgsql" }),
      clusterDesired({
        managedId: "m2",
        engine: "mysql",
        protocolPort: 18306,
        family: "mysql",
        writerHostgroup: 2,
        readerHostgroup: 3,
        users: [{ username: "app2", role: "user", password: "s3cret-app2" }],
      }),
    ],
  });
  assertEquals(listenerInterface(cnf, "pgsql"), "0.0.0.0:18432");
  assertEquals(listenerInterface(cnf, "mysql"), "0.0.0.0:18306");
});

test("readPublishedListenerPortsFromCompose round-trips configured ports", () => {
  const compose = proxysqlCompose(DESCRIPTOR, ["203.0.113.5"], [], {
    pgsql: 18432,
    mysql: 18306,
  });
  assertEquals(readPublishedListenerPortsFromCompose(compose), {
    pgsql: 18432,
    mysql: 18306,
  });
  assertEquals(readPublishedBindAddressesFromCompose(compose), ["203.0.113.5"]);
});

test("readPublishedListenerPortsFromCompose returns null when nothing is published", () => {
  // Unpublished frontend: only the loopback admin mapping exists, which is
  // excluded, so there are no client ports to recover.
  const compose = proxysqlCompose(DESCRIPTOR, []);
  assertEquals(readPublishedListenerPortsFromCompose(compose), null);
  assertEquals(readPublishedListenerPortsFromCompose(""), null);
  assertEquals(
    readPublishedListenerPortsFromCompose('      - "203.0.113.5:18432:18432"'),
    null,
  );
});

test("readCurrentProxySqlListenerPorts round-trips through disk", async () => {
  const { proxysqlComposePath, proxysqlConfigDir } = await import("./paths.ts");
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await readCurrentProxySqlListenerPorts(layout), null);

    await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(
      proxysqlComposePath(layout),
      proxysqlCompose(DESCRIPTOR, ["203.0.113.5"], [], {
        pgsql: 18432,
        mysql: 18306,
      }),
    );
    assertEquals(await readCurrentProxySqlListenerPorts(layout), {
      pgsql: 18432,
      mysql: 18306,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("port preflight only probes ports the current frontend does not already hold", async () => {
  const probed: number[] = [];
  const probe = (_host: string, port: number) => {
    probed.push(port);
    return Promise.resolve(true);
  };

  // Unchanged ports: nothing to probe, because ProxySQL itself is the listener.
  await assertManagedIngressPortsBindable(
    ["203.0.113.5"],
    { pgsql: 15432, mysql: 13306 },
    { pgsql: 15432, mysql: 13306 },
    probe,
  );
  assertEquals(probed, []);

  // Only Postgres moved.
  await assertManagedIngressPortsBindable(
    ["203.0.113.5"],
    { pgsql: 18432, mysql: 13306 },
    { pgsql: 15432, mysql: 13306 },
    probe,
  );
  assertEquals(probed, [18432]);

  // A swap holds both numbers, just on the other family — no host conflict.
  probed.length = 0;
  await assertManagedIngressPortsBindable(
    ["203.0.113.5"],
    { pgsql: 13306, mysql: 15432 },
    { pgsql: 15432, mysql: 13306 },
    probe,
  );
  assertEquals(probed, []);

  // First provision: both are new.
  probed.length = 0;
  await assertManagedIngressPortsBindable(
    ["203.0.113.5"],
    { pgsql: 15432, mysql: 13306 },
    null,
    probe,
  );
  assertEquals(probed, [15432, 13306]);
});

test("port preflight skips probing entirely when the frontend is not published", async () => {
  let probes = 0;
  await assertManagedIngressPortsBindable(
    [],
    { pgsql: 18432, mysql: 18306 },
    null,
    () => {
      probes += 1;
      return Promise.resolve(false);
    },
  );
  assertEquals(probes, 0);
});

test("port preflight refuses a port an unrelated host listener already owns", async () => {
  const err = await assertRejects(
    () =>
      assertManagedIngressPortsBindable(
        ["203.0.113.5"],
        { pgsql: 5432, mysql: 13306 },
        { pgsql: 15432, mysql: 13306 },
        (_host, port) => Promise.resolve(port !== 5432),
      ),
    ManagedIngressPortInUseError,
    "5432",
  );
  assertEquals(err.family, "pgsql");
  assertEquals(err.port, 5432);
  assertEquals(err.bindAddress, "203.0.113.5");
  assertEquals(err.kind, "managed_ingress_port_in_use");
});

test("legacy published 5432 compose text differs from current render so compose up is required", () => {
  const next = proxysqlCompose(DESCRIPTOR, ["203.0.113.5"]);
  const previous = next
    .replaceAll(":15432:15432", ":5432:5432")
    .replaceAll(":13306:13306", ":3306:3306");
  assertEquals(previous.trimEnd() !== next.trimEnd(), true);
  assertStringIncludes(previous, ":5432:5432");
  assertStringIncludes(next, ":15432:15432");
});

test("proxysqlCompose pins spanning segments to reserved ingress addresses", () => {
  const compose = proxysqlCompose(DESCRIPTOR, ["203.0.113.5"], [
    { name: "tpn_env_a", subnet: "203.0.113.0/24" },
    { name: "tpn_env_a", subnet: "203.0.113.0/24" },
    { name: "tpn_env_b", subnet: "198.51.100.0/24" },
  ]);
  assertStringIncludes(compose, "tpn_env_a:");
  assertStringIncludes(compose, '"203.0.113.254"');
  assertStringIncludes(compose, "tpn_env_b:");
  assertStringIncludes(compose, '"198.51.100.254"');
});

test("renderProxySqlConfig includes mysql family and default_schema users", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: ["0.0.0.0"],
    clusters: [
      clusterDesired({
        engine: "mysql",
        protocolPort: 3306,
        users: [
          {
            username: "app",
            role: "user",
            password: "pw",
            defaultDatabase: "appdb",
          },
        ],
      }),
    ],
  });
  assertStringIncludes(cnf, "mysql_servers");
  assertStringIncludes(cnf, "mysql_users");
  assertStringIncludes(cnf, 'default_schema="appdb"');
});

test("extractStaticProxySqlConfigSection strips dynamic tables", () => {
  const full = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [clusterDesired()],
  });
  const staticOnly = extractStaticProxySqlConfigSection(full);
  assertEquals(staticOnly.includes("pgsql_servers"), false);
  assertEquals(staticOnly.includes("admin_variables"), true);
  assertEquals(staticConfigSectionChanged(null, full), true);
});

test("inspectProxySqlContainer returns null when compose file is absent", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    const row = await inspectProxySqlContainer(layout, DESCRIPTOR, {
      runDocker: () => Promise.reject(new TypeError("docker must not run")),
    });
    assertEquals(row, null);
  } finally {
    await fixture.cleanup();
  }
});

test("inspectProxySqlContainer matches labelled managed-ingress row", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await ensureProxySqlIngress(layout, DESCRIPTOR, () =>
      Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      }));
    const ps = JSON.stringify([
      {
        ID: "abc",
        Name: DESCRIPTOR.containerName,
        Service: DESCRIPTOR.composeServiceName,
        State: "running",
        Labels: {
          "turbopanel.role": "turbopanel",
          "com.turbopanel.system.component": "managed-ingress",
        },
      },
    ]);
    const row = await inspectProxySqlContainer(layout, DESCRIPTOR, {
      runDocker: (args) => {
        if (args.includes("ps")) {
          return Promise.resolve({
            success: true,
            stdout: ps,
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      },
    });
    assertEquals(row?.containerName, DESCRIPTOR.containerName);
    assertEquals(row?.role, "turbopanel");
  } finally {
    await fixture.cleanup();
  }
});

test("inspectProxySqlContainer returns undefined when compose ps fails", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await ensureProxySqlIngress(layout, DESCRIPTOR, () =>
      Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      }));
    const row = await inspectProxySqlContainer(layout, DESCRIPTOR, {
      runDocker: () =>
        Promise.resolve({
          success: false,
          stdout: "",
          stderr: "permission denied",
          code: 1,
        }),
    });
    assertEquals(row, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("readCurrentProxySqlBindAddresses round-trips published bind", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await ensureProxySqlIngress(layout, DESCRIPTOR, () =>
      Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      }), ["203.0.113.8"]);
    assertEquals(
      await readCurrentProxySqlBindAddresses(layout),
      ["203.0.113.8"],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stopProxySqlIngress is a no-op when compose file is missing", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    let called = false;
    await stopProxySqlIngress(layout, () => {
      called = true;
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    });
    assertEquals(called, false);
  } finally {
    await fixture.cleanup();
  }
});

test("restartProxySqlIngress throws when compose restart fails", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await ensureProxySqlIngress(layout, DESCRIPTOR, () =>
      Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      }));
    await assertRejects(
      () =>
        restartProxySqlIngress(layout, () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "restart denied",
            code: 1,
          })),
      Error,
      "restart denied",
    );
  } finally {
    await fixture.cleanup();
  }
});
