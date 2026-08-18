import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "./docker-cli.ts";
import { ensureExternalDockerNetworks } from "./ensure-docker-networks.ts";

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
