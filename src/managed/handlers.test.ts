import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { handleManagedDestroy } from "./destroy.ts";
import { removeManagedIngress } from "./ingress.ts";
import { handleManagedLifecycle } from "./lifecycle.ts";
import {
  managedComposeProject,
  managedIngressComposePath,
  managedIngressProject,
} from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function okDocker(): DockerCliResult {
  return { success: true, code: 0, stdout: "[]", stderr: "" };
}

test("handleManagedLifecycle is idempotent when state dir is missing", async () => {
  const managedId = `noop-life-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-life-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const result = await handleManagedLifecycle(
      { managedId, action: "stop" },
      new Date().toISOString(),
    );
    assertEquals(result.status, "stopped");
    assertEquals(result.summary?.includes("idempotent"), true);
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});

test("handleManagedDestroy is idempotent when state dir is missing", async () => {
  const managedId = `noop-destroy-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-destroy-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const result = await handleManagedDestroy(
      { managedId, removeVolumes: false },
      new Date().toISOString(),
    );
    assertEquals(result.status, "stopped");
    assertEquals(result.containers, []);
    assertEquals(result.summary?.includes("idempotent"), true);
    // Confirm nothing was created under managed/.
    try {
      await Deno.stat(join(tmp, "managed", managedId));
      throw new TypeError("managed dir should not exist");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});

test("handleManagedDestroy downs per-service ingress Traefik project", async () => {
  const managedId = `destroy-ingress-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-destroy-ingress-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const layout = resolveLayout(Deno.env.toObject(), {
      skipDiscovery: true,
      forceMode: "production",
    });
    const managedRoot = join(layout.stateDir, "managed", managedId);
    const ingressCompose = managedIngressComposePath(layout, managedId);
    await Deno.mkdir(join(managedRoot, "ingress"), { recursive: true });
    await Deno.writeTextFile(ingressCompose, "services: {}\n", { mode: 0o640 });

    const dockerCalls: string[][] = [];
    const result = await handleManagedDestroy(
      { managedId, removeVolumes: true },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          dockerCalls.push([...args]);
          return Promise.resolve(okDocker());
        },
      },
    );
    assertEquals(result.status, "stopped");
    assertEquals(result.containers, []);

    const engineProject = managedComposeProject(managedId);
    const ingressProject = managedIngressProject(managedId);
    assertEquals(
      dockerCalls.some((args) =>
        args.includes("-p") && args.includes(engineProject) &&
        args.includes("down") && args.includes("--volumes")
      ),
      true,
    );
    assertEquals(
      dockerCalls.some((args) =>
        args.includes("-p") && args.includes(ingressProject) &&
        args.includes("down")
      ),
      true,
    );

    try {
      await Deno.stat(ingressCompose);
      throw new TypeError("per-service ingress compose must be removed");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});

test("exposure-disable removeManagedIngress clears compose so lifecycle start skips ingress", async () => {
  const managedId = `exposure-off-${crypto.randomUUID()}`;
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-exposure-off-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    const layout = resolveLayout(Deno.env.toObject(), {
      skipDiscovery: true,
      forceMode: "production",
    });
    const managedRoot = join(layout.stateDir, "managed", managedId);
    const ingressCompose = managedIngressComposePath(layout, managedId);
    await Deno.mkdir(join(managedRoot, "ingress"), { recursive: true });
    await Deno.writeTextFile(ingressCompose, "services: {}\n", { mode: 0o640 });

    // Simulates prepareManagedIngressForApply when exposure.enabled=false.
    await removeManagedIngress(layout, managedId);

    try {
      await Deno.stat(ingressCompose);
      throw new TypeError(
        "ingress compose must be removed after exposure disable",
      );
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    const dockerCalls: string[][] = [];
    const result = await handleManagedLifecycle(
      { managedId, action: "start" },
      new Date().toISOString(),
      {
        runDocker: (args) => {
          dockerCalls.push([...args]);
          return Promise.resolve(okDocker());
        },
      },
    );
    assertEquals(result.status, "stopped");

    const engineProject = managedComposeProject(managedId);
    const ingressProject = managedIngressProject(managedId);
    assertEquals(
      dockerCalls.some((args) =>
        args.includes("-p") && args.includes(engineProject) &&
        args.includes("start")
      ),
      true,
    );
    assertEquals(
      dockerCalls.some((args) => args.includes(ingressProject)),
      false,
    );
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
    await Deno.remove(tmp, { recursive: true });
  }
});
