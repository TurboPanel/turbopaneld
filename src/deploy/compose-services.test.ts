import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "./docker-cli.ts";
import {
  composeFilesHaveContainerServices,
  composeHasContainerServices,
  resolveComposeModel,
  validateComposeConfig,
} from "./compose-services.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function mockRun(
  handler: (args: string[]) => DockerCliResult | Promise<DockerCliResult>,
) {
  return (args: string[]) => Promise.resolve(handler(args));
}

test("composeHasContainerServices treats parse failures as possibly having services", () => {
  assertEquals(composeHasContainerServices("services:\n  web: ["), true);
});

test("composeHasContainerServices is false for empty or non-object services", () => {
  assertEquals(composeHasContainerServices("services: {}\n"), false);
  assertEquals(composeHasContainerServices("version: '3.8'\n"), false);
  assertEquals(composeHasContainerServices("[]"), false);
});

test("composeFilesHaveContainerServices is true when any layer declares a service", () => {
  assertEquals(
    composeFilesHaveContainerServices(["services: {}\n", "services:\n  web:\n    image: nginx\n"]),
    true,
  );
  assertEquals(
    composeFilesHaveContainerServices(["services: {}\n", "version: '3.8'\n"]),
    false,
  );
});

test("composeHasContainerServices parses Compose scalar tag bodies", () => {
  assertEquals(
    composeHasContainerServices(`services:
  web:
    image: nginx
    restart: !reset null
    environment: !override ~
`),
    true,
  );
});

test("resolveComposeModel parses docker compose config JSON", async () => {
  const model = await resolveComposeModel(
    "proj",
    ["/tmp/compose.yaml"],
    mockRun((args) => {
      assertEquals(args.at(-2), "--format");
      assertEquals(args.at(-1), "json");
      return {
        success: true,
        stdout: JSON.stringify({
          services: {
            db: { image: "postgres:16" },
            web: { image: "nginx:alpine" },
            broken: "not-an-object",
          },
        }),
        stderr: "",
        code: 0,
      };
    }),
  );

  assertEquals(model.serviceNames, ["db", "web"]);
  assertEquals(Object.keys(model.services).sort((a, b) => a.localeCompare(b)), [
    "db",
    "web",
  ]);
});

test("resolveComposeModel accepts missing services as empty", async () => {
  const model = await resolveComposeModel(
    "proj",
    ["/tmp/compose.yaml"],
    mockRun(() => ({
      success: true,
      stdout: JSON.stringify({ services: null }),
      stderr: "",
      code: 0,
    })),
  );
  assertEquals(model, { serviceNames: [], services: {} });
});

test("resolveComposeModel surfaces docker failures and invalid stdout", async () => {
  await assertRejects(
    () =>
      resolveComposeModel(
        "proj",
        ["/tmp/compose.yaml"],
        mockRun(() => ({
          success: false,
          stdout: "",
          stderr: "invalid compose",
          code: 1,
        })),
      ),
    Error,
    "invalid compose",
  );

  await assertRejects(
    () =>
      resolveComposeModel(
        "proj",
        ["/tmp/compose.yaml"],
        mockRun(() => ({
          success: true,
          stdout: "not-json",
          stderr: "",
          code: 0,
        })),
      ),
    Error,
    "unparseable stdout",
  );

  await assertRejects(
    () =>
      resolveComposeModel(
        "proj",
        ["/tmp/compose.yaml"],
        mockRun(() => ({
          success: true,
          stdout: JSON.stringify([]),
          stderr: "",
          code: 0,
        })),
      ),
    Error,
    "non-object model",
  );

  await assertRejects(
    () =>
      resolveComposeModel(
        "proj",
        ["/tmp/compose.yaml"],
        mockRun(() => ({
          success: true,
          stdout: JSON.stringify({ services: "bad" }),
          stderr: "",
          code: 0,
        })),
      ),
    Error,
    "services must be an object",
  );
});

test("validateComposeConfig delegates to docker compose config -q", async () => {
  let sawQuietConfig = false;
  await validateComposeConfig(
    "proj",
    ["/tmp/compose.yaml"],
    mockRun((args) => {
      sawQuietConfig = args.at(-1) === "-q" && args.includes("config");
      return { success: true, stdout: "", stderr: "", code: 0 };
    }),
  );
  if (!sawQuietConfig) {
    throw new TypeError("expected docker compose config -q invocation");
  }

  await assertRejects(
    () =>
      validateComposeConfig(
        "proj",
        ["/tmp/compose.yaml"],
        mockRun(() => ({
          success: false,
          stdout: "",
          stderr: "compose invalid",
          code: 1,
        })),
      ),
    Error,
    "compose invalid",
  );
});

test("validateComposeConfig falls back when stderr is empty", async () => {
  await assertRejects(
    () =>
      validateComposeConfig(
        "proj",
        ["/tmp/compose.yaml"],
        mockRun(() => ({
          success: false,
          stdout: "",
          stderr: "",
          code: 1,
        })),
      ),
    Error,
    "docker compose config -q failed",
  );
});
