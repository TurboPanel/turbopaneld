import { assertEquals } from "jsr:@std/assert";
import {
  COMMAND_TYPES,
  parseEnvironmentDeployPayload,
  parseWireguardApplyPayload,
} from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Byte-identical order with instance `src/lib/commands/types.ts` COMMAND_TYPES. */
const INSTANCE_COMMAND_TYPES = [
  "daemon.ping",
  "server.hostname.set",
  "server.ntp.set",
  "server.reboot",
  "server.timezone.set",
  "server.wireguard.apply",
  "environment.deploy",
  "environment.stop",
] as const;

test("COMMAND_TYPES matches instance canonical order", () => {
  assertEquals([...COMMAND_TYPES], [...INSTANCE_COMMAND_TYPES]);
});

test("environment.deploy hosting fixture round-trips bindAddress", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  web:\n    image: nginx\n",
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: ["app.example.com"],
        bindAddress: "203.0.113.10",
      },
    ],
  });
  assertEquals(payload.hostings[0]?.bindAddress, "203.0.113.10");
});

test("environment.deploy hosting fixture round-trips tcp protocol and ports", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services:\n  db:\n    image: postgres\n",
    hostings: [
      {
        hostingId: "h2",
        serviceId: "s2",
        composeServiceName: "db",
        hostnames: [],
        protocol: "tcp",
        ports: [{ published: 5432, target: 5432 }],
        bindAddress: "203.0.113.10",
      },
    ],
  });
  assertEquals(payload.hostings[0]?.protocol, "tcp");
  assertEquals(payload.hostings[0]?.ports, [{ published: 5432, target: 5432 }]);
});

test("environment.deploy traditionalWebSites fixture round-trips", () => {
  const payload = parseEnvironmentDeployPayload({
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeYaml: "services: {}\n",
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "site",
        hostnames: ["site.example.com"],
      },
    ],
    traditionalWebSites: [
      {
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        principal: {
          principalId: "00000000-0000-4000-8000-000000000099",
          username: "site_user",
          uid: 10001,
          gid: 10001,
        },
      },
    ],
  });
  assertEquals(payload.traditionalWebSites?.[0]?.engine, "nginx");
  assertEquals(payload.traditionalWebSites?.[0]?.listenPort, 18080);
  assertEquals(payload.traditionalWebSites?.[0]?.principal?.username, "site_user");
});

test("server.wireguard.apply fixture round-trips", () => {
  const payload = parseWireguardApplyPayload({
    vpnId: "550e8400-e29b-41d4-a716-446655440000",
    peerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    interfaceName: "tpwg550e8400",
    address: "203.0.113.10/32",
    listenPort: 51820,
    peers: [
      {
        peerId: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        allowedIps: ["203.0.113.11/32"],
        endpoint: "203.0.113.1:51820",
      },
    ],
  });
  assertEquals(payload.address, "203.0.113.10/32");
  assertEquals(payload.peers[0]?.endpoint, "203.0.113.1:51820");
});
