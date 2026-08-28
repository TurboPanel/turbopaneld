import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { ensureManagedIngressNetwork } from "./networks.ts";

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
