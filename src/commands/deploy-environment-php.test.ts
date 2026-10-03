import { assertEquals } from "@std/assert";
import type { EnvironmentDeploySite } from "../contracts/commands-contracts.ts";
import { deployPrincipalSpecs } from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ALICE = { principalId: "p-alice", username: "alice" };
const BOB = { principalId: "p-bob", username: "bob" };

function phpSite(
  name: string,
  principal: typeof ALICE,
  php: EnvironmentDeploySite["php"],
  engine: EnvironmentDeploySite["engine"] = "nginx",
): EnvironmentDeploySite {
  return {
    composeServiceName: name,
    engine,
    root: "public",
    listenPort: 18080,
    principal,
    ...(php ? { php } : {}),
  };
}

test("a per-site PHP runtime implies its PHP series for the site's principal", () => {
  const specs = deployPrincipalSpecs({
    sites: [
      phpSite("a", ALICE, { version: "8.3", mode: "fastcgi" }),
      phpSite("b", ALICE, { mode: "fpm" }),
      phpSite("c", ALICE, { version: "8.4", mode: "fpm" }, "apache"),
      // Shared master or another engine: the daemon runs nothing as bob.
      phpSite("d", BOB, { version: "8.4" }),
      phpSite("e", BOB, { version: "8.4", mode: "fastcgi" }, "openlitespeed"),
    ],
  }, [
    { ...ALICE, runtimes: [{ runtime: "node", series: "24" }] },
    BOB,
  ]);
  assertEquals(specs, [
    {
      ...ALICE,
      runtimes: [
        { runtime: "node", series: "24" },
        { runtime: "php", series: "8.3" },
        { runtime: "php", series: "8.4" },
      ],
    },
    BOB,
  ]);
});

test("an entitlement the wire already grants is not repeated", () => {
  const granted = {
    ...ALICE,
    runtimes: [{ runtime: "php", series: "8.4" }],
  };
  assertEquals(
    deployPrincipalSpecs({
      sites: [phpSite("a", ALICE, { version: "8.4", mode: "fastcgi" })],
    }, [granted]),
    [granted],
  );
});
