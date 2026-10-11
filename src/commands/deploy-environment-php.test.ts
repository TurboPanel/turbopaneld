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

test("a per-site PHP runtime adds no runtime grant to the site's owner", () => {
  // Every installed PHP series may be run by every site owner's Linux user,
  // so the deploy passes its principals through unchanged.
  const payload = {
    sites: [
      phpSite("a", ALICE, { version: "8.3", mode: "fastcgi" }),
      phpSite("b", BOB, { version: "8.4", mode: "fpm" }, "apache"),
    ],
  };
  const specs = deployPrincipalSpecs(payload, [ALICE, BOB]);
  assertEquals(specs, [ALICE, BOB]);
});
