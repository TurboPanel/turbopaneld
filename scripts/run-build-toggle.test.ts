import { assertEquals, assertThrows } from "@std/assert";
import { parseArg, parseBuildToggleArgs } from "./run-build-toggle.ts";

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
