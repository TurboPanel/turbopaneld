/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parse } from "yaml";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import {
  MANAGED_ROOT_PASSWORD_VAR,
  normalizeManagedCompose,
} from "./compose.ts";
import { MANAGED_INGRESS_NETWORK } from "./ingress.ts";

const test = Deno.test.bind(Deno);

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
      { path: "postgresql.conf", contents: "listen_addresses = '*'\n", mode: "0640" },
    ],
    volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
    exposure: { enabled: false, protocol: "tcp" },
    credentials: [
      {
        principalId: "00000000-0000-4000-8000-000000000003",
        username: "postgres",
        role: "root",
        databases: ["postgres"],
        password: "tpdaemon.v1.server.key.1.iv.ciphertext",
      },
    ],
    ...overrides,
  };
}

function parseNormalized(payload: ManagedApplyPayload): Record<string, unknown> {
  const { composeYaml } = normalizeManagedCompose(payload);
  const doc = parse(composeYaml);
  if (!isRecord(doc)) throw new TypeError("expected compose object");
  return doc;
}

test("normalizeManagedCompose preserves config/tls mounts and forces image", () => {
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
  assertEquals(volumes.includes("./config:/etc/postgresql:ro"), true);
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
        publishedPort: 15432,
      },
    }),
  );
  const service = (withOptions.services as Record<string, Record<string, unknown>>)
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

test("normalizeManagedCompose exposure attaches managed network and TCP labels", () => {
  const off = parseNormalized(basePayload());
  assertEquals(off.networks, undefined);

  const on = parseNormalized(
    basePayload({
      exposure: {
        enabled: true,
        protocol: "tcp",
        publishedPort: 15432,
        // Postgres supportsSni=false — hostnames must not change the rule.
        sni: { hostnames: ["db.example.com", "db2.example.com"] },
      },
    }),
  );
  const networks = on.networks as Record<string, unknown>;
  assertEquals(networks[MANAGED_INGRESS_NETWORK], { external: true });
  const service = (on.services as Record<string, Record<string, unknown>>)
    .postgres!;
  assertEquals(
    (service.networks as string[]).includes(MANAGED_INGRESS_NETWORK),
    true,
  );
  const labels = service.labels as Record<string, string>;
  assertEquals(labels["traefik.enable"], "true");
  assertEquals(
    labels["traefik.tcp.routers.m-00000000-0000-4000-8000-000000000001.entrypoints"],
    "tcp15432",
  );
  assertEquals(
    labels["traefik.tcp.routers.m-00000000-0000-4000-8000-000000000001.rule"],
    "HostSNI(`*`)",
  );
  assertEquals(
    labels[
      "traefik.tcp.services.m-00000000-0000-4000-8000-000000000001.loadbalancer.server.port"
    ],
    "5432",
  );

  const catchAll = parseNormalized(
    basePayload({
      exposure: { enabled: true, protocol: "tcp", publishedPort: 15432 },
    }),
  );
  const catchLabels = (
    (catchAll.services as Record<string, Record<string, unknown>>).postgres!
      .labels
  ) as Record<string, string>;
  assertEquals(
    catchLabels["traefik.tcp.routers.m-00000000-0000-4000-8000-000000000001.rule"],
    "HostSNI(`*`)",
  );
});
