import { assertEquals } from "@std/assert";
import type { EnvironmentDeploySite } from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { removeLeftSites } from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const layout = resolveLayout({}, {
  skipDiscovery: true,
  forceMode: "production",
});

const site = (composeServiceName: string): EnvironmentDeploySite => ({
  composeServiceName,
  engine: "caddy",
  root: "public",
  listenPort: 18557,
});

function recorder() {
  const calls: Array<{ environmentId: string; names: readonly string[] }> = [];
  return {
    calls,
    removeNamed: (
      _layout: unknown,
      environmentId: string,
      names: readonly string[],
    ) => {
      calls.push({ environmentId, names });
      return Promise.resolve([...names]);
    },
  };
}

test("a payload that names no removed site removes nothing, whatever sites it lists", async () => {
  for (
    const payload of [
      { environmentId: "env", sites: [site("www")] },
      { environmentId: "env", sites: [] },
      { environmentId: "env" },
      { environmentId: "env", sites: [site("www")], removedSites: [] },
      { environmentId: "env", removedSites: [] },
    ]
  ) {
    const { calls, removeNamed } = recorder();
    assertEquals(
      await removeLeftSites(layout, payload, removeNamed as never),
      [],
    );
    assertEquals(calls, []);
  }
});

test("only the named sites of this environment are removed, and never one the deploy still has", async () => {
  const { calls, removeNamed } = recorder();
  const removed = await removeLeftSites(
    layout,
    {
      environmentId: "env",
      sites: [site("www")],
      removedSites: ["plain", "www", "old"],
    },
    removeNamed as never,
  );
  assertEquals(removed, ["plain", "old"]);
  assertEquals(calls, [{ environmentId: "env", names: ["plain", "old"] }]);
});

test("a failed removal is logged and does not fail the deploy", async () => {
  const removed = await removeLeftSites(
    layout,
    { environmentId: "env", removedSites: ["plain"] },
    (() => Promise.reject(new Error("tp-host refused"))) as never,
  );
  assertEquals(removed, []);
});
