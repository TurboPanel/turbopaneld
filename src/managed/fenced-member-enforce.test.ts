import { assertEquals } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { managedDir } from "./engine-paths.ts";
import {
  enforceFencedMemberIfRunning,
  isFencedMemberStillWritable,
} from "./fenced-member-enforce.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000099";

const COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:18",
  "    volumes:",
  "      - fence_data:/var/lib/postgresql",
  "volumes:",
  "  fence_data:",
  "    name: fence_data",
  "",
].join("\n");

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123",
    Name: "db-1",
    Service: "db",
    State: "running",
  },
]);

function docker(writablePrimary: boolean) {
  const run = (args: string[]): Promise<DockerCliResult> => {
    if (args[0] === "compose" && args.includes("ps")) {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: RUNNING_PS,
        stderr: "",
      });
    }
    if (args[0] === "exec") {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: writablePrimary ? "t\n" : "f\n",
        stderr: "",
      });
    }
    return Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
  };
  return run;
}

async function seedCompose(
  layout: ReturnType<typeof resolveLayout>,
): Promise<void> {
  const root = managedDir(layout, MANAGED_ID);
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(`${root}/docker-compose.yml`, COMPOSE);
}

test("isFencedMemberStillWritable follows the postgres probe", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await seedCompose(layout);
    assertEquals(
      await isFencedMemberStillWritable(
        layout,
        MANAGED_ID,
        "postgres",
        docker(true),
      ),
      true,
    );
    assertEquals(
      await isFencedMemberStillWritable(
        layout,
        MANAGED_ID,
        "postgres",
        docker(false),
      ),
      false,
    );
  });
});

test("isFencedMemberStillWritable fails open when the engine cannot be reached", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    assertEquals(
      await isFencedMemberStillWritable(
        layout,
        MANAGED_ID,
        "postgres",
        () =>
          Promise.resolve({
            success: true,
            code: 0,
            stdout: "[]",
            stderr: "",
          }),
      ),
      true,
    );
  });
});

test("enforceFencedMemberIfRunning continues when the volume fence cannot be read", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    let execCalls = 0;
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: RUNNING_PS,
          stderr: "",
        });
      }
      if (args[0] === "exec") execCalls++;
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "f\n",
        stderr: "",
      });
    };
    await enforceFencedMemberIfRunning(layout, MANAGED_ID, "postgres", run);
    assertEquals(execCalls > 0, true);
  });
});

test("enforceFencedMemberIfRunning is a no-op when the engine is down", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await seedCompose(layout);
    let execCalls = 0;
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "[]",
          stderr: "",
        });
      }
      if (args[0] === "exec") execCalls++;
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    };
    await enforceFencedMemberIfRunning(layout, MANAGED_ID, "postgres", run);
    assertEquals(execCalls, 0);
  });
});
