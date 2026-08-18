import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  ensureManagedIngressNetwork,
  MANAGED_INGRESS_NETWORK,
} from "./networks.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("ensureManagedIngressNetwork is a no-op when the network already exists", async () => {
  const calls: string[][] = [];
  await ensureManagedIngressNetwork((args) => {
    calls.push([...args]);
    return Promise.resolve(
      {
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      } satisfies DockerCliResult,
    );
  });

  assertEquals(calls, [["network", "inspect", MANAGED_INGRESS_NETWORK]]);
});

test("ensureManagedIngressNetwork creates the network when inspect fails", async () => {
  const calls: string[][] = [];
  await ensureManagedIngressNetwork((args) => {
    calls.push([...args]);
    if (args[1] === "inspect") {
      return Promise.resolve(
        {
          success: false,
          stdout: "",
          stderr: "not found",
          code: 1,
        } satisfies DockerCliResult,
      );
    }
    return Promise.resolve(
      {
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      } satisfies DockerCliResult,
    );
  });

  assertEquals(calls, [
    ["network", "inspect", MANAGED_INGRESS_NETWORK],
    ["network", "create", MANAGED_INGRESS_NETWORK],
  ]);
});

test("ensureManagedIngressNetwork throws when create fails", async () => {
  await assertRejects(
    () =>
      ensureManagedIngressNetwork((args) => {
        if (args[1] === "inspect") {
          return Promise.resolve(
            {
              success: false,
              stdout: "",
              stderr: "",
              code: 1,
            } satisfies DockerCliResult,
          );
        }
        return Promise.resolve(
          {
            success: false,
            stdout: "",
            stderr: "permission denied",
            code: 1,
          } satisfies DockerCliResult,
        );
      }),
    Error,
    "permission denied",
  );
});

test("ensureManagedIngressNetwork falls back to a generic message when create stderr is empty", async () => {
  await assertRejects(
    () =>
      ensureManagedIngressNetwork((args) => {
        if (args[1] === "inspect") {
          return Promise.resolve(
            {
              success: false,
              stdout: "",
              stderr: "",
              code: 1,
            } satisfies DockerCliResult,
          );
        }
        return Promise.resolve(
          {
            success: false,
            stdout: "",
            stderr: "",
            code: 1,
          } satisfies DockerCliResult,
        );
      }),
    Error,
    `Creating managed ingress Docker network ${MANAGED_INGRESS_NETWORK} failed`,
  );
});
