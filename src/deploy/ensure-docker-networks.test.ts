import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { DockerCliResult } from "./docker-cli.ts";
import {
  buildDockerNetworkCreateArgs,
  ensureExternalDockerNetworks,
  parseInspectedSubnets,
} from "./ensure-docker-networks.ts";

/** Capture structured WARN lines (the logger writes them to stderr). */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const original = Deno.stderr.writeSync.bind(Deno.stderr);
  Deno.stderr.writeSync = (data: Uint8Array) => {
    chunks.push(decoder.decode(data));
    return data.byteLength;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      Deno.stderr.writeSync = original;
    },
  };
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function ok(): DockerCliResult {
  return { success: true, stdout: "", stderr: "", code: 0 };
}

function fail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

test("ensureExternalDockerNetworks no-ops on an empty list", async () => {
  const calls: string[][] = [];
  await ensureExternalDockerNetworks([], (args) => {
    calls.push([...args]);
    return Promise.resolve(ok());
  });
  assertEquals(calls, []);
});

test("ensureExternalDockerNetworks skips create when inspect succeeds", async () => {
  const calls: string[][] = [];
  await ensureExternalDockerNetworks(["tp_frontend"], (args) => {
    calls.push([...args]);
    return Promise.resolve(ok());
  });
  assertEquals(calls, [["network", "inspect", "tp_frontend"]]);
});

test("ensureExternalDockerNetworks creates when inspect fails", async () => {
  const calls: string[][] = [];
  await ensureExternalDockerNetworks(["tp_backend"], (args) => {
    calls.push([...args]);
    if (args[1] === "inspect") return Promise.resolve(fail("not found"));
    return Promise.resolve(ok());
  });
  assertEquals(calls, [
    ["network", "inspect", "tp_backend"],
    ["network", "create", "tp_backend"],
  ]);
});

test("ensureExternalDockerNetworks rejects invalid names before docker", async () => {
  await assertRejects(
    () =>
      ensureExternalDockerNetworks(["bad name"], () => Promise.resolve(ok())),
    Error,
    "Invalid docker network name",
  );
});

test("ensureExternalDockerNetworks surfaces create failures", async () => {
  await assertRejects(
    () =>
      ensureExternalDockerNetworks(["tp_fail"], (args) => {
        if (args[1] === "inspect") return Promise.resolve(fail("missing"));
        return Promise.resolve(fail("create denied"));
      }),
    Error,
    "create denied",
  );
});

function inspectJson(subnets: string[]): string {
  return JSON.stringify([{
    Name: "x",
    IPAM: { Config: subnets.map((Subnet) => ({ Subnet })) },
  }]);
}

test("ensureExternalDockerNetworks bare specs create exactly as bare names do", async () => {
  const calls: string[][] = [];
  await ensureExternalDockerNetworks([{ name: "tp_backend" }], (args) => {
    calls.push([...args]);
    if (args[1] === "inspect") return Promise.resolve(fail("not found"));
    return Promise.resolve(ok());
  });
  assertEquals(calls, [
    ["network", "inspect", "tp_backend"],
    ["network", "create", "tp_backend"],
  ]);
});

test("buildDockerNetworkCreateArgs appends each addressing flag only when present", () => {
  assertEquals(buildDockerNetworkCreateArgs({ name: "edge" }), [
    "network",
    "create",
    "edge",
  ]);
  assertEquals(
    buildDockerNetworkCreateArgs({ name: "edge", subnet: "10.77.0.0/16" }),
    ["network", "create", "--subnet", "10.77.0.0/16", "edge"],
  );
  assertEquals(
    buildDockerNetworkCreateArgs({
      name: "edge",
      subnet: "10.77.0.0/16",
      ipRange: "10.77.8.0/24",
      gateway: "10.77.0.1",
      mtu: 1450,
    }),
    [
      "network",
      "create",
      "--subnet",
      "10.77.0.0/16",
      "--ip-range",
      "10.77.8.0/24",
      "--gateway",
      "10.77.0.1",
      "--opt",
      "com.docker.network.driver.mtu=1450",
      "edge",
    ],
  );
  assertEquals(
    buildDockerNetworkCreateArgs({ name: "edge", mtu: 9000 }),
    [
      "network",
      "create",
      "--opt",
      "com.docker.network.driver.mtu=9000",
      "edge",
    ],
  );
});

test("buildDockerNetworkCreateArgs validates every value before interpolation", () => {
  assertThrows(
    () => buildDockerNetworkCreateArgs({ name: "edge", subnet: "10.77.0.0" }),
    Error,
    "Invalid docker network subnet",
  );
  assertThrows(
    () =>
      buildDockerNetworkCreateArgs({
        name: "edge",
        subnet: "10.77.0.0/16 --internal",
      }),
    Error,
    "Invalid docker network subnet",
  );
  assertThrows(
    () => buildDockerNetworkCreateArgs({ name: "edge", ipRange: "$(id)" }),
    Error,
    "Invalid docker network ipRange",
  );
  assertThrows(
    () =>
      buildDockerNetworkCreateArgs({ name: "edge", gateway: "10.77.0.1/16" }),
    Error,
    "Invalid docker network gateway",
  );
  assertThrows(
    () => buildDockerNetworkCreateArgs({ name: "edge", mtu: 1279 }),
    Error,
    "Invalid docker network mtu",
  );
  assertThrows(
    () => buildDockerNetworkCreateArgs({ name: "edge", mtu: 9001 }),
    Error,
    "Invalid docker network mtu",
  );
});

test("buildDockerNetworkCreateArgs refuses ipRange and gateway outside (or without) the subnet", () => {
  // Same containment the contract parser enforces — a descriptor built any
  // other way still cannot hand Docker inconsistent addressing.
  assertThrows(
    () =>
      buildDockerNetworkCreateArgs({
        name: "edge",
        subnet: "10.77.0.0/16",
        ipRange: "10.78.8.0/24",
      }),
    Error,
    "Invalid docker network ipRange for edge: 10.78.8.0/24 is not inside subnet 10.77.0.0/16",
  );
  assertThrows(
    () =>
      buildDockerNetworkCreateArgs({
        name: "edge",
        subnet: "10.77.0.0/16",
        gateway: "10.78.0.1",
      }),
    Error,
    "Invalid docker network gateway for edge: 10.78.0.1 is not inside subnet 10.77.0.0/16",
  );
  // Docker refuses either flag without --subnet; so does the builder.
  assertThrows(
    () =>
      buildDockerNetworkCreateArgs({ name: "edge", ipRange: "10.77.8.0/24" }),
    Error,
    "Invalid docker network ipRange for edge: 10.77.8.0/24 is not inside subnet (none)",
  );
  assertThrows(
    () => buildDockerNetworkCreateArgs({ name: "edge", gateway: "10.77.0.1" }),
    Error,
    "Invalid docker network gateway for edge: 10.77.0.1 is not inside subnet (none)",
  );
  // A mixed family never matches.
  assertThrows(
    () =>
      buildDockerNetworkCreateArgs({
        name: "edge",
        subnet: "fd00:77::/64",
        gateway: "10.77.0.1",
      }),
    Error,
    "Invalid docker network gateway",
  );
  assertEquals(
    buildDockerNetworkCreateArgs({
      name: "edge",
      subnet: "fd00:77::/64",
      ipRange: "fd00:77::/80",
      gateway: "fd00:77::1",
    }),
    [
      "network",
      "create",
      "--subnet",
      "fd00:77::/64",
      "--ip-range",
      "fd00:77::/80",
      "--gateway",
      "fd00:77::1",
      "edge",
    ],
  );
});

test("ensureExternalDockerNetworks never calls docker for an out-of-subnet spec", async () => {
  const calls: string[][] = [];
  await assertRejects(
    () =>
      ensureExternalDockerNetworks(
        [{ name: "edge", subnet: "10.77.0.0/16", gateway: "10.78.0.1" }],
        (args) => {
          calls.push([...args]);
          return Promise.resolve(ok());
        },
      ),
    Error,
    "Invalid docker network gateway",
  );
  assertEquals(calls, []);
});

test("ensureExternalDockerNetworks creates with the requested addressing when inspect fails", async () => {
  const calls: string[][] = [];
  await ensureExternalDockerNetworks(
    [{ name: "edge", subnet: "10.77.0.0/16", gateway: "10.77.0.1", mtu: 1450 }],
    (args) => {
      calls.push([...args]);
      if (args[1] === "inspect") return Promise.resolve(fail("not found"));
      return Promise.resolve(ok());
    },
  );
  assertEquals(calls, [
    ["network", "inspect", "edge"],
    [
      "network",
      "create",
      "--subnet",
      "10.77.0.0/16",
      "--gateway",
      "10.77.0.1",
      "--opt",
      "com.docker.network.driver.mtu=1450",
      "edge",
    ],
  ]);
});

test("ensureExternalDockerNetworks never recreates an existing network — subnet drift only warns", async () => {
  const stderr = captureStderr();
  try {
    const calls: string[][] = [];
    await ensureExternalDockerNetworks(
      [
        { name: "drifted", subnet: "10.77.0.0/16" },
        { name: "matching", subnet: "10.78.0.0/16" },
        { name: "unknown-ipam", subnet: "10.79.0.0/16" },
      ],
      (args) => {
        calls.push([...args]);
        if (args[2] === "drifted") {
          return Promise.resolve({
            ...ok(),
            stdout: inspectJson(["10.99.0.0/16"]),
          });
        }
        if (args[2] === "matching") {
          return Promise.resolve({
            ...ok(),
            stdout: inspectJson(["10.78.0.0/16"]),
          });
        }
        return Promise.resolve({ ...ok(), stdout: "not json" });
      },
    );
    assertEquals(calls, [
      ["network", "inspect", "drifted"],
      ["network", "inspect", "matching"],
      ["network", "inspect", "unknown-ipam"],
    ]);
    const warnings = stderr.text().split("\n").filter((line) =>
      line.includes(" WARN ")
    );
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]?.includes("drifted"), true);
    assertEquals(warnings[0]?.includes("10.99.0.0/16"), true);
    assertEquals(warnings[0]?.includes("10.77.0.0/16"), true);
  } finally {
    stderr.restore();
  }
});

test("parseInspectedSubnets reads IPAM config and tolerates garbage", () => {
  assertEquals(
    parseInspectedSubnets(inspectJson(["10.1.0.0/16", "fd00::/64"])),
    [
      "10.1.0.0/16",
      "fd00::/64",
    ],
  );
  assertEquals(parseInspectedSubnets("[]"), []);
  assertEquals(parseInspectedSubnets("{}"), []);
  assertEquals(parseInspectedSubnets("nope"), []);
  assertEquals(
    parseInspectedSubnets(JSON.stringify([{ IPAM: { Config: null } }])),
    [],
  );
});
