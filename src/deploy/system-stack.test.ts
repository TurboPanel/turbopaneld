import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "./docker-cli.ts";
import type { SystemComponentDescriptor } from "./system-component.ts";
import {
  inspectSystemStackContainer,
  systemStackComposePath,
} from "./system-stack.ts";
import { resolveLayout } from "../paths/layout.ts";
import { createTempLayout } from "../testing/temp-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DATABASE_DESCRIPTOR: SystemComponentDescriptor = {
  component: "database",
  serviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  composeServiceName: "database",
  containerName: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  role: "app",
};

async function withComposeFile<T>(
  layout: Parameters<typeof systemStackComposePath>[0],
  fn: () => Promise<T>,
): Promise<T> {
  const composePath = systemStackComposePath(layout);
  await Deno.mkdir(join(composePath, ".."), { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(composePath, "services: {}\n", { mode: 0o640 });
  return await fn();
}

function labelledRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    ID: "docker-id-1",
    Name: "database-1",
    Service: "database",
    State: "running",
    Labels: {
      "turbopanel.role": "app",
      "com.turbopanel.system.component": "database",
    },
    ...overrides,
  };
}

test("inspectSystemStackContainer maps a labelled row onto the descriptor's serviceId with role app", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const result = await withComposeFile(
      layout,
      () =>
        inspectSystemStackContainer(layout, DATABASE_DESCRIPTOR, {
          runDocker: (_args) =>
            Promise.resolve(
              {
                success: true,
                code: 0,
                stdout: JSON.stringify([labelledRow()]),
                stderr: "",
              } satisfies DockerCliResult,
            ),
        }),
    );

    assertEquals(result?.serviceId, DATABASE_DESCRIPTOR.serviceId);
    assertEquals(result?.role, "app");
    assertEquals(result?.containerId, "docker-id-1");
    assertEquals(result?.composeServiceName, "database");
  } finally {
    await fixture.cleanup();
  }
});

test("inspectSystemStackContainer ignores rows missing the platform labels", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const result = await withComposeFile(
      layout,
      () =>
        inspectSystemStackContainer(layout, DATABASE_DESCRIPTOR, {
          runDocker: (_args) =>
            Promise.resolve(
              {
                success: true,
                code: 0,
                stdout: JSON.stringify([labelledRow({ Labels: {} })]),
                stderr: "",
              } satisfies DockerCliResult,
            ),
        }),
    );

    assertEquals(result, null);
  } finally {
    await fixture.cleanup();
  }
});

test("inspectSystemStackContainer ignores a row whose label names another component", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const result = await withComposeFile(
      layout,
      () =>
        inspectSystemStackContainer(layout, DATABASE_DESCRIPTOR, {
          runDocker: (_args) =>
            Promise.resolve(
              {
                success: true,
                code: 0,
                stdout: JSON.stringify([
                  labelledRow({
                    Labels: {
                      "turbopanel.role": "app",
                      "com.turbopanel.system.component": "queue",
                    },
                  }),
                ]),
                stderr: "",
              } satisfies DockerCliResult,
            ),
        }),
    );

    assertEquals(result, null);
  } finally {
    await fixture.cleanup();
  }
});

test("inspectSystemStackContainer returns undefined when docker compose ps fails", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const result = await withComposeFile(
      layout,
      () =>
        inspectSystemStackContainer(layout, DATABASE_DESCRIPTOR, {
          runDocker: (_args) =>
            Promise.resolve(
              {
                success: false,
                code: 1,
                stdout: "",
                stderr: "docker: not running",
              } satisfies DockerCliResult,
            ),
        }),
    );

    assertEquals(result, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("inspectSystemStackContainer reports authoritative absence when the compose file is missing — never invokes docker", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    let runDockerCalls = 0;

    const result = await inspectSystemStackContainer(
      layout,
      DATABASE_DESCRIPTOR,
      {
        runDocker: (_args) => {
          runDockerCalls += 1;
          return Promise.resolve(
            {
              success: true,
              code: 0,
              stdout: "[]",
              stderr: "",
            } satisfies DockerCliResult,
          );
        },
      },
    );

    assertEquals(result, null);
    assertEquals(runDockerCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});
