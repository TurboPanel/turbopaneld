import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { managedIngressProject } from "./paths.ts";
import {
  collectManagedIngressEntries,
  dedupeManagedIngressEntries,
  MANAGED_INGRESS_NETWORK,
  managedEntrypointName,
  type ManagedIngressEntry,
  type ManagedIngressIdentity,
  ManagedPortConflictError,
  managedTcpRouterRule,
  managedTraefikCompose,
  removeManagedIngressEntries,
  syncManagedIngressEntries,
} from "./ingress.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const IDENTITY: ManagedIngressIdentity = {
  managedId: "m1",
  serviceId: "00000000-0000-4000-8000-000000000099",
  composeServiceName: "postgres-ingress",
  containerName: "00000000-0000-4000-8000-000000000099-ingress",
};

async function makeTestLayout(): Promise<{
  layout: LayoutPaths;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "tp-managed-ingress-test-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  return { layout, cleanup: () => Deno.remove(root, { recursive: true }) };
}

function entry(
  overrides:
    & Partial<ManagedIngressEntry>
    & Pick<ManagedIngressEntry, "managedId" | "publishedPort">,
): ManagedIngressEntry {
  return {
    protocol: "tcp",
    containerPort: 5432,
    ...overrides,
  };
}

function identityFor(
  managedId: string,
  overrides: Partial<ManagedIngressIdentity> = {},
): ManagedIngressIdentity {
  const serviceId = overrides.serviceId ??
    "00000000-0000-4000-8000-000000000099";
  return {
    managedId,
    serviceId,
    composeServiceName: "postgres-ingress",
    containerName: `${serviceId}-ingress`,
    ...overrides,
  };
}

test("managedIngressProject is per-managedId", () => {
  assertEquals(
    managedIngressProject("abc"),
    "turbopanel-managed-abc-ingress",
  );
});

test("managedTraefikCompose uses managed network and omits tenant HTTP/TLS entrypoints", () => {
  const compose = managedTraefikCompose([], IDENTITY);
  assertStringIncludes(compose, `network=${MANAGED_INGRESS_NETWORK}`);
  assertStringIncludes(compose, `  ${MANAGED_INGRESS_NETWORK}:`);
  assertStringIncludes(compose, "external: true");
  assertStringIncludes(compose, "traefik:v3.6.6");
  if (compose.includes("entrypoints.web")) {
    throw new TypeError(
      "managed Traefik must not declare tenant web entrypoints",
    );
  }
  if (compose.includes("websecure") || compose.includes("proxyProtocol")) {
    throw new TypeError("managed Traefik must not declare TLS/proxyProtocol");
  }
  if (compose.includes("auto_https") || compose.includes("acme")) {
    throw new TypeError("managed Traefik must not enable ACME/auto_https");
  }
});

test("managedTraefikCompose emits container_name, x-turbopanel, and provider constraint", () => {
  const compose = managedTraefikCompose(
    [entry({ managedId: "m1", publishedPort: 15432 })],
    IDENTITY,
  );
  assertStringIncludes(compose, `  ${IDENTITY.composeServiceName}:`);
  assertStringIncludes(
    compose,
    `    container_name: ${IDENTITY.containerName}`,
  );
  assertStringIncludes(compose, "    x-turbopanel:");
  assertStringIncludes(compose, "      kind: ingress");
  assertStringIncludes(compose, `      managedId: ${IDENTITY.managedId}`);
  assertStringIncludes(compose, `      serviceId: ${IDENTITY.serviceId}`);
  assertStringIncludes(
    compose,
    `turbopanel.managed.id: "${IDENTITY.managedId}"`,
  );
  assertStringIncludes(compose, "turbopanel.role: ingress");
  assertStringIncludes(
    compose,
    "--providers.docker.constraints=Label(`turbopanel.managed.id`,`m1`)",
  );
});

test("managedTraefikCompose adds one entrypoint and ports line for this service only", () => {
  const compose = managedTraefikCompose(
    [
      entry({
        managedId: "m1",
        publishedPort: 15432,
        bindAddress: "203.0.113.10",
      }),
    ],
    IDENTITY,
  );
  assertStringIncludes(compose, "--entrypoints.tcp15432.address=:15432");
  assertStringIncludes(compose, '"203.0.113.10:15432:15432/tcp"');
  assertEquals(managedEntrypointName("tcp", 15432), "tcp15432");
  assertEquals(managedEntrypointName("http", 8123), "tcp8123");

  // Own-entries-only: a second managedId's port must not appear when not fed.
  if (compose.includes("udp53") || compose.includes(":53/udp")) {
    throw new TypeError("compose must not include other services' entrypoints");
  }
});

test("managedTraefikCompose defaults bind to 0.0.0.0 and brackets IPv6", () => {
  const v4 = managedTraefikCompose(
    [entry({ managedId: "m1", publishedPort: 15432 })],
    IDENTITY,
  );
  assertStringIncludes(v4, '"0.0.0.0:15432:15432/tcp"');

  const v6 = managedTraefikCompose(
    [
      entry({
        managedId: "m1",
        publishedPort: 15432,
        bindAddress: "2001:db8::10",
      }),
    ],
    IDENTITY,
  );
  assertStringIncludes(v6, '"[2001:db8::10]:15432:15432/tcp"');

  const doc = parse(v6);
  if (!isRecord(doc)) throw new TypeError("expected compose object");
  const services = doc.services;
  if (!isRecord(services)) throw new TypeError("expected services object");
  const traefik = services[IDENTITY.composeServiceName];
  if (!isRecord(traefik)) throw new TypeError("expected ingress service");
  const ports = traefik.ports;
  if (!Array.isArray(ports) || ports.length !== 1) {
    throw new TypeError("expected one ports entry");
  }
  assertEquals(typeof ports[0], "string");
  assertEquals(ports[0], "[2001:db8::10]:15432:15432/tcp");
});

test("managedTraefikCompose rejects invalid bind addresses", () => {
  assertThrows(
    () =>
      managedTraefikCompose(
        [
          entry({
            managedId: "m1",
            publishedPort: 15432,
            bindAddress: "not a valid ip",
          }),
        ],
        IDENTITY,
      ),
    Error,
    "bindAddress contains unsupported characters",
  );
  assertThrows(
    () =>
      managedTraefikCompose(
        [
          entry({
            managedId: "m1",
            publishedPort: 15432,
            bindAddress: "evil;rm -rf /",
          }),
        ],
        IDENTITY,
      ),
    Error,
    "bindAddress contains unsupported characters",
  );
});

test("managedTraefikCompose rejects obsolete <serviceId>-1 ingress containerName", () => {
  assertThrows(
    () =>
      managedTraefikCompose(
        [entry({ managedId: "m1", publishedPort: 15432 })],
        {
          ...IDENTITY,
          containerName: `${IDENTITY.serviceId}-1`,
        },
      ),
    Error,
    "ingress containerName must equal <serviceId>-ingress",
  );
});

test("managedTraefikCompose dedupes and sorts entries for a stable diff", () => {
  const a = managedTraefikCompose(
    [
      entry({ managedId: "m1", publishedPort: 15433 }),
      entry({ managedId: "m1", publishedPort: 15432 }),
      entry({ managedId: "m1-dup", publishedPort: 15432 }),
    ],
    IDENTITY,
  );
  const b = managedTraefikCompose(
    dedupeManagedIngressEntries([
      entry({ managedId: "m1", publishedPort: 15432 }),
      entry({ managedId: "m1", publishedPort: 15433 }),
    ]),
    IDENTITY,
  );
  assertEquals(a, b);
  const tcp15432Count = a.split("entrypoints.tcp15432").length - 1;
  assertEquals(tcp15432Count, 1);
});

test("managedTcpRouterRule uses catch-all when supportsSni is false", () => {
  assertEquals(
    managedTcpRouterRule(
      { sni: { hostnames: ["db.example.com"] } },
      false,
    ),
    "HostSNI(`*`)",
  );
  assertEquals(managedTcpRouterRule({}, false), "HostSNI(`*`)");
});

test("managedTcpRouterRule selects explicit HostSNI when supportsSni is true", () => {
  assertEquals(
    managedTcpRouterRule(
      { sni: { hostnames: ["ch.example.com", "ch2.example.com"] } },
      true,
    ),
    "HostSNI(`ch.example.com`,`ch2.example.com`)",
  );
  assertEquals(managedTcpRouterRule({}, true), "HostSNI(`*`)");
  assertEquals(
    managedTcpRouterRule({ sni: { hostnames: [] } }, true),
    "HostSNI(`*`)",
  );
});

test("managedTcpRouterRule rejects hostile SNI hostnames", () => {
  assertThrows(
    () =>
      managedTcpRouterRule(
        { sni: { hostnames: ["bad`hostname"] } },
        true,
      ),
    Error,
    "unsupported character",
  );
});

test("syncManagedIngressEntries persists own entries and remove short-circuits", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const ownA = await syncManagedIngressEntries(layout, "svc-a", [
      entry({ managedId: "svc-a", publishedPort: 15432 }),
    ]);
    assertEquals(ownA.length, 1);
    assertEquals(ownA[0]?.managedId, "svc-a");

    const ownB = await syncManagedIngressEntries(layout, "svc-b", [
      entry({
        managedId: "svc-b",
        protocol: "udp",
        publishedPort: 53,
        containerPort: 53,
      }),
    ]);
    // Own entries only — not the merged host-wide set.
    assertEquals(ownB.length, 1);
    assertEquals(ownB[0]?.managedId, "svc-b");

    const all = await collectManagedIngressEntries(layout);
    assertEquals(all.length, 2);

    const stateA = join(
      layout.stateDir,
      "managed",
      "ingress",
      "svc-a.json",
    );
    await Deno.stat(stateA);

    const remainingAfterRemoveA = await removeManagedIngressEntries(
      layout,
      "svc-a",
    );
    assertEquals(remainingAfterRemoveA?.length, 1);
    assertEquals(remainingAfterRemoveA?.[0]?.managedId, "svc-b");

    const noopRemove = await removeManagedIngressEntries(layout, "svc-a");
    assertEquals(noopRemove, null);
  } finally {
    await cleanup();
  }
});

test("syncManagedIngressEntries throws ManagedPortConflictError with no partial write", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await syncManagedIngressEntries(layout, "svc-a", [
      entry({ managedId: "svc-a", publishedPort: 15432 }),
    ]);
    await assertRejects(
      () =>
        syncManagedIngressEntries(layout, "svc-b", [
          entry({ managedId: "svc-b", publishedPort: 15432 }),
        ]),
      ManagedPortConflictError,
    );

    try {
      await Deno.stat(
        join(layout.stateDir, "managed", "ingress", "svc-b.json"),
      );
      throw new TypeError("svc-b.json must not exist after conflict");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    const all = await collectManagedIngressEntries(layout);
    assertEquals(all.length, 1);
    assertEquals(all[0]?.managedId, "svc-a");
  } finally {
    await cleanup();
  }
});

test("syncManagedIngressEntries rejects http/tcp same-port claims with no partial write", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await syncManagedIngressEntries(layout, "svc-http", [
      entry({
        managedId: "svc-http",
        protocol: "http",
        publishedPort: 8123,
        containerPort: 8123,
      }),
    ]);
    await assertRejects(
      () =>
        syncManagedIngressEntries(layout, "svc-tcp", [
          entry({
            managedId: "svc-tcp",
            protocol: "tcp",
            publishedPort: 8123,
            containerPort: 8123,
          }),
        ]),
      ManagedPortConflictError,
    );

    try {
      await Deno.stat(
        join(layout.stateDir, "managed", "ingress", "svc-tcp.json"),
      );
      throw new TypeError(
        "svc-tcp.json must not exist after http/tcp conflict",
      );
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    const all = await collectManagedIngressEntries(layout);
    assertEquals(all.length, 1);
    assertEquals(all[0]?.managedId, "svc-http");
    assertEquals(all[0]?.protocol, "http");
  } finally {
    await cleanup();
  }
});

test("syncManagedIngressEntries serializes concurrent same-port applies — only one claims the port", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const results = await Promise.allSettled([
      syncManagedIngressEntries(layout, "svc-a", [
        entry({ managedId: "svc-a", publishedPort: 25432 }),
      ]),
      syncManagedIngressEntries(layout, "svc-b", [
        entry({ managedId: "svc-b", publishedPort: 25432 }),
      ]),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assertEquals(fulfilled.length, 1);
    assertEquals(rejected.length, 1);
    if (rejected[0]?.status === "rejected") {
      if (!(rejected[0].reason instanceof ManagedPortConflictError)) {
        throw new TypeError(
          "expected the losing concurrent apply to reject with ManagedPortConflictError",
        );
      }
    }

    const all = await collectManagedIngressEntries(layout);
    assertEquals(all.length, 1);
    assertEquals(all[0]?.publishedPort, 25432);
  } finally {
    await cleanup();
  }
});

test("collectManagedIngressEntries rejects corrupt/partially-written state with a clear error", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const dir = join(layout.stateDir, "managed", "ingress");
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

    await Deno.writeTextFile(
      join(dir, "svc-crashed.json"),
      '[{"managedId":"svc-crashed","protocol":"tcp","publishedPort":543',
    );

    await assertRejects(
      () => collectManagedIngressEntries(layout),
      Error,
      "corrupt managed ingress state file",
    );
  } finally {
    await cleanup();
  }
});

test("collectManagedIngressEntries rejects a persisted entry that fails shape validation", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const dir = join(layout.stateDir, "managed", "ingress");
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(dir, "svc-bad-shape.json"),
      JSON.stringify([{ managedId: "svc-bad-shape", publishedPort: 99999 }]),
    );

    await assertRejects(
      () => collectManagedIngressEntries(layout),
      Error,
      "corrupt managed ingress state file",
    );
  } finally {
    await cleanup();
  }
});

test("syncManagedIngressEntries never leaves a temp file behind after a successful write", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    await syncManagedIngressEntries(layout, "svc-a", [
      entry({ managedId: "svc-a", publishedPort: 15432 }),
    ]);

    const dir = join(layout.stateDir, "managed", "ingress");
    const names: string[] = [];
    for await (const dirEntry of Deno.readDir(dir)) names.push(dirEntry.name);
    assertEquals(names, ["svc-a.json"]);
  } finally {
    await cleanup();
  }
});

test("managedTraefikCompose identity managedId is used in constraint", () => {
  const compose = managedTraefikCompose(
    [entry({ managedId: "svc-z", publishedPort: 15432 })],
    identityFor("svc-z"),
  );
  assertStringIncludes(
    compose,
    "Label(`turbopanel.managed.id`,`svc-z`)",
  );
});
