import { assertEquals } from "@std/assert";
import { InstallerPresentedFailure } from "../src/orchestration/install-presenter-context.ts";
import { runBootstrapOrchestrationCli } from "./bootstrap-orchestration.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("runBootstrapOrchestrationCli exits 1 on InstallerPresentedFailure", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  await runBootstrapOrchestrationCli({
    run: () => Promise.reject(new InstallerPresentedFailure()),
    exit: (code) => {
      exits.push(code);
    },
    error: (message) => {
      errors.push(message);
    },
  });
  assertEquals(exits, [1]);
  assertEquals(errors, []);
});

test("runBootstrapOrchestrationCli logs unexpected failures", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  await runBootstrapOrchestrationCli({
    run: () => Promise.reject(new TypeError("uv missing")),
    exit: (code) => {
      exits.push(code);
    },
    error: (message) => {
      errors.push(message);
    },
  });
  assertEquals(exits, [1]);
  assertEquals(errors[0]?.includes("[bootstrap] uv missing"), true);
});

test("runBootstrapOrchestrationCli succeeds without exiting", async () => {
  const exits: number[] = [];
  await runBootstrapOrchestrationCli({
    run: () => Promise.resolve(),
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(exits, []);
});
