import { assertEquals } from "@std/assert";
import {
  allProjects,
  liveProjects,
  manifestGenerations,
  parseGenerations,
  parsePrevious,
  singleGeneration,
} from "./deployment-generations.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("a manifest without generations reads as one live blue project", () => {
  const m = { projectName: "app", generation: 4 };
  assertEquals(manifestGenerations(m), [singleGeneration("app", 4)]);
  assertEquals(liveProjects(m), ["app"]);
  assertEquals(allProjects(m), ["app"]);
});

test("liveProjects returns the live color only, allProjects every project", () => {
  const m = {
    projectName: "app",
    generation: 5,
    generations: [
      { color: "blue", generation: 4, projectName: "app", state: "draining" },
      {
        color: "green",
        generation: 5,
        projectName: "app-green",
        state: "live",
      },
    ] as const,
  };
  assertEquals(liveProjects(m), ["app-green"]);
  assertEquals(allProjects(m), ["app", "app-green"]);
});

test("an empty generations list falls back to the implied blue one", () => {
  assertEquals(
    liveProjects({ projectName: "app", generation: 1, generations: [] }),
    ["app"],
  );
});

test("parseGenerations drops malformed rows and keeps good ones", () => {
  const good = {
    color: "blue",
    generation: 2,
    projectName: "p",
    state: "live",
  };
  assertEquals(
    parseGenerations([
      good,
      { ...good, color: "red" },
      { ...good, state: "gone" },
      { ...good, projectName: "" },
      { ...good, generation: -1 },
      { ...good, generation: 1.5 },
      null,
      "x",
    ]),
    [good],
  );
  assertEquals(parseGenerations("nope"), []);
});

test("parsePrevious validates the digest and fields", () => {
  const sha = "a".repeat(64);
  assertEquals(
    parsePrevious({ generation: 1, projectName: "p", composeSha256: sha }),
    { generation: 1, projectName: "p", composeSha256: sha },
  );
  assertEquals(
    parsePrevious({ generation: 1, projectName: "p", composeSha256: "short" }),
    null,
  );
  assertEquals(parsePrevious({ generation: -1, projectName: "p" }), null);
  assertEquals(parsePrevious(null), null);
});
