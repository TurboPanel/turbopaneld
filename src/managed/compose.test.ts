import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "yaml";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import {
  assertPublicPrivateListenerTls,
  MANAGED_ROOT_PASSWORD_VAR,
  normalizeManagedCompose,
  unnestPostgresConfigTlsMounts,
} from "./compose.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Managed network names are the `network(kind='managed')` row's bare UUID. */
const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basePayload(
  overrides: Partial<ManagedApplyPayload> = {},
): ManagedApplyPayload {
  return {
    managedId: "00000000-0000-4000-8000-000000000001",
    environmentId: "00000000-0000-4000-8000-000000000002",
    engine: "postgres",
    projectName: "tp-managed-pg",
    containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    managedNetwork: MANAGED_NETWORK,
    image: "docker.io/library/postgres:18-alpine",
    containerPort: 5432,
    composeYaml: [
      "services:",
      "  postgres:",
      "    image: postgres:18-alpine",
      "    environment:",
      `      POSTGRES_PASSWORD: \${${MANAGED_ROOT_PASSWORD_VAR}}`,
      "    volumes:",
      "      - ./config:/etc/postgresql:ro",
      "      - pgdata:/var/lib/postgresql",
      "volumes:",
      "  pgdata:",
    ].join("\n"),
    configFiles: [
      {
        path: "postgresql.conf",
        contents: "listen_addresses = '*'\n",
        mode: "0640",
      },
    ],
    volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
    exposure: { enabled: false, protocol: "tcp" },
    credentials: [
      {
        principalId: "00000000-0000-4000-8000-000000000003",
        username: "postgres",
        role: "root",
        databases: ["postgres"],
        password: "tpdaemon.v1.server.key.payload",
      },
    ],
    memberId: "00000000-0000-4000-8000-0000000000a1",
    memberRole: "primary",
    memberOrdinal: 1,
    readEligible: false,
    peers: [],
    ...overrides,
  };
}

function parseNormalized(
  payload: ManagedApplyPayload,
): Record<string, unknown> {
  const { composeYaml } = normalizeManagedCompose(payload);
  const doc = parse(composeYaml);
  if (!isRecord(doc)) throw new TypeError("expected compose object");
  return doc;
}

test("normalizeManagedCompose rewrites nested config/tls mounts that Docker cannot start", () => {
  const withTls = basePayload({
    composeYaml: [
      "services:",
      "  postgres:",
      "    image: old:tag",
      "    environment:",
      `      POSTGRES_PASSWORD: \${${MANAGED_ROOT_PASSWORD_VAR}}`,
      "    volumes:",
      "      - ./config:/etc/postgresql:ro",
      "      - ./tls:/etc/postgresql/tls:ro",
      "      - pgdata:/var/lib/postgresql",
      "volumes:",
      "  pgdata:",
    ].join("\n"),
    tlsMaterial: {
      selfSigned: true,
      commonName: "managed-postgres",
      certPath: "tls/server.crt",
      keyPath: "tls/server.key",
    },
  });
  const doc = parseNormalized(withTls);
  const services = doc.services as Record<string, Record<string, unknown>>;
  const service = services.postgres!;
  assertEquals(service.image, "docker.io/library/postgres:18-alpine");
  assertEquals(
    service.container_name,
    "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
  );
  const volumes = service.volumes as string[];
  assertEquals(volumes.includes("./config:/etc/postgresql:ro"), false);
  assertEquals(
    volumes.includes(
      "./config/postgresql.conf:/etc/postgresql/postgresql.conf:ro",
    ),
    true,
  );
  assertEquals(
    volumes.includes("./config/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro"),
    true,
  );
  assertEquals(volumes.includes("./tls:/etc/postgresql/tls:ro"), true);
  assertEquals(volumes.includes("pgdata:/var/lib/postgresql"), true);
});

test("normalizeManagedCompose emits container_name and keeps it across dockerOptions/exposure", () => {
  const named = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-1";
  const withOptions = parseNormalized(
    basePayload({
      containerName: named,
      dockerOptions: {
        restart: "unless-stopped",
        labels: { "tp.managed": "1" },
      },
      exposure: {
        enabled: true,
        protocol: "tcp",
      },
    }),
  );
  const service =
    (withOptions.services as Record<string, Record<string, unknown>>)
      .postgres!;
  assertEquals(service.container_name, named);
  assertEquals(service.restart, "unless-stopped");
  const labels = service.labels as Record<string, string>;
  assertEquals(labels["tp.managed"], "1");
});

test("normalizeManagedCompose strips ports and maps resources", () => {
  const doc = parseNormalized(
    basePayload({
      composeYaml: [
        "services:",
        "  postgres:",
        "    image: postgres:18-alpine",
        "    ports:",
        "      - 5432:5432",
        "    environment:",
        `      POSTGRES_PASSWORD: \${${MANAGED_ROOT_PASSWORD_VAR}}`,
      ].join("\n"),
      resources: {
        cpus: 1.5,
        memoryBytes: 512 * 1024 * 1024,
        memoryReservationBytes: 256 * 1024 * 1024,
      },
    }),
  );
  const service = (doc.services as Record<string, Record<string, unknown>>)
    .postgres!;
  assertEquals(service.ports, undefined);
  assertEquals(service.cpus, 1.5);
  assertEquals(service.mem_limit, 512 * 1024 * 1024);
  assertEquals(service.mem_reservation, 256 * 1024 * 1024);
  const deploy = service.deploy as Record<string, unknown>;
  const resources = deploy.resources as Record<string, unknown>;
  const limits = resources.limits as Record<string, unknown>;
  assertEquals(limits.cpus, "1.5");
  assertEquals(limits.memory, String(512 * 1024 * 1024));
});

test("normalizeManagedCompose emits privateListener ports only", () => {
  const doc = parseNormalized(
    basePayload({
      privateListener: { address: "203.0.113.50", port: 45001 },
    }),
  );
  const service = (doc.services as Record<string, Record<string, unknown>>)
    .postgres!;
  assertEquals(service.ports, ["203.0.113.50:45001:5432"]);
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          privateListener: { address: "127.0.0.1", port: 45001 },
        }),
      ),
    Error,
  );
});

test("normalizeManagedCompose refuses a public privateListener without org TLS", () => {
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          privateListener: {
            address: "203.0.113.50",
            port: 45001,
            transport: "public",
          },
        }),
      ),
    Error,
    "public privateListener requires orgTlsMaterial",
  );
});

test("normalizeManagedCompose publishes a public privateListener with org TLS", () => {
  const doc = parseNormalized(
    basePayload({
      privateListener: {
        address: "203.0.113.50",
        port: 45001,
        transport: "public",
      },
      orgTlsMaterial: {
        certificatePem: "-----BEGIN CERTIFICATE-----\nleaf\n",
        privateKeyEnvelope: "tpdaemon.v1.server.key.payload",
        caCertPem: "-----BEGIN CERTIFICATE-----\nca\n",
      },
    }),
  );
  const service = (doc.services as Record<string, Record<string, unknown>>)
    .postgres!;
  assertEquals(service.ports, ["203.0.113.50:45001:5432"]);
});

test("normalizeManagedCompose applies dockerOptions and rejects denylist keys", () => {
  const doc = parseNormalized(
    basePayload({
      dockerOptions: {
        restart: "unless-stopped",
        stopGracePeriodSeconds: 30,
        shmSizeBytes: 64 * 1024 * 1024,
        ulimits: { nofile: { soft: 1024, hard: 2048 } },
        labels: { "tp.managed": "1" },
        extraEnv: { EXTRA: "yes" },
      },
    }),
  );
  const service = (doc.services as Record<string, Record<string, unknown>>)
    .postgres!;
  assertEquals(service.restart, "unless-stopped");
  assertEquals(service.stop_grace_period, "30s");
  assertEquals(service.shm_size, 64 * 1024 * 1024);
  assertEquals(service.ulimits, { nofile: { soft: 1024, hard: 2048 } });
  const labels = service.labels as Record<string, string>;
  assertEquals(labels["tp.managed"], "1");
  const env = service.environment as Record<string, string>;
  assertEquals(env.EXTRA, "yes");

  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          composeYaml: [
            "services:",
            "  postgres:",
            "    image: postgres:18-alpine",
            "    privileged: true",
            "    environment:",
            `      POSTGRES_PASSWORD: \${${MANAGED_ROOT_PASSWORD_VAR}}`,
          ].join("\n"),
        }),
      ),
    Error,
    "managed compose rejects service key: privileged",
  );
});

test("normalizeManagedCompose rejects dockerOptions.extraEnv overriding postgres-reserved env keys even when the payload bypassed parseManagedApplyPayload", () => {
  const reservedOverrides: Array<[string, string]> = [
    ["POSTGRES_PASSWORD", "hunter2"],
    ["POSTGRES_USER", "root"],
    ["POSTGRES_DB", "postgres"],
    ["POSTGRES_INITDB_ARGS", "--data-checksums"],
    ["POSTGRES_HOST_AUTH_METHOD", "trust"],
    ["PGDATA", "/var/lib/postgresql/evil"],
  ];
  for (const [key, value] of reservedOverrides) {
    assertThrows(
      () =>
        normalizeManagedCompose(
          basePayload({
            dockerOptions: { extraEnv: { [key]: value } },
          }),
        ),
      Error,
      `must not override reserved env var: ${key}`,
    );
  }
});

test("normalizeManagedCompose rejects unknown interpolation tokens", () => {
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          composeYaml: [
            "services:",
            "  postgres:",
            "    image: postgres:18-alpine",
            "    environment:",
            "      LEAK: ${HOME}",
          ].join("\n"),
        }),
      ),
    Error,
    "managed compose permits only",
  );
});

test("unnestPostgresConfigTlsMounts is a no-op without nested tls", () => {
  const mounts = ["pgdata:/var/lib/postgresql"];
  assertEquals(unnestPostgresConfigTlsMounts(mounts), mounts);
});

test("assertPublicPrivateListenerTls rejects public listener without org TLS", () => {
  assertThrows(
    () =>
      assertPublicPrivateListenerTls(basePayload({
        privateListener: {
          address: "203.0.113.50",
          port: 45001,
          transport: "public",
        },
      })),
    Error,
    "orgTlsMaterial",
  );
});

test("normalizeManagedCompose rejects invalid privateListener binds", () => {
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          privateListener: { address: "not-an-ip", port: 45001 },
        }),
      ),
    Error,
    "not a valid IP",
  );
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          privateListener: { address: "0.0.0.0", port: 45001 },
        }),
      ),
    Error,
    "loopback or unspecified",
  );
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          privateListener: { address: "203.0.113.50", port: 70_000 },
        }),
      ),
    Error,
    "port out of range",
  );
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          privateListener: { address: "::1", port: 45001 },
        }),
      ),
    Error,
    "loopback or unspecified",
  );
});

test("normalizeManagedCompose merges array-form environment from dockerOptions", () => {
  const doc = parseNormalized(
    basePayload({
      composeYaml: [
        "services:",
        "  postgres:",
        "    image: postgres:18-alpine",
        "    environment:",
        "      - EXISTING=yes",
        "      - BARE",
      ].join("\n"),
      dockerOptions: { extraEnv: { ADDED: "1" } },
    }),
  );
  const env = (doc.services as Record<string, Record<string, unknown>>)
    .postgres!.environment as Record<string, string>;
  assertEquals(env.EXISTING, "yes");
  assertEquals(env.BARE, "");
  assertEquals(env.ADDED, "1");
});

test("normalizeManagedCompose attaches managed network to array and object forms", () => {
  const arrayNetworks = parseNormalized(
    basePayload({
      composeYaml: [
        "services:",
        "  postgres:",
        "    image: postgres:18-alpine",
        "    networks:",
        "      - other-net",
      ].join("\n"),
    }),
  );
  const arrayService =
    (arrayNetworks.services as Record<string, Record<string, unknown>>)
      .postgres!;
  assertEquals(
    (arrayService.networks as string[]).includes(MANAGED_NETWORK),
    true,
  );

  const objectNetworks = parseNormalized(
    basePayload({
      composeYaml: [
        "services:",
        "  postgres:",
        "    image: postgres:18-alpine",
        "    networks:",
        "      other-net: {}",
      ].join("\n"),
    }),
  );
  const objectService =
    (objectNetworks.services as Record<string, Record<string, unknown>>)
      .postgres!;
  const nets = objectService.networks as Record<string, unknown>;
  assertEquals(nets[MANAGED_NETWORK] !== undefined, true);
});

test("normalizeManagedCompose rejects malformed compose documents", () => {
  assertThrows(
    () => normalizeManagedCompose(basePayload({ composeYaml: "volumes: {}" })),
    Error,
    "services object",
  );
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          composeYaml: [
            "services:",
            "  a:",
            "    image: postgres:18-alpine",
            "  b:",
            "    image: postgres:18-alpine",
          ].join("\n"),
        }),
      ),
    Error,
    "exactly one service",
  );
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          composeYaml: [
            "services:",
            "  postgres:",
            "    build: .",
          ].join("\n"),
        }),
      ),
    Error,
    "must not declare build",
  );
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          composeYaml: [
            "services:",
            "  postgres: null",
          ].join("\n"),
        }),
      ),
    Error,
    "service must be an object",
  );
  assertThrows(
    () =>
      normalizeManagedCompose(
        basePayload({
          composeYaml: [
            "services:",
            "  postgres:",
            "    image: postgres:18-alpine",
            "    networks: bridge",
          ].join("\n"),
        }),
      ),
    Error,
    "networks must be an array or object",
  );
});

test("normalizeManagedCompose attaches the payload's managed network, not a constant", () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const doc = parseNormalized(basePayload({ managedNetwork: other }));
  const networks = doc.networks as Record<string, unknown>;
  assertEquals(networks[other], { external: true });
  assertEquals(networks[MANAGED_NETWORK], undefined);
  const service = (doc.services as Record<string, Record<string, unknown>>)
    .postgres!;
  assertEquals((service.networks as string[]).includes(other), true);
});

test("normalizeManagedCompose always attaches managed network for ProxySQL reachability", () => {
  const doc = parseNormalized(basePayload());
  const networks = doc.networks as Record<string, unknown>;
  assertEquals(networks[MANAGED_NETWORK], { external: true });
  const service = (doc.services as Record<string, Record<string, unknown>>)
    .postgres!;
  assertEquals(
    (service.networks as string[]).includes(MANAGED_NETWORK),
    true,
  );
  const labels = service.labels as Record<string, string> | undefined;
  assertEquals(labels?.["traefik.enable"], undefined);
});
