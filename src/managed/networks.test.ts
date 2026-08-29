import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  containerMissesManagedNetwork,
  containerNamesFromNetworkInspect,
  ensureContainerJoinedManagedNetwork,
  ensureManagedIngressNetwork,
  pruneStaleManagedDockerNetworks,
  RETIRED_MANAGED_NETWORK_NAME,
  staleManagedDockerNetworkNames,
} from "./networks.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Managed network names are the `network(kind='managed')` row's bare UUID. */
const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

function okResult(): DockerCliResult {
  return { success: true, stdout: "", stderr: "", code: 0 };
}

function failResult(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

test("ensureManagedIngressNetwork is a no-op when the network already exists", async () => {
  const calls: string[][] = [];
  await ensureManagedIngressNetwork(MANAGED_NETWORK, (args) => {
    calls.push([...args]);
    return Promise.resolve(okResult());
  });

  assertEquals(calls, [["network", "inspect", MANAGED_NETWORK]]);
});

test("ensureManagedIngressNetwork creates the network when inspect fails", async () => {
  const calls: string[][] = [];
  await ensureManagedIngressNetwork(MANAGED_NETWORK, (args) => {
    calls.push([...args]);
    if (args[1] === "inspect") {
      return Promise.resolve(failResult("not found"));
    }
    return Promise.resolve(okResult());
  });

  assertEquals(calls, [
    ["network", "inspect", MANAGED_NETWORK],
    ["network", "create", MANAGED_NETWORK],
  ]);
});

test("ensureManagedIngressNetwork uses the name it is given, never a constant", async () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const calls: string[][] = [];
  await ensureManagedIngressNetwork(other, (args) => {
    calls.push([...args]);
    return Promise.resolve(okResult());
  });

  assertEquals(calls, [["network", "inspect", other]]);
});

test("ensureManagedIngressNetwork throws when create fails", async () => {
  await assertRejects(
    () =>
      ensureManagedIngressNetwork(MANAGED_NETWORK, (args) =>
        Promise.resolve(
          args[1] === "inspect"
            ? failResult("")
            : failResult("permission denied"),
        )),
    Error,
    "permission denied",
  );
});

test("ensureManagedIngressNetwork falls back to a generic message when create stderr is empty", async () => {
  await assertRejects(
    () =>
      ensureManagedIngressNetwork(
        MANAGED_NETWORK,
        () => Promise.resolve(failResult("")),
      ),
    Error,
    `Creating managed ingress Docker network ${MANAGED_NETWORK} failed`,
  );
});

test("ensureManagedIngressNetwork rejects a malformed name before touching Docker", async () => {
  for (const bad of ["", "-leading-hyphen", "has space", "semi;colon", "a/b"]) {
    const calls: string[][] = [];
    await assertRejects(
      () =>
        ensureManagedIngressNetwork(bad, (args) => {
          calls.push([...args]);
          return Promise.resolve(okResult());
        }),
      Error,
      "managed network name contains unsupported characters",
    );
    assertEquals(calls, []);
  }
});

test("staleManagedDockerNetworkNames includes the retired name and a previous compose name", () => {
  assertEquals(
    staleManagedDockerNetworkNames(
      MANAGED_NETWORK,
      RETIRED_MANAGED_NETWORK_NAME,
    ),
    [RETIRED_MANAGED_NETWORK_NAME],
  );
  assertEquals(
    staleManagedDockerNetworkNames(MANAGED_NETWORK, "old-net"),
    ["old-net", RETIRED_MANAGED_NETWORK_NAME].sort((a, b) =>
      a.localeCompare(b)
    ),
  );
  assertEquals(
    staleManagedDockerNetworkNames(RETIRED_MANAGED_NETWORK_NAME, null),
    [],
  );
});

test("containerMissesManagedNetwork treats empty inspect as unknown", () => {
  assertEquals(containerMissesManagedNetwork([], MANAGED_NETWORK), false);
  assertEquals(
    containerMissesManagedNetwork([MANAGED_NETWORK], MANAGED_NETWORK),
    false,
  );
  assertEquals(
    containerMissesManagedNetwork(
      [RETIRED_MANAGED_NETWORK_NAME],
      MANAGED_NETWORK,
    ),
    true,
  );
});

test("containerNamesFromNetworkInspect reads Docker inspect JSON", () => {
  const stdout = JSON.stringify([
    {
      Name: RETIRED_MANAGED_NETWORK_NAME,
      Containers: {
        abc: { Name: "frontend-in" },
        def: { Name: "engine-1" },
      },
    },
  ]);
  assertEquals(containerNamesFromNetworkInspect(stdout), [
    "engine-1",
    "frontend-in",
  ]);
  assertEquals(containerNamesFromNetworkInspect("not-json"), []);
});

test("pruneStaleManagedDockerNetworks skips empty inspect stdout", async () => {
  const calls: string[][] = [];
  await pruneStaleManagedDockerNetworks(
    MANAGED_NETWORK,
    RETIRED_MANAGED_NETWORK_NAME,
    (args) => {
      calls.push([...args]);
      return Promise.resolve(okResult());
    },
    { disconnect: true },
  );
  assertEquals(calls, [
    ["network", "inspect", RETIRED_MANAGED_NETWORK_NAME],
  ]);
});

test("pruneStaleManagedDockerNetworks disconnects then removes an occupied leftover", async () => {
  const calls: string[][] = [];
  await pruneStaleManagedDockerNetworks(
    MANAGED_NETWORK,
    RETIRED_MANAGED_NETWORK_NAME,
    (args) => {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") {
        return Promise.resolve({
          success: true,
          stdout: JSON.stringify([{
            Containers: { abc: { Name: "frontend-in" } },
          }]),
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve(okResult());
    },
    { disconnect: true },
  );
  assertEquals(calls, [
    ["network", "inspect", RETIRED_MANAGED_NETWORK_NAME],
    [
      "network",
      "disconnect",
      "-f",
      RETIRED_MANAGED_NETWORK_NAME,
      "frontend-in",
    ],
    ["network", "rm", RETIRED_MANAGED_NETWORK_NAME],
  ]);
});

test("pruneStaleManagedDockerNetworks leaves occupied leftovers when disconnect is false", async () => {
  const calls: string[][] = [];
  await pruneStaleManagedDockerNetworks(
    MANAGED_NETWORK,
    null,
    (args) => {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") {
        return Promise.resolve({
          success: true,
          stdout: JSON.stringify([{
            Containers: { abc: { Name: "frontend-in" } },
          }]),
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve(okResult());
    },
    { disconnect: false },
  );
  assertEquals(calls, [
    ["network", "inspect", RETIRED_MANAGED_NETWORK_NAME],
  ]);
});

test("ensureContainerJoinedManagedNetwork is a no-op when already attached", async () => {
  const calls: string[][] = [];
  const joined = await ensureContainerJoinedManagedNetwork(
    "frontend-in",
    MANAGED_NETWORK,
    (args) => {
      calls.push([...args]);
      return Promise.resolve({
        success: true,
        stdout: `${MANAGED_NETWORK}\n`,
        stderr: "",
        code: 0,
      });
    },
  );
  assertEquals(joined, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0][0], "inspect");
});

test("ensureContainerJoinedManagedNetwork connects when the container is on a leftover", async () => {
  const calls: string[][] = [];
  const joined = await ensureContainerJoinedManagedNetwork(
    "frontend-in",
    MANAGED_NETWORK,
    (args) => {
      calls.push([...args]);
      if (args[0] === "inspect") {
        return Promise.resolve({
          success: true,
          stdout: "turbopanel-managed\n",
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve(okResult());
    },
  );
  assertEquals(joined, true);
  assertEquals(calls[1], [
    "network",
    "connect",
    MANAGED_NETWORK,
    "frontend-in",
  ]);
});

test("ensureContainerJoinedManagedNetwork treats already-connected stderr as success", async () => {
  const joined = await ensureContainerJoinedManagedNetwork(
    "frontend-in",
    MANAGED_NETWORK,
    (args) => {
      if (args[0] === "inspect") {
        return Promise.resolve({
          success: true,
          stdout: "turbopanel-managed\n",
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve(
        failResult("endpoint with name frontend-in already exists in network"),
      );
    },
  );
  assertEquals(joined, true);
});
