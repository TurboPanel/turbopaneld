import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "../deploy/compose-files.ts";
import { handleEnvironmentLifecycle } from "./lifecycle-environment.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";

const test = Deno.test.bind(Deno);

/**
 * Environments env-a and env-b of project proj-1 shared the old compose project
 * name `proj-1` on this host. Env-a has not been redeployed yet: its manifest
 * still records `proj-1`, but the control plane now sends `env-a` as the name.
 */
const OLD = "proj-1";
const ENV = "env-a";

async function withEarlierStack(
  withCompose: boolean,
  fn: (
    calls: string[][],
    run: (a: string[]) => Promise<DockerCliResult>,
  ) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "tp-earlier-" });
  const saved = [
    Deno.env.get("TURBOPANEL_STATE_DIR"),
    Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  ];
  Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  try {
    const dir = join(root, "state", "deployments", OLD, ENV);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    if (withCompose) {
      await writeComposeFileSecure(
        join(dir, RUNTIME_COMPOSE_FILENAME),
        "services:\n  web:\n    image: nginx\n",
      );
    }
    await writeDeploymentManifest(dir, {
      version: 2,
      projectId: OLD,
      environmentId: ENV,
      serverId: "srv",
      generation: 1,
      projectName: OLD,
      composeSha256: "a".repeat(64),
      services: { web: { replicas: 1 } },
    });
    const rows = [
      `own-1\t${ENV}\t${dir}`,
      `own-2\t\t${dir}`,
      "sib-1\tenv-b\t/state/deployments/proj-1/env-b",
    ].join("\n");
    const calls: string[][] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push([...args]);
      const stdout = args[0] === "ps" ? rows : "";
      return Promise.resolve({ success: true, stdout, stderr: "", code: 0 });
    };
    await fn(calls, run);
  } finally {
    for (
      const [i, key] of ["TURBOPANEL_STATE_DIR", "TURBOPANEL_CONFIG_DIR"]
        .entries()
    ) {
      if (saved[i] === undefined) Deno.env.delete(key);
      else Deno.env.set(key, saved[i]!);
    }
    await Deno.remove(root, { recursive: true });
  }
}

const touchesSibling = (calls: string[][]) =>
  calls.some((c) => c.includes("sib-1"));
const wholeProjectOnOld = (calls: string[][]) =>
  calls.some((c) => c[0] === "compose" && c[2] === OLD);

for (const withCompose of [true, false]) {
  test({
    name:
      `stop/teardown of an earlier-named environment removes only its own containers (compose files ${
        withCompose ? "present" : "missing"
      })`,
    permissions: { env: true, read: true, write: true, run: true },
    fn: () =>
      withEarlierStack(withCompose, async (calls, run) => {
        await handleEnvironmentStop(
          {
            environmentId: ENV,
            projectId: OLD,
            projectName: ENV,
          },
          new Date().toISOString(),
          { runDocker: run },
        );
        assertEquals(
          calls.some((c) => c.join(" ") === "rm -f own-1 own-2"),
          true,
        );
        assertEquals(touchesSibling(calls), false);
        assertEquals(wholeProjectOnOld(calls), false);
      }),
  });
}

for (const action of ["stop", "start", "restart"] as const) {
  test({
    name:
      `lifecycle ${action} of an earlier-named environment leaves a sibling alone`,
    permissions: { env: true, read: true, write: true, run: true },
    fn: () =>
      withEarlierStack(true, async (calls, run) => {
        await handleEnvironmentLifecycle(
          { environmentId: ENV, projectId: OLD, projectName: ENV, action },
          new Date().toISOString(),
          { runDocker: run },
        );
        assertEquals(
          calls.some((c) => c.join(" ") === `${action} own-1 own-2`),
          true,
        );
        assertEquals(touchesSibling(calls), false);
        assertEquals(wholeProjectOnOld(calls), false);
      }),
  });
}
