import { assertEquals, assertThrows } from "@std/assert";
import {
  parseArg,
  parseBuildToggleArgs,
  runBuildToggleCli,
} from "./run-build-toggle.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseArg reads --name=value and ignores other flags", () => {
  assertEquals(
    parseArg("ui-mode", ["--force-build=true", "--ui-mode=static"]),
    "static",
  );
  assertEquals(parseArg("ui-mode", ["--instance-run-mode=source"]), undefined);
});

test("parseBuildToggleArgs accepts valid pairs and force-build", () => {
  assertEquals(
    parseBuildToggleArgs([
      "--ui-mode=dev",
      "--instance-run-mode=source",
    ]),
    { uiMode: "dev", instanceRunMode: "source", forceBuild: false },
  );
  assertEquals(
    parseBuildToggleArgs([
      "--ui-mode=static",
      "--instance-run-mode=compiled",
      "--force-build=true",
    ]),
    { uiMode: "static", instanceRunMode: "compiled", forceBuild: true },
  );
});

test("parseBuildToggleArgs rejects invalid or missing flags", () => {
  assertThrows(
    () => parseBuildToggleArgs(["--instance-run-mode=source"]),
    TypeError,
    "Missing or invalid --ui-mode=dev|static",
  );
  assertThrows(
    () => parseBuildToggleArgs(["--ui-mode=dev"]),
    TypeError,
    "Missing or invalid --instance-run-mode=source|compiled",
  );
  assertThrows(
    () =>
      parseBuildToggleArgs([
        "--ui-mode=prod",
        "--instance-run-mode=source",
      ]),
    TypeError,
    "Missing or invalid --ui-mode=dev|static",
  );
});

test("runBuildToggleCli reports parse errors and exits 1", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  await runBuildToggleCli({
    args: ["--ui-mode=prod"],
    exit: (code) => {
      exits.push(code);
    },
    error: (message) => {
      errors.push(message);
    },
  });
  assertEquals(exits, [1]);
  assertEquals(errors[0]?.includes("--ui-mode=dev|static"), true);
});

test("runBuildToggleCli stringifies non-Error throws", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  await runBuildToggleCli({
    args: ["--ui-mode=dev", "--instance-run-mode=source"],
    run: () => Promise.reject("boom"),
    exit: (code) => {
      exits.push(code);
    },
    error: (message) => {
      errors.push(message);
    },
  });
  assertEquals(exits, [1]);
  assertEquals(errors, ["boom"]);
});

test("runBuildToggleCli uses the default error writer on parse failure", async () => {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message: unknown) => {
    errors.push(String(message));
  }) as typeof console.error;
  const exits: number[] = [];
  try {
    await runBuildToggleCli({
      args: ["--ui-mode=prod"],
      exit: (code) => {
        exits.push(code);
      },
    });
  } finally {
    console.error = originalError;
  }
  assertEquals(exits, [1]);
  assertEquals(errors[0]?.includes("--ui-mode=dev|static"), true);
});

test("runBuildToggleCli forwards parsed flags to run", async () => {
  const seen: unknown[] = [];
  await runBuildToggleCli({
    args: [
      "--ui-mode=static",
      "--instance-run-mode=compiled",
      "--force-build=true",
    ],
    run: (parsed) => {
      seen.push(parsed);
      return Promise.resolve();
    },
    exit: () => {
      throw new TypeError("should not exit on success");
    },
  });
  assertEquals(seen, [{
    uiMode: "static",
    instanceRunMode: "compiled",
    forceBuild: true,
  }]);
});
