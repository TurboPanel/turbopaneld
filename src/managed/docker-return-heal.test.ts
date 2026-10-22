import { assertEquals } from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import { healManagedStacksOnDockerReturn } from "./docker-return-heal.ts";

Deno.test("docker return heal: a failing ProxySQL repair does not stop the watcher check", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const layout = { configDir: dir, stateDir: dir } as unknown as LayoutPaths;
    let repairArgs: unknown;
    await healManagedStacksOnDockerReturn(layout, {
      runDocker: () =>
        Promise.resolve({ success: true, stdout: "", stderr: "" } as never),
      repairProxySql: (_l, deps) => {
        repairArgs = deps;
        return Promise.reject(new Error("boom"));
      },
    });
    assertEquals(
      (repairArgs as { ignoreReconcile: boolean }).ignoreReconcile,
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
