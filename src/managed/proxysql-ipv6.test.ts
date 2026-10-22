/**
 * Host-free coverage for ProxySQL's own IPv6 network (real IPv6 client
 * addresses) and the IPv6 listener it needs inside the container.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { parse as parseYaml } from "yaml";
import {
  buildProxySqlListenerInterfacesStatements,
  desiredProxySqlIpv6Subnet,
  ensureProxySqlIngress,
  proxysqlCompose,
  proxysqlComposeWithAttachments,
  proxySqlListenerInterfacesMismatch,
  readCurrentProxySqlIpv6Subnet,
  readManagedNetworkFromCompose,
  readPublishedBindAddressesFromCompose,
  readSegmentAttachmentsFromCompose,
  renderProxySqlConfig,
} from "./proxysql.ts";
import {
  PROXYSQL_IPV6_NETWORK,
  proxySqlBindsUseIpv6,
  proxySqlIpv6ListenProbeArgs,
  proxySqlIpv6NetworkSupport,
  proxySqlIpv6Subnet,
  proxySqlListenerInterfaces,
  proxySqlProbeShowsListening,
  readProxySqlIpv6SubnetFromCompose,
} from "./proxysql-ipv6.ts";
import { proxysqlComposePath } from "./engine-paths.ts";
import { resolveLayout } from "../paths/layout.ts";
import { createTempLayout } from "../testing/temp-layout.ts";
import type { SystemComponentDescriptor } from "../deploy/system-component.ts";
import { SYSTEM_MANAGED_INGRESS_COMPONENT } from "../deploy/system-component.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

const DESCRIPTOR: SystemComponentDescriptor = {
  component: SYSTEM_MANAGED_INGRESS_COMPONENT,
  serviceId: "00000000-0000-4000-8000-0000000000aa",
  composeServiceName: "proxysql",
  containerName: "00000000-0000-4000-8000-0000000000aa-in",
  role: "ingress",
};

const SEGMENT = { name: "tpn_site1", subnet: "10.192.11.0/24" };

type ComposeDoc = {
  services: { proxysql: { networks: Record<string, unknown> } };
  networks: Record<string, Record<string, unknown>>;
};

function composeDoc(text: string): ComposeDoc {
  return parseYaml(text) as ComposeDoc;
}

test("proxySqlIpv6Subnet is a stable unique local /64 per seed", () => {
  const subnet = proxySqlIpv6Subnet(DESCRIPTOR.serviceId);
  assertEquals(subnet, proxySqlIpv6Subnet(DESCRIPTOR.serviceId));
  assertMatch(subnet, /^fd[0-9a-f]{2}(?::[0-9a-f]{1,4}){3}::\/64$/);
  // Groups carry no leading zeros (the form Docker reports back).
  for (const group of subnet.replace("::/64", "").split(":")) {
    assert(group === "0" || !group.startsWith("0"), subnet);
  }
  const others = new Set(
    Array.from(
      { length: 200 },
      (_, i) =>
        proxySqlIpv6Subnet(`00000000-0000-4000-8000-${String(i).padStart(12)}`),
    ),
  );
  assertEquals(others.size, 200);
});

test("proxySqlBindsUseIpv6 is true only for an IPv6 publish", () => {
  assertEquals(proxySqlBindsUseIpv6([]), false);
  assertEquals(proxySqlBindsUseIpv6(["127.0.0.1"]), false);
  assertEquals(proxySqlBindsUseIpv6(["0.0.0.0"]), false);
  assertEquals(proxySqlBindsUseIpv6(["0.0.0.0", "::"]), true);
  assertEquals(proxySqlBindsUseIpv6(["2001:db8::5"]), true);
  // `::1` stays with docker-proxy either way.
  assertEquals(proxySqlBindsUseIpv6(["127.0.0.1", "::1"]), false);
});

function versionRun(engine: string | null, compose: string | null) {
  return (args: string[]) => {
    const out = args[0] === "version" ? engine : compose;
    return Promise.resolve({
      success: out !== null,
      stdout: out ?? "",
      stderr: out === null ? "boom" : "",
      code: out === null ? 1 : 0,
    });
  };
}

test("proxySqlIpv6NetworkSupport needs Docker 28 and Compose 2.33.1", async () => {
  assertEquals(
    await proxySqlIpv6NetworkSupport(versionRun("29.8.1\n", "2.40.3\n")),
    { supported: true },
  );
  assertEquals(
    await proxySqlIpv6NetworkSupport(versionRun("28.0.0", "v2.33.1")),
    { supported: true },
  );
  for (
    const [engine, compose] of [
      ["27.5.1", "2.40.3"],
      ["29.8.1", "2.33.0"],
      ["29.8.1", "2.9.9"],
      [null, "2.40.3"],
      ["29.8.1", null],
      ["", "2.40.3"],
    ] as const
  ) {
    const support = await proxySqlIpv6NetworkSupport(
      versionRun(engine, compose),
    );
    assertEquals(support.supported, false, `${engine} / ${compose}`);
  }
  // Too old is a fact; unreadable is not, and the caller keeps what it has.
  const old = await proxySqlIpv6NetworkSupport(versionRun("27.5.1", "2.40.3"));
  assertEquals(!old.supported && old.unreadable, false);
  const blank = await proxySqlIpv6NetworkSupport(versionRun(null, "2.40.3"));
  assertEquals(!blank.supported && blank.unreadable, true);
});

test("the IPv6 listener probe runs only the container's mysql client", () => {
  const args = proxySqlIpv6ListenProbeArgs("c-in", 15432);
  assertEquals(args.slice(0, 4), ["exec", "c-in", "mysql", "--no-defaults"]);
  assert(args.includes("--host=::1"));
  assert(args.includes("--port=15432"));
});

test("proxySqlProbeShowsListening tells a refused port from a reached one", () => {
  const fail = (stderr: string) => ({ success: false, stdout: "", stderr });
  assertEquals(
    proxySqlProbeShowsListening({ ...fail(""), success: true }),
    true,
  );
  for (
    const reached of [
      "ERROR 1045 (28000): ProxySQL Error: Access denied for user",
      "ERROR 2013 (HY000): Lost connection to server at 'handshake: reading initial communication packet'",
    ]
  ) {
    assertEquals(proxySqlProbeShowsListening(fail(reached)), true, reached);
  }
  for (
    const refused of [
      "ERROR 2002 (HY000): Can't connect to server on '::1' (115)",
      "ERROR 2003 (HY000): Can't connect to MySQL server on '::1:15432' (111)",
      "Error response from daemon: container is not running",
      "",
    ]
  ) {
    assertEquals(proxySqlProbeShowsListening(fail(refused)), false, refused);
  }
});

test("proxySqlListenerInterfaces adds the IPv6 wildcard only with the IPv6 network", () => {
  assertEquals(proxySqlListenerInterfaces(13306, false), "0.0.0.0:13306");
  assertEquals(
    proxySqlListenerInterfaces(15432, true),
    "0.0.0.0:15432;[::]:15432",
  );
});

test("an IPv4-only render carries no IPv6 network, so those hosts do not restart", () => {
  for (const binds of [[], ["127.0.0.1"], ["0.0.0.0"]]) {
    const text = proxysqlCompose(
      DESCRIPTOR,
      binds,
      [SEGMENT],
      null,
      MANAGED_NETWORK,
      true,
    );
    assertEquals(text.includes(PROXYSQL_IPV6_NETWORK), false);
    assertEquals(text.includes("enable_ipv6"), false);
    assertEquals(
      text,
      proxysqlComposeWithAttachments(
        DESCRIPTOR,
        binds,
        [{ name: SEGMENT.name, ipv4Address: "10.192.11.254" }],
        null,
        MANAGED_NETWORK,
      ),
    );
  }
});

test("an IPv6 publish joins an IPv6-only network and keeps every other fact readable", () => {
  const text = proxysqlCompose(
    DESCRIPTOR,
    ["0.0.0.0", "::"],
    [SEGMENT],
    null,
    MANAGED_NETWORK,
    true,
  );
  const doc = composeDoc(text);
  const subnet = proxySqlIpv6Subnet(DESCRIPTOR.serviceId);
  assertEquals(doc.networks[PROXYSQL_IPV6_NETWORK], {
    enable_ipv4: false,
    enable_ipv6: true,
    ipam: { config: [{ subnet }] },
  });
  assertEquals(doc.services.proxysql.networks[PROXYSQL_IPV6_NETWORK], {});
  // The managed network keeps external: true and stays first.
  assertEquals(doc.networks[MANAGED_NETWORK], { external: true });
  assertEquals(readManagedNetworkFromCompose(text), MANAGED_NETWORK);
  // The IPv6 network is never mistaken for a `tpn_*` attachment.
  assertEquals(readSegmentAttachmentsFromCompose(text), [
    { name: SEGMENT.name, ipv4Address: "10.192.11.254" },
  ]);
  assertEquals(readPublishedBindAddressesFromCompose(text), ["0.0.0.0", "::"]);
  assertEquals(readProxySqlIpv6SubnetFromCompose(text), subnet);
});

test("desiredProxySqlIpv6Subnet falls back to the managed network as the seed", () => {
  assertEquals(
    desiredProxySqlIpv6Subnet(null, ["::"], MANAGED_NETWORK),
    proxySqlIpv6Subnet(MANAGED_NETWORK),
  );
  assertEquals(
    desiredProxySqlIpv6Subnet(DESCRIPTOR, ["0.0.0.0"], MANAGED_NETWORK),
    null,
  );
});

test("readProxySqlIpv6SubnetFromCompose is null for a file without the network", () => {
  const text = proxysqlCompose(
    DESCRIPTOR,
    ["0.0.0.0"],
    [],
    null,
    MANAGED_NETWORK,
  );
  assertEquals(readProxySqlIpv6SubnetFromCompose(text), null);
  assertEquals(readProxySqlIpv6SubnetFromCompose(""), null);
});

test("renderProxySqlConfig listens on IPv6 inside the container only with an IPv6 publish", () => {
  const ipv4Only = renderProxySqlConfig(
    { bindAddresses: ["0.0.0.0"], clusters: [] },
    null,
    null,
    true,
  );
  assert(ipv4Only.includes('interfaces="0.0.0.0:13306"'));
  assert(ipv4Only.includes('interfaces="0.0.0.0:15432"'));
  assertEquals(ipv4Only.includes("[::]"), false);

  const dualDesired = {
    bindAddresses: ["0.0.0.0", "::"],
    listenerPorts: { pgsql: 25432, mysql: 23306 },
    clusters: [],
  };
  const dual = renderProxySqlConfig(dualDesired, null, null, true);
  assert(dual.includes('interfaces="0.0.0.0:23306;[::]:23306"'));
  assert(dual.includes('interfaces="0.0.0.0:25432;[::]:25432"'));
  // Without Docker support (the default) the listeners stay IPv4 only.
  assertEquals(renderProxySqlConfig(dualDesired).includes("[::]"), false);
});

test("listener interface statements only save to disk, never load to runtime", () => {
  const statements = buildProxySqlListenerInterfacesStatements({
    mysql: "0.0.0.0:13306;[::]:13306",
    pgsql: "0.0.0.0:15432;[::]:15432",
  });
  assertEquals(statements, [
    "SET mysql-interfaces='0.0.0.0:13306;[::]:13306'",
    "SET pgsql-interfaces='0.0.0.0:15432;[::]:15432'",
    "SAVE MYSQL VARIABLES TO DISK",
    "SAVE PGSQL VARIABLES TO DISK",
  ]);
  assertEquals(statements.some((s) => s.includes("RUNTIME")), false);
});

test("proxySqlListenerInterfacesMismatch ignores a family with no running row", () => {
  const desired = { mysql: "a", pgsql: "b" };
  assertEquals(proxySqlListenerInterfacesMismatch(desired, {}), []);
  assertEquals(
    proxySqlListenerInterfacesMismatch(desired, { mysql: "a", pgsql: "x" }),
    ["pgsql"],
  );
  assertEquals(
    proxySqlListenerInterfacesMismatch(desired, { mysql: "a", pgsql: "b" }),
    [],
  );
});

test("ensureProxySqlIngress (self-heal) writes back exactly the IPv6 network it is given", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    const run = () =>
      Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });
    const subnet = proxySqlIpv6Subnet(DESCRIPTOR.serviceId);
    const base = {
      bindAddresses: ["0.0.0.0", "::"],
      segmentAttachments: [],
      listenerPorts: null,
      managedNetwork: MANAGED_NETWORK,
      pageSizeBytes: () => Promise.resolve(4096),
    };

    await ensureProxySqlIngress(layout, DESCRIPTOR, run, {
      ...base,
      ipv6Subnet: subnet,
    });
    assertEquals(await readCurrentProxySqlIpv6Subnet(layout), subnet);

    // Nothing on disk: an IPv6 bind alone does not add the network.
    await ensureProxySqlIngress(layout, DESCRIPTOR, run, {
      ...base,
      ipv6Subnet: null,
    });
    assertEquals(await readCurrentProxySqlIpv6Subnet(layout), null);
    const text = await Deno.readTextFile(proxysqlComposePath(layout));
    assertEquals(text.includes(PROXYSQL_IPV6_NETWORK), false);
  } finally {
    await fixture.cleanup();
  }
});
